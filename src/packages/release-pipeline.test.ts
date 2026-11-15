import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildReleasePackage } from "./release-pipeline.ts";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));

function makeWritable(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) makeWritable(path);
    try { chmodSync(path, entry.isDirectory() ? 0o755 : 0o644); } catch {}
  }
  try { chmodSync(directory, 0o755); } catch {}
}

function fixture(t: { after(callback: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), "cgp-release-test-"));
  t.after(() => {
    makeWritable(root);
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("JavaScript authoring project builds a clean release and immutable validated snapshot", async (t) => {
  const root = fixture(t);
  const source = join(repositoryRoot, "examples/starter-module");
  const release = join(root, "release");
  const staging = join(root, "staging");
  const result = await buildReleasePackage({
    sourceDirectory: source,
    releaseDirectory: release,
    stagingDirectory: staging,
  });

  assert.equal(result.summary.schema, "cgp.release-summary/1");
  assert.equal(result.summary.moduleId, "org.example.starter");
  assert.equal(result.summary.version, "1.0.0");
  assert.equal(result.summary.runtime, "javascript-esm");
  assert.equal(result.summary.resourceLimits.maxFiles, 4096);
  assert.equal(result.summary.resourceLimits.maxFileBytes, 64 * 1024 * 1024);
  assert.match(result.summary.packageTreeDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(result.summary.artifactDigest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(result.summary.files, ["cgp-package.json", "manifest.json", "module.mjs"]);
  assert.equal(JSON.parse(readFileSync(result.summaryPath, "utf8")).packageTreeDigest,
    result.summary.packageTreeDigest);
  assert.equal(lstatSync(join(staging, "module.mjs")).isFile(), true);
  assert.equal(lstatSync(join(staging, "module.mjs")).mode & 0o222, 0);
  assert.equal(lstatSync(staging).mode & 0o222, 0);
  assert.equal(readFileSync(join(release, "manifest.json"), "utf8"),
    readFileSync(join(source, "manifest.json"), "utf8"));
  assert.match(readFileSync(join(release, "module.mjs"), "utf8"), /implementation/);

  await assert.rejects(
    buildReleasePackage({ sourceDirectory: source, releaseDirectory: release, stagingDirectory: staging }),
    /already exists/,
  );
});

test("WebAssembly authoring project is staged without executing the guest", async (t) => {
  const root = fixture(t);
  const source = join(repositoryRoot, "examples/third-party-module");
  const result = await buildReleasePackage({
    sourceDirectory: source,
    releaseDirectory: join(root, "release"),
    stagingDirectory: join(root, "staging"),
  });

  assert.equal(result.summary.runtime, "wasm-core");
  assert.ok(result.summary.files.includes("module.wasm"));
  assert.ok(result.summary.files.includes("manifest.json"));
  assert.ok(result.summary.files.includes("cgp-package.json"));
  assert.equal(result.summary.files.includes("guest.json"), false);
  assert.match(result.summary.packageTreeDigest, /^sha256:[0-9a-f]{64}$/);
});

test("unsafe include paths and resource-limit violations are refused", async (t) => {
  const root = fixture(t);
  const source = join(repositoryRoot, "examples/starter-module");
  await assert.rejects(
    buildReleasePackage({
      sourceDirectory: source,
      releaseDirectory: join(root, "release"),
      stagingDirectory: join(root, "staging"),
      include: ["../outside"],
    }),
    /relative paths|parent component/,
  );

  const oversizedPathSource = join(root, "long-path-source");
  mkdirSync(oversizedPathSource);
  writeFileSync(join(oversizedPathSource, "manifest.json"),
    readFileSync(join(source, "manifest.json")));
  writeFileSync(join(oversizedPathSource, "module.ts"),
    "export const implementation = Object.freeze({});\n");
  const longName = "x".repeat(241);
  writeFileSync(join(oversizedPathSource, longName), "x");
  await assert.rejects(
    buildReleasePackage({
      sourceDirectory: oversizedPathSource,
      releaseDirectory: join(root, "long-release"),
      stagingDirectory: join(root, "long-staging"),
      include: [longName],
    }),
    /240-byte path limit/,
  );

  const sourceAlias = join(root, "source-alias");
  symlinkSync(source, sourceAlias, "dir");
  await assert.rejects(
    buildReleasePackage({
      sourceDirectory: source,
      releaseDirectory: join(sourceAlias, "release-inside-source"),
      stagingDirectory: join(root, "symlink-stage"),
    }),
    /overlap/,
  );
});
