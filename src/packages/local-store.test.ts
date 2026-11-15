import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildReleasePackage } from "./release-pipeline.ts";
import {
  readLocalCatalog,
  registerStagedPackage,
  resolveLocalPackage,
  verifyLocalStore,
} from "./local-store.ts";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));

function makeWritable(directory: string): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) makeWritable(path);
    try { chmodSync(path, entry.isDirectory() ? 0o755 : 0o644); } catch {}
  }
  try { chmodSync(directory, 0o755); } catch {}
}

function fixture(t: { after(callback: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), "cgp-store-test-"));
  t.after(() => {
    makeWritable(root);
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

async function buildStarter(root: string, suffix: string, readme?: string): Promise<string> {
  const source = join(root, "source-" + suffix);
  mkdirSync(source);
  writeFileSync(join(source, "manifest.json"),
    readFileSync(join(repositoryRoot, "examples/starter-module/manifest.json")));
  writeFileSync(join(source, "module.ts"),
    readFileSync(join(repositoryRoot, "examples/starter-module/module.ts")));
  if (readme !== undefined) writeFileSync(join(source, "README.md"), readme);
  const staging = join(root, "stage-" + suffix);
  await buildReleasePackage({
    sourceDirectory: source,
    releaseDirectory: join(root, "release-" + suffix),
    stagingDirectory: staging,
  });
  return staging;
}

test("registers a staged package as a read-only content object and catalog record", async (t) => {
  const root = fixture(t);
  const staging = await buildStarter(root, "one", "First release notes\n");
  const store = join(root, "store");
  const result = await registerStagedPackage(staging, store);

  assert.equal(result.idempotent, false);
  assert.equal(result.entry.moduleId, "org.example.starter");
  assert.equal(result.entry.version, "1.0.0");
  assert.equal(result.entry.runtime, "javascript-esm");
  assert.equal(lstatSync(result.objectDirectory).isDirectory(), true);
  assert.equal(lstatSync(result.objectDirectory).mode & 0o222, 0);
  assert.equal(lstatSync(join(result.objectDirectory, "module.mjs")).mode & 0o222, 0);
  const catalog = readLocalCatalog(store);
  assert.equal(catalog.schema, "cgp.local-catalog/1");
  assert.equal(catalog.entries.length, 1);
  assert.equal(catalog.entries[0]!.packageTreeDigest, result.entry.packageTreeDigest);
  const resolved = await resolveLocalPackage(store, "org.example.starter", "1.0.0");
  assert.equal(resolved?.objectDirectory, result.objectDirectory);
  assert.equal(await resolveLocalPackage(store, "org.example.missing", "1.0.0"), undefined);
  const verification = await verifyLocalStore(store);
  assert.deepEqual(verification, { checked: 1, valid: 1, errors: [] });
});

test("registers WebAssembly releases without instantiating their guest", async (t) => {
  const root = fixture(t);
  const staging = join(root, "wasm-stage");
  await buildReleasePackage({
    sourceDirectory: join(repositoryRoot, "examples/third-party-module"),
    releaseDirectory: join(root, "wasm-release"),
    stagingDirectory: staging,
  });
  const result = await registerStagedPackage(staging, join(root, "store"));
  assert.equal(result.entry.runtime, "wasm-core");
  assert.ok(result.entry.files.includes("module.wasm"));
  const verification = await verifyLocalStore(join(root, "store"));
  assert.deepEqual(verification, { checked: 1, valid: 1, errors: [] });
});

test("identical registration is idempotent and does not duplicate catalog entries", async (t) => {
  const root = fixture(t);
  const staging = await buildStarter(root, "same");
  const store = join(root, "store");
  const first = await registerStagedPackage(staging, store);
  const second = await registerStagedPackage(staging, store);
  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  assert.equal(readLocalCatalog(store).entries.length, 1);
});

test("immutable moduleId/version cannot be rebound to different package bytes", async (t) => {
  const root = fixture(t);
  const firstStage = await buildStarter(root, "first", "Original\n");
  const secondStage = await buildStarter(root, "second", "Changed documentation\n");
  const store = join(root, "store");
  const first = await registerStagedPackage(firstStage, store);
  await assert.rejects(
    registerStagedPackage(secondStage, store),
    /Immutable release conflict/,
  );
  const catalog = readLocalCatalog(store);
  assert.equal(catalog.entries.length, 1);
  assert.equal(catalog.entries[0]!.packageTreeDigest, first.entry.packageTreeDigest);
});

test("a corrupt existing content object is refused and reported by verification", async (t) => {
  const root = fixture(t);
  const staging = await buildStarter(root, "corrupt");
  const store = join(root, "store");
  const registered = await registerStagedPackage(staging, store);
  chmodSync(registered.objectDirectory, 0o755);
  chmodSync(join(registered.objectDirectory, "module.mjs"), 0o644);
  writeFileSync(join(registered.objectDirectory, "module.mjs"), "export const implementation = {};\n");
  await assert.rejects(
    registerStagedPackage(staging, store),
    /Stored package failed validation|do not match/,
  );
  const verification = await verifyLocalStore(store);
  assert.equal(verification.checked, 1);
  assert.equal(verification.valid, 0);
  assert.equal(verification.errors.length, 1);
});

test("an existing writer lock fails closed without changing the catalog", async (t) => {
  const root = fixture(t);
  const staging = await buildStarter(root, "locked");
  const store = join(root, "store");
  mkdirSync(store);
  writeFileSync(join(store, ".cgp-store.lock"), "{\"schema\":\"cgp.local-store-lock/1\"}\n");
  await assert.rejects(registerStagedPackage(staging, store), /locked by another writer or a stale lock/);
  assert.equal(readLocalCatalog(store).entries.length, 0);
});
