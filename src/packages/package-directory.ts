import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { inspectWasm } from "../foundations/wasm-backend.ts";
import { validateManifest, type ModuleManifest } from "../foundations/manifest.ts";
import {
  computeArtifactDigest,
  computePackageTreeDigest,
  parseStrictJson,
  validatePackageDescriptor,
  validatePackagePaths,
  type ModulePackageDescriptor,
  type PackageFile,
} from "./package-format.ts";

export type ReleasePackageSummary = {
  moduleId: string;
  version: string;
  descriptor: ModulePackageDescriptor;
  packageTreeProfile: "cgp.package-tree/1";
  packageTreeDigest: string;
  artifactDigest: string;
  files: string[];
};

export type ReleasePackageValidation =
  | { ok: true; package: ReleasePackageSummary; manifest: ModuleManifest }
  | { ok: false; errors: string[] };

type ScanResult = {
  files: PackageFile[];
  errors: string[];
};

function scanDirectory(root: string): ScanResult {
  const files: PackageFile[] = [];
  const errors: string[] = [];
  let rootInfo;
  try {
    rootInfo = lstatSync(root);
  } catch {
    return { files, errors: ["Package directory does not exist or cannot be inspected."] };
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    return { files, errors: ["Package root must be a real directory, not a symlink or file."] };
  }

  function visit(directory: string, prefix: string): void {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => (
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      ));
    } catch {
      errors.push("Cannot read package directory \"" + (prefix || ".") + "\".");
      return;
    }

    for (const entry of entries) {
      const path = prefix ? prefix + "/" + entry.name : entry.name;
      const absolute = join(directory, entry.name);
      let info;
      try {
        info = lstatSync(absolute);
      } catch {
        errors.push("Cannot inspect package entry \"" + path + "\".");
        continue;
      }
      if (info.isSymbolicLink()) {
        errors.push("Package entry \"" + path + "\" is a symbolic link.");
        continue;
      }
      if (info.isDirectory()) {
        if (entry.name.toLowerCase() === "node_modules") {
          errors.push("Package contains a forbidden node_modules directory at \"" + path + "\".");
          continue;
        }
        visit(absolute, path);
        continue;
      }
      if (!info.isFile()) {
        errors.push("Package entry \"" + path + "\" is not a regular file.");
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = readFileSync(absolute);
        const afterRead = lstatSync(absolute);
        if (afterRead.isSymbolicLink() || !afterRead.isFile() ||
            afterRead.dev !== info.dev || afterRead.ino !== info.ino ||
            afterRead.size !== info.size || afterRead.mtimeMs !== info.mtimeMs ||
            bytes.byteLength !== info.size) {
          errors.push("Package file changed while it was being read: " + path);
          continue;
        }
      } catch {
        errors.push("Cannot read package file \"" + path + "\".");
        continue;
      }
      files.push({ path, bytes: new Uint8Array(bytes) });
    }
  }

  visit(resolve(root), "");
  return { files, errors };
}

function validateWasm(bytes: Uint8Array, permissions: readonly string[]): string[] {
  const errors: string[] = [];
  let module: WebAssembly.Module;
  let inspected: ReturnType<typeof inspectWasm>;
  try {
    module = new WebAssembly.Module(bytes);
    inspected = inspectWasm(bytes);
  } catch (error) {
    return [error instanceof Error ? error.message : "module.wasm is not a valid WebAssembly Core module."];
  }

  const exports = WebAssembly.Module.exports(module);
  const requiredExports = new Map<string, "function" | "memory">([
    ["memory", "memory"],
    ["cg_alloc", "function"],
    ["cg_hook", "function"],
    ["cg_out_ptr", "function"],
    ["cg_out_len", "function"],
  ]);
  for (const [name, kind] of requiredExports) {
    const found = exports.find((item) => item.name === name);
    if (!found) errors.push("module.wasm does not export the ABI member \"" + name + "\".");
    else if (found.kind !== kind) errors.push("module.wasm ABI export \"" + name + "\" must be a " + kind + ".");
  }

  for (const item of inspected.imports) {
    if (item.module !== "cgp.abi" || item.name !== "log" || item.kind !== "func") {
      errors.push("module.wasm has unauthorized import " + item.module + "." + item.name + ".");
    } else if (!permissions.includes("cgp.log")) {
      errors.push("module.wasm imports cgp.abi.log but manifest.json does not declare cgp.log.");
    }
  }

  if ("missing" in inspected.memory) errors.push("module.wasm must define and export one bounded memory.");
  else if ("imported" in inspected.memory) errors.push("module.wasm must not import memory.");
  else if ("shared" in inspected.memory) errors.push("module.wasm must not use shared memory.");
  else if ("memory64" in inspected.memory) errors.push("module.wasm must not use memory64.");
  else if ("count" in inspected.memory) errors.push("module.wasm must declare exactly one memory.");
  else if (inspected.memory.max === null) errors.push("module.wasm memory must declare a maximum.");

  if (inspected.tables.length > 1) errors.push("module.wasm must declare at most one table.");
  const table = inspected.tables[0];
  if (table && "count" in table) errors.push("module.wasm must declare at most one table.");
  else if (table && "shared" in table && table.shared) errors.push("module.wasm must not use a shared table.");
  else if (table && "max" in table && table.max === null) errors.push("module.wasm table must declare a maximum.");
  else if (table && "max" in table && table.max !== null && table.max > 256) {
    errors.push("module.wasm table maximum must not exceed 256 entries.");
  }
  return errors;
}

async function validateJavaScriptEntry(path: string): Promise<string[]> {
  try {
    const result = await build({
      entryPoints: [path],
      absWorkingDir: resolve(path, ".."),
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      logLevel: "silent",
      metafile: true,
      plugins: [{
        name: "cgp-v1-static-import-policy",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === "entry-point") return undefined;
            if (args.kind === "import-statement" && args.path.startsWith("node:") && isBuiltin(args.path)) {
              return { path: args.path, external: true };
            }
            return {
              errors: [{
                text: "CGP format v1 permits only static imports with node: specifiers; refused " +
                  args.kind + " for \"" + args.path + "\".",
              }],
            };
          });
        },
      }],
    });
    const entryOutput = Object.values(result.metafile?.outputs ?? {}).find((item) => item.entryPoint !== undefined);
    if (!entryOutput?.exports.includes("implementation")) {
      return ["module.mjs must provide the named export implementation."];
    }
    return [];
  } catch (error) {
    if (error && typeof error === "object" && "errors" in error && Array.isArray(error.errors)) {
      return error.errors.map((item: { text?: string }) => item.text ?? "JavaScript entrypoint failed static validation.");
    }
    return [error instanceof Error ? error.message : "JavaScript entrypoint failed static validation."];
  }
}

/**
 * Validates a released package directory without importing JavaScript or instantiating WebAssembly.
 * This is package tooling, deliberately separate from the Foundations composition/runtime path.
 */
export async function validateReleasePackageDirectory(directory: string): Promise<ReleasePackageValidation> {
  const scanned = scanDirectory(directory);
  const errors = [...scanned.errors];
  if (errors.length > 0) return { ok: false, errors };

  const treeCheck = validatePackagePaths(scanned.files.map((item) => item.path));
  errors.push(...treeCheck);
  if (errors.length > 0) return { ok: false, errors };

  const byPath = new Map(scanned.files.map((item) => [item.path, item]));
  const manifestFile = byPath.get("manifest.json");
  const descriptorFile = byPath.get("cgp-package.json");
  if (!manifestFile) errors.push("manifest.json is missing.");
  if (!descriptorFile) errors.push("cgp-package.json is missing.");
  if (!manifestFile || !descriptorFile) return { ok: false, errors };

  const parsedManifest = parseStrictJson(manifestFile.bytes, "manifest.json");
  if (!parsedManifest.ok) errors.push(parsedManifest.error);
  const parsedDescriptor = parseStrictJson(descriptorFile.bytes, "cgp-package.json");
  if (!parsedDescriptor.ok) errors.push(parsedDescriptor.error);
  if (!parsedManifest.ok || !parsedDescriptor.ok) return { ok: false, errors };

  const manifestCheck = validateManifest(parsedManifest.value);
  if (!manifestCheck.ok) errors.push(...manifestCheck.errors.map((item) => item.message));
  const descriptorCheck = validatePackageDescriptor(parsedDescriptor.value);
  if (!descriptorCheck.ok) errors.push(...descriptorCheck.errors);
  if (!manifestCheck.ok || !descriptorCheck.ok) return { ok: false, errors };

  const wasmFile = byPath.get("module.wasm");
  const jsFile = byPath.get("module.mjs");
  if (descriptorCheck.descriptor.runtime.kind === "wasm-core") {
    if (!wasmFile) errors.push("module.wasm is missing for the wasm-core package.");
    if (jsFile) errors.push("A wasm-core package must not also contain module.mjs.");
    if (wasmFile) errors.push(...validateWasm(wasmFile.bytes, manifestCheck.manifest.permissions));
  } else {
    if (!jsFile) errors.push("module.mjs is missing for the javascript-esm package.");
    if (wasmFile) errors.push("A javascript-esm package must not also contain module.wasm.");
    if (jsFile) {
      errors.push(...await validateJavaScriptEntry(join(resolve(directory), "module.mjs")));
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const files = scanned.files;
  const packageTreeDigest = computePackageTreeDigest(files);
  const runtimePath = descriptorCheck.descriptor.runtime.entry;
  const artifact = byPath.get(runtimePath);
  if (!artifact) return { ok: false, errors: ["Selected runtime artifact is missing."] };

  return {
    ok: true,
    manifest: manifestCheck.manifest,
    package: {
      moduleId: manifestCheck.manifest.moduleId,
      version: manifestCheck.manifest.version,
      descriptor: descriptorCheck.descriptor,
      packageTreeProfile: "cgp.package-tree/1",
      packageTreeDigest,
      artifactDigest: computeArtifactDigest(artifact.bytes),
      files: [...files].map((item) => item.path).sort(),
    },
  };
}

