import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  computeArtifactDigest,
  computePackageTreeDigest,
  parseStrictJson,
  validatePackageDescriptor,
  validatePackagePaths,
  validatePackageTreeFiles,
} from "./package-format.ts";
import { validateReleasePackageDirectory } from "./package-directory.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const wasmFixture = join(repoRoot, "examples/third-party-module");

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function tempPackage(files: Record<string, string | Uint8Array>): { directory: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "cgp-package-v1-"));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(directory, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

const minimalManifest = JSON.stringify({
  moduleId: "org.example.package-test",
  name: "Package Test",
  version: "1.0.0",
  moduleApi: ">=1.0.0 <2.0.0",
  permissions: [],
});

const wasmDescriptor = JSON.stringify({
  formatVersion: 1,
  runtime: { kind: "wasm-core", entry: "module.wasm", abi: "cgp.abi/1" },
});

const jsDescriptor = JSON.stringify({
  formatVersion: 1,
  runtime: {
    kind: "javascript-esm",
    entry: "module.mjs",
    export: "implementation",
    executionTrust: "trusted-in-process",
  },
});

describe("CGP module package format v1", () => {
  it("accepts both closed runtime descriptor variants", () => {
    const wasm = validatePackageDescriptor(JSON.parse(wasmDescriptor));
    assert.equal(wasm.ok, true);
    if (wasm.ok) assert.equal(wasm.descriptor.runtime.kind, "wasm-core");

    const javascript = validatePackageDescriptor(JSON.parse(jsDescriptor));
    assert.equal(javascript.ok, true);
    if (javascript.ok) assert.equal(javascript.descriptor.runtime.kind, "javascript-esm");
  });

  it("rejects unknown fields, wrong runtime kinds, entrypoints, ABI, export, and trust", () => {
    const cases: unknown[] = [
      { formatVersion: 1, extra: true, runtime: { kind: "wasm-core", entry: "module.wasm", abi: "cgp.abi/1" } },
      { formatVersion: 1, runtime: { kind: "unknown", entry: "module.wasm", abi: "cgp.abi/1" } },
      { formatVersion: 1, runtime: { kind: "wasm-core", entry: "../module.wasm", abi: "cgp.abi/1" } },
      { formatVersion: 1, runtime: { kind: "wasm-core", entry: "module.wasm", abi: "cgp.abi/2" } },
      { formatVersion: 1, runtime: { kind: "javascript-esm", entry: "module.mjs", export: "default", executionTrust: "trusted-in-process" } },
      { formatVersion: 1, runtime: { kind: "javascript-esm", entry: "module.mjs", export: "implementation", executionTrust: "sandboxed" } },
      { formatVersion: 2, runtime: { kind: "wasm-core", entry: "module.wasm", abi: "cgp.abi/1" } },
      { formatVersion: 1.5, runtime: { kind: "wasm-core", entry: "module.wasm", abi: "cgp.abi/1" } },
      { formatVersion: 1, runtime: { kind: "wasm-core", entry: "module.wasm", abi: "cgp.abi/1", unused: true } },
      { formatVersion: 1, runtime: null },
    ];
    for (const item of cases) assert.equal(validatePackageDescriptor(item).ok, false);
  });

  it("rejects malformed UTF-8, a BOM, comments, trailing commas, and duplicate keys recursively", () => {
    assert.equal(parseStrictJson(Uint8Array.from([0xc3, 0x28]), "input").ok, false);
    assert.equal(parseStrictJson(Uint8Array.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), "input").ok, false);
    assert.equal(parseStrictJson(utf8("{/* comment */}"), "input").ok, false);
    assert.equal(parseStrictJson(utf8("{\"x\":1,}"), "input").ok, false);
    assert.equal(parseStrictJson(utf8("{\"outer\":{\"x\":1,\"x\":2}}"), "input").ok, false);
    assert.equal(parseStrictJson(utf8("{\"a\":1,\"\\u0061\":2}"), "input").ok, false);
  });

  it("parses prototype-sensitive keys as data without mutating object prototypes", () => {
    const parsed = parseStrictJson(utf8("{\"__proto__\":{\"polluted\":true}}"));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(Object.getPrototypeOf(parsed.value), Object.prototype);
    assert.equal(({} as { polluted?: boolean }).polluted, undefined);
    assert.equal(Object.hasOwn(parsed.value as object, "__proto__"), true);
  });

  it("rejects non-portable paths, reserved devices, package metadata, and authoring source", () => {
    const invalid = [
      "/root.txt",
      "../secret.txt",
      "dir/../secret.txt",
      "dir\\file.txt",
      "C:/secret.txt",
      "dir//file.txt",
      "dir/./file.txt",
      "bad name.txt",
      "café.txt",
      "name.",
      "CON",
      "nul.txt",
      "COM1.log",
      "Lpt9",
      "nested/node_modules/file.js",
      "package.json",
      "nested/package.json",
      "module.ts",
      "nested/module.ts",
    ];
    for (const path of invalid) assert.ok(validatePackagePaths([path]).length > 0, path);
  });

  it("rejects case-fold collisions and file/directory prefix collisions", () => {
    assert.ok(validatePackagePaths(["README.md", "readme.md"]).length > 0);
    assert.ok(validatePackagePaths(["Assets/a.txt", "assets/b.txt"]).some((item) => item.includes("case collision")));
    assert.ok(validatePackagePaths(["docs", "docs/readme.md"]).some((item) => item.includes("parent directory")));
  });

  it("matches the standard raw artifact SHA-256 vector", () => {
    assert.equal(
      computeArtifactDigest(utf8("abc")),
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches the published empty, single-file, and multiple-file package-tree vectors", () => {
    assert.equal(
      computePackageTreeDigest([]),
      "sha256:7ea53c3abc96c548d50e85c48865f6f477003320bfd6301a945d9f8a6c553f6c",
    );
    assert.equal(
      computePackageTreeDigest([{ path: "README.md", bytes: utf8("hello\n") }]),
      "sha256:ba06a8339ceb454ab29e39f4637ee28a22efec98397a27a5544d1d4dbfde40da",
    );
    assert.equal(
      computePackageTreeDigest([
        { path: "manifest.json", bytes: utf8("{\"moduleId\":\"org.example.demo\"}\n") },
        { path: "README.md", bytes: utf8("hello\n") },
      ]),
      "sha256:ccb426b9b7f93cdecb322b60724267b74b41e3bbdfa5b8882127b2a94b59445f",
    );
  });

  it("is independent of enumeration order and changes for path or file-content changes", () => {
    const first = [
      { path: "z.txt", bytes: utf8("z") },
      { path: "a.txt", bytes: utf8("a") },
    ];
    const reordered = [...first].reverse();
    const baseline = computePackageTreeDigest(first);
    assert.equal(baseline, computePackageTreeDigest(reordered));
    assert.equal(
      baseline,
      "sha256:7e6492b3a96c5ba21d8448eecc66e74a2f825a777e0510010a65a357c7dbe22d",
    );
    assert.notEqual(baseline, computePackageTreeDigest([...first, { path: "docs.txt", bytes: utf8("notes") }]));
    assert.notEqual(baseline, computePackageTreeDigest([{ path: "z.txt", bytes: utf8("changed") }, first[1]!]));
  });

  it("changes the package-tree digest for documentation while preserving the artifact digest", () => {
    const artifact = utf8("export const implementation = {};\n");
    const artifactDigestBefore = computeArtifactDigest(artifact);
    const before = computePackageTreeDigest([
      { path: "module.mjs", bytes: artifact },
      { path: "README.md", bytes: utf8("before\n") },
    ]);
    const after = computePackageTreeDigest([
      { path: "module.mjs", bytes: artifact },
      { path: "README.md", bytes: utf8("after\n") },
    ]);
    const artifactDigestAfter = computeArtifactDigest(artifact);
    assert.notEqual(before, after);
    assert.equal(artifactDigestBefore, artifactDigestAfter);
  });

  it("refuses invalid path sets and non-byte file bodies before hashing", () => {
    assert.equal(validatePackageTreeFiles([
      { path: "../escape", bytes: utf8("x") },
    ]).ok, false);
    assert.equal(validatePackageTreeFiles([
      { path: "ok.txt", bytes: "not bytes" as unknown as Uint8Array },
    ]).ok, false);
  });

  it("validates the existing third-party Wasm fixture without instantiating it", async () => {
    const fixture = {
      "manifest.json": readFileSync(join(wasmFixture, "manifest.json")),
      "cgp-package.json": wasmDescriptor,
      "module.wasm": readFileSync(join(wasmFixture, "module.wasm")),
      "README.md": "portable fixture\n",
    };
    const temp = tempPackage(fixture);
    try {
      const result = await validateReleasePackageDirectory(temp.directory);
      assert.equal(result.ok, true, result.ok ? "" : result.errors.join("\n"));
      if (result.ok) {
        assert.equal(result.package.descriptor.runtime.kind, "wasm-core");
        assert.equal(result.package.moduleId, "org.example.beacon");
        assert.match(result.package.packageTreeDigest, /^sha256:[0-9a-f]{64}$/);
        assert.match(result.package.artifactDigest, /^sha256:[0-9a-f]{64}$/);
      }
    } finally {
      temp.cleanup();
    }
  });

  it("validates JavaScript ESM statically and never executes its top-level code", async () => {
    delete (globalThis as { __cgpPackageWasExecuted?: boolean }).__cgpPackageWasExecuted;
    const temp = tempPackage({
      "manifest.json": minimalManifest,
      "cgp-package.json": jsDescriptor,
      "module.mjs": "globalThis.__cgpPackageWasExecuted = true; export const implementation = Object.freeze({});\n",
    });
    try {
      const result = await validateReleasePackageDirectory(temp.directory);
      assert.equal(result.ok, true, result.ok ? "" : result.errors.join("\n"));
      assert.equal((globalThis as { __cgpPackageWasExecuted?: boolean }).__cgpPackageWasExecuted, undefined);
    } finally {
      temp.cleanup();
      delete (globalThis as { __cgpPackageWasExecuted?: boolean }).__cgpPackageWasExecuted;
    }
  });

  it("rejects relative, third-party, and dynamic JavaScript imports", async () => {
    const cases = [
      'import "./helper.mjs"; export const implementation = {};',
      'import "some-package"; export const implementation = {};',
      'export const result = import("node:fs"); export const implementation = {};',
      'const fs = require("node:fs"); export const implementation = {};',
      'import "node:not-a-real-builtin"; export const implementation = {};',
      'export const other = {};',
    ];
    for (const source of cases) {
      const temp = tempPackage({
        "manifest.json": minimalManifest,
        "cgp-package.json": jsDescriptor,
        "module.mjs": source,
      });
      try {
        const result = await validateReleasePackageDirectory(temp.directory);
        assert.equal(result.ok, false, source);
        if (!result.ok) assert.ok(result.errors.length > 0);
      } finally {
        temp.cleanup();
      }
    }
  });

  it("permits static node: imports but rejects package.json, node_modules, and module.ts", async () => {
    const valid = tempPackage({
      "manifest.json": minimalManifest,
      "cgp-package.json": jsDescriptor,
      "module.mjs": 'import { readFile } from "node:fs"; export const implementation = { readFile };\n',
    });
    try {
      const result = await validateReleasePackageDirectory(valid.directory);
      assert.equal(result.ok, true, result.ok ? "" : result.errors.join("\n"));
    } finally {
      valid.cleanup();
    }

    for (const extra of [
      { path: "package.json", content: "{}" },
      { path: "module.ts", content: "export {};" },
      { path: "node_modules/empty.txt", content: "no" },
    ]) {
      const temp = tempPackage({
        "manifest.json": minimalManifest,
        "cgp-package.json": jsDescriptor,
        "module.mjs": "export const implementation = {};\n",
      });
      try {
        if (extra.path === "node_modules/empty.txt") {
          const directory = join(temp.directory, "node_modules");
          mkdirSync(directory);
          writeFileSync(join(directory, "empty.txt"), extra.content);
        } else {
          writeFileSync(join(temp.directory, extra.path), extra.content);
        }
        const result = await validateReleasePackageDirectory(temp.directory);
        assert.equal(result.ok, false, extra.path);
      } finally {
        temp.cleanup();
      }
    }
  });

  it("rejects symbolic links and special filesystem entries", async () => {
    const target = tempPackage({
      "manifest.json": minimalManifest,
      "cgp-package.json": jsDescriptor,
      "module.mjs": "export const implementation = {};\n",
    });
    const linked = tempPackage({});
    try {
      symlinkSync(join(target.directory, "module.mjs"), join(linked.directory, "linked.mjs"));
      const result = await validateReleasePackageDirectory(linked.directory);
      assert.equal(result.ok, false);
      if (!result.ok) assert.ok(result.errors.some((item) => item.includes("symbolic link")));
    } finally {
      target.cleanup();
      linked.cleanup();
    }
  });

  it("refuses both executable entrypoints in the same release", async () => {
    const temp = tempPackage({
      "manifest.json": minimalManifest,
      "cgp-package.json": jsDescriptor,
      "module.mjs": "export const implementation = {};\n",
      "module.wasm": readFileSync(join(wasmFixture, "module.wasm")),
    });
    try {
      const result = await validateReleasePackageDirectory(temp.directory);
      assert.equal(result.ok, false);
      if (!result.ok) assert.ok(result.errors.some((item) => item.includes("must not also contain module.wasm")));
    } finally {
      temp.cleanup();
    }
  });
});
