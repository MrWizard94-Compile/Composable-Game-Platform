import { createHash } from "node:crypto";

export const PACKAGE_FORMAT_VERSION = 1 as const;
export const PACKAGE_PATH_PROFILE = "cgp.package-path/1" as const;
export const PACKAGE_TREE_PROFILE = "cgp.package-tree/1" as const;

export type WasmCorePackageDescriptor = {
  formatVersion: 1;
  runtime: {
    kind: "wasm-core";
    entry: "module.wasm";
    abi: "cgp.abi/1";
  };
};

export type JavaScriptEsmPackageDescriptor = {
  formatVersion: 1;
  runtime: {
    kind: "javascript-esm";
    entry: "module.mjs";
    export: "implementation";
    executionTrust: "trusted-in-process";
  };
};

export type ModulePackageDescriptor =
  | WasmCorePackageDescriptor
  | JavaScriptEsmPackageDescriptor;

export type DescriptorValidation =
  | { ok: true; descriptor: ModulePackageDescriptor }
  | { ok: false; errors: string[] };

export type StrictJsonParse =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export type PackageFile = {
  path: string;
  bytes: Uint8Array;
};

export type PackageTreeValidation =
  | { ok: true; digest: string; files: PackageFile[] }
  | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, errors: string[]) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) errors.push(path + " contains unknown field \"" + key + "\".");
  }
}

export function validatePackageDescriptor(input: unknown): DescriptorValidation {
  const errors: string[] = [];
  if (!isRecord(input)) {
    return { ok: false, errors: ["cgp-package.json must be a JSON object."] };
  }

  hasOnlyKeys(input, ["formatVersion", "runtime"], "cgp-package.json", errors);
  if (input.formatVersion !== PACKAGE_FORMAT_VERSION || !Number.isInteger(input.formatVersion)) {
    errors.push("cgp-package.json formatVersion must be the integer 1.");
  }
  if (!isRecord(input.runtime)) {
    errors.push("cgp-package.json runtime must be an object.");
    return { ok: false, errors };
  }

  const runtime = input.runtime;
  if (runtime.kind === "wasm-core") {
    hasOnlyKeys(runtime, ["kind", "entry", "abi"], "cgp-package.json runtime", errors);
    if (runtime.entry !== "module.wasm") {
      errors.push("wasm-core runtime entry must be exactly module.wasm.");
    }
    if (runtime.abi !== "cgp.abi/1") {
      errors.push("wasm-core runtime abi must be exactly cgp.abi/1.");
    }
    if (errors.length > 0) return { ok: false, errors };
    return {
      ok: true,
      descriptor: {
        formatVersion: 1,
        runtime: { kind: "wasm-core", entry: "module.wasm", abi: "cgp.abi/1" },
      },
    };
  }

  if (runtime.kind === "javascript-esm") {
    hasOnlyKeys(
      runtime,
      ["kind", "entry", "export", "executionTrust"],
      "cgp-package.json runtime",
      errors,
    );
    if (runtime.entry !== "module.mjs") {
      errors.push("javascript-esm runtime entry must be exactly module.mjs.");
    }
    if (runtime.export !== "implementation") {
      errors.push("javascript-esm runtime export must be exactly implementation.");
    }
    if (runtime.executionTrust !== "trusted-in-process") {
      errors.push("javascript-esm runtime executionTrust must be exactly trusted-in-process.");
    }
    if (errors.length > 0) return { ok: false, errors };
    return {
      ok: true,
      descriptor: {
        formatVersion: 1,
        runtime: {
          kind: "javascript-esm",
          entry: "module.mjs",
          export: "implementation",
          executionTrust: "trusted-in-process",
        },
      },
    };
  }

  errors.push("cgp-package.json runtime kind must be wasm-core or javascript-esm.");
  return { ok: false, errors };
}

class StrictJsonParser {
  private index = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  parse(): unknown {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.source.length) this.fail("Unexpected data after the JSON value.");
    return value;
  }

  private fail(message: string): never {
    throw new Error(message + " At character " + this.index + ".");
  }

  private skipWhitespace(): void {
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (char === " " || char === "\t" || char === "\n" || char === "\r") {
        this.index += 1;
      } else {
        break;
      }
    }
  }

  private parseValue(): unknown {
    this.skipWhitespace();
    const char = this.source[this.index];
    if (char === "{") return this.parseObject();
    if (char === "[") return this.parseArray();
    if (char === "\"") return this.parseString();
    if (char === "t" && this.source.slice(this.index, this.index + 4) === "true") {
      this.index += 4;
      return true;
    }
    if (char === "f" && this.source.slice(this.index, this.index + 5) === "false") {
      this.index += 5;
      return false;
    }
    if (char === "n" && this.source.slice(this.index, this.index + 4) === "null") {
      this.index += 4;
      return null;
    }
    return this.parseNumber();
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    let closed = false;
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (char === "\\") {
        this.index += 2;
      } else if (char === "\"") {
        this.index += 1;
        closed = true;
        break;
      } else {
        this.index += 1;
      }
    }
    if (!closed) this.fail("Unterminated JSON string.");
    const encoded = this.source.slice(start, this.index);
    try {
      return JSON.parse(encoded) as string;
    } catch {
      this.fail("Invalid JSON string escape or control character.");
    }
  }

  private parseNumber(): number {
    const rest = this.source.slice(this.index);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(rest);
    if (!match) this.fail("Expected a JSON value.");
    const token = match[0];
    this.index += token.length;
    const value = Number(token);
    if (!Number.isFinite(value)) this.fail("JSON number is outside the finite JavaScript number range.");
    return value;
  }

  private parseArray(): unknown[] {
    this.index += 1;
    this.skipWhitespace();
    const result: unknown[] = [];
    if (this.source[this.index] === "]") {
      this.index += 1;
      return result;
    }
    for (;;) {
      result.push(this.parseValue());
      this.skipWhitespace();
      const char = this.source[this.index];
      if (char === "]") {
        this.index += 1;
        return result;
      }
      if (char !== ",") this.fail("Expected a comma or closing bracket in JSON array.");
      this.index += 1;
      this.skipWhitespace();
    }
  }

  private parseObject(): Record<string, unknown> {
    this.index += 1;
    this.skipWhitespace();
    const result: Record<string, unknown> = {};
    const keys = new Set<string>();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return result;
    }
    for (;;) {
      if (this.source[this.index] !== "\"") this.fail("JSON object property names must be strings.");
      const key = this.parseString();
      if (keys.has(key)) this.fail("Duplicate JSON object property \"" + key + "\".");
      keys.add(key);
      this.skipWhitespace();
      if (this.source[this.index] !== ":") this.fail("Expected a colon after a JSON object property name.");
      this.index += 1;
      const value = this.parseValue();
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      this.skipWhitespace();
      const char = this.source[this.index];
      if (char === "}") {
        this.index += 1;
        return result;
      }
      if (char !== ",") this.fail("Expected a comma or closing brace in JSON object.");
      this.index += 1;
      this.skipWhitespace();
    }
  }
}

/** Strict UTF-8 JSON parser that rejects BOMs and duplicate object keys at every depth. */
export function parseStrictJson(bytes: Uint8Array, label = "JSON document"): StrictJsonParse {
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { ok: false, error: label + " must not contain a UTF-8 BOM." };
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, error: label + " is not valid UTF-8." };
  }
  try {
    return { ok: true, value: new StrictJsonParser(source).parse() };
  } catch (error) {
    return {
      ok: false,
      error: label + " is not strict JSON: " + (error instanceof Error ? error.message : "invalid JSON."),
    };
  }
}

const PATH_COMPONENT = /^[A-Za-z0-9._-]+$/;
const WINDOWS_DEVICE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

export function validatePackagePaths(paths: readonly string[]): string[] {
  const errors: string[] = [];
  const exact = new Set<string>();
  const folded = new Set<string>();
  const componentSpellings = new Map<string, string>();

  for (const path of paths) {
    if (typeof path !== "string" || path.length === 0) {
      errors.push("Package paths must be non-empty strings.");
      continue;
    }
    if (path.startsWith("/") || path.includes("\\") || path.includes(":")) {
      errors.push("Package path \"" + path + "\" must be relative and use forward slashes only.");
      continue;
    }
    const components = path.split("/");
    if (components.some((part) => part.length === 0 || part === "." || part === "..")) {
      errors.push("Package path \"" + path + "\" contains an empty, dot, or parent component.");
      continue;
    }
    if (components.some((part) => !PATH_COMPONENT.test(part) || part.endsWith("."))) {
      errors.push("Package path \"" + path + "\" contains a non-portable component.");
      continue;
    }
    if (components.some((part) => WINDOWS_DEVICE.test(part))) {
      errors.push("Package path \"" + path + "\" contains a reserved Windows device name.");
      continue;
    }
    if (components.some((part) => part.toLowerCase() === "node_modules")) {
      errors.push("Package path \"" + path + "\" contains a forbidden node_modules directory.");
      continue;
    }
    const basename = components[components.length - 1]?.toLowerCase();
    if (basename === "package.json") {
      errors.push("Package path \"" + path + "\" contains a forbidden package.json file.");
      continue;
    }
    if (basename === "module.ts") {
      errors.push("Package path \"" + path + "\" contains forbidden authoring source module.ts.");
      continue;
    }
    const key = path.toLowerCase();
    if (exact.has(path) || folded.has(key)) {
      errors.push("Package path \"" + path + "\" collides with another path.");
      continue;
    }
    let prefix = "";
    let componentCollision = false;
    for (const part of components) {
      prefix = prefix ? prefix + "/" + part : part;
      const foldedPrefix = prefix.toLowerCase();
      const previousSpelling = componentSpellings.get(foldedPrefix);
      if (previousSpelling !== undefined && previousSpelling !== prefix) {
        errors.push("Package path \"" + path + "\" has a directory or component case collision with \"" + previousSpelling + "\".");
        componentCollision = true;
        break;
      }
      componentSpellings.set(foldedPrefix, prefix);
    }
    if (componentCollision) continue;
    exact.add(path);
    folded.add(key);
  }

  for (const path of exact) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      const parent = parts.slice(0, i).join("/");
      if (exact.has(parent)) {
        errors.push("Package path \"" + parent + "\" is both a file and a parent directory.");
      }
    }
  }
  return errors;
}

function encodeU64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Package record lengths must be non-negative safe integers.");
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
}

function hex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

export function computeArtifactDigest(bytes: Uint8Array): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

export function validatePackageTreeFiles(files: readonly PackageFile[]): PackageTreeValidation {
  const errors = validatePackagePaths(files.map((item) => item.path));
  for (const item of files) {
    if (!(item.bytes instanceof Uint8Array)) {
      errors.push("Package file \"" + item.path + "\" must contain raw bytes.");
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash("sha256");
  hash.update(new TextEncoder().encode("CGP-PACKAGE-TREE\0v1"));
  hash.update(encodeU64(sorted.length));
  for (const item of sorted) {
    const pathBytes = new TextEncoder().encode(item.path);
    const contentDigest = createHash("sha256").update(item.bytes).digest();
    hash.update(encodeU64(pathBytes.byteLength));
    hash.update(pathBytes);
    hash.update(encodeU64(item.bytes.byteLength));
    hash.update(contentDigest);
  }
  return {
    ok: true,
    digest: "sha256:" + hash.digest("hex"),
    files: sorted,
  };
}

/** Computes the canonical v1 tree digest or throws when a path/tree is invalid. */
export function computePackageTreeDigest(files: readonly PackageFile[]): string {
  const checked = validatePackageTreeFiles(files);
  if (!checked.ok) throw new Error(checked.errors.join("\n"));
  return checked.digest;
}

export function packageTreeDigestFromHex(hexDigest: string): string {
  if (!/^[0-9a-f]{64}$/.test(hexDigest)) {
    throw new Error("A SHA-256 digest must be 64 lowercase hexadecimal characters.");
  }
  return "sha256:" + hexDigest;
}
