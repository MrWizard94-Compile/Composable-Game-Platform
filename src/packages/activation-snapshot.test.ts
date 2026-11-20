import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
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
import { computeArtifactDigest } from "./package-format.ts";
import { snapshotWasmReleasePackageDirectory } from "./package-directory.ts";
import { registerStagedPackage } from "./local-store.ts";
import {
  createProjectLock,
  snapshotWasmProjectLock,
} from "./project-lock.ts";
import { resourceActivationGuest } from "../foundations/wasm-build.ts";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const wasmFixture = join(repositoryRoot, "examples/third-party-module");
const javascriptFixture = join(repositoryRoot, "examples/javascript-module");
const SNAPSHOT_BUDGET = 128 * 1024 * 1024;

function fixture(t: { after(callback: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), "cgp-activation-snapshot-test-"));
  t.after(() => {
    makeWritable(root);
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function makeWritable(directory: string): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) makeWritable(path);
    try { chmodSync(path, entry.isDirectory() ? 0o755 : 0o644); } catch {}
  }
  try { chmodSync(directory, 0o755); } catch {}
}

function makeWasmPackage(root: string, moduleId: string): string {
  const directory = join(root, moduleId.replaceAll(".", "-"));
  mkdirSync(directory, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(wasmFixture, "manifest.json"), "utf8")) as {
    moduleId: string;
    name: string;
  };
  manifest.moduleId = moduleId;
  manifest.name = moduleId;
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(directory, "cgp-package.json"),
    readFileSync(join(wasmFixture, "cgp-package.json")));
  writeFileSync(join(directory, "module.wasm"),
    readFileSync(join(wasmFixture, "module.wasm")));
  writeFileSync(join(directory, "README.md"), "Snapshot fixture for " + moduleId + "\n");
  return directory;
}

function makeResourcePackage(root: string, moduleId: string, note: string, contributionId: string): string {
  const directory = join(root, moduleId.replaceAll(".", "-"));
  mkdirSync(directory, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(wasmFixture, "manifest.json"), "utf8")) as {
    moduleId: string;
    name: string;
    permissions?: string[];
  };
  manifest.moduleId = moduleId;
  manifest.name = moduleId;
  manifest.permissions = ["cgp.resource.read"];
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(directory, "cgp-package.json"), readFileSync(join(wasmFixture, "cgp-package.json")));
  writeFileSync(join(directory, "module.wasm"), resourceActivationGuest(contributionId));
  writeFileSync(join(directory, "note.txt"), note);
  writeFileSync(join(directory, "README.md"), "Resource snapshot for " + moduleId + "\n");
  return directory;
}

function copyPackage(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) copyPackage(from, to);
    else if (entry.isFile()) writeFileSync(to, readFileSync(from));
  }
}

function packageByteLength(directory: string): number {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) total += packageByteLength(path);
    else if (entry.isFile()) total += readFileSync(path).byteLength;
  }
  return total;
}

function projectProfile() {
  return {
    profileId: "org.example.snapshot-project",
    name: "Snapshot Project",
    modules: [
      { moduleId: "org.example.snapshot-one", version: "1.0.0" },
      { moduleId: "org.example.snapshot-two", version: "1.0.0" },
    ],
  };
}

test("single-scan Wasm snapshot returns the exact verified artifact bytes as owned memory", async (t) => {
  const root = fixture(t);
  const staged = makeWasmPackage(root, "org.example.snapshot-one");
  const expectedWasm = readFileSync(join(staged, "module.wasm"));
  const expectedPackageBytes = packageByteLength(staged);

  const result = await snapshotWasmReleasePackageDirectory(staged, SNAPSHOT_BUDGET);
  assert.equal(result.ok, true, result.ok ? "" : result.errors.join("\n"));
  if (!result.ok) return;

  assert.equal(result.snapshot.package.moduleId, "org.example.snapshot-one");
  assert.equal(Object.isFrozen(result.snapshot), true);
  assert.equal(Object.isFrozen(result.snapshot.manifest), true);
  assert.equal(Object.isFrozen(result.snapshot.package), true);
  assert.equal(result.snapshot.package.descriptor.runtime.kind, "wasm-core");
  assert.equal(result.snapshot.packageBytes, expectedPackageBytes);
  assert.equal(
    computeArtifactDigest(result.snapshot.wasmBytes),
    result.snapshot.package.artifactDigest,
  );
  assert.deepEqual(Buffer.from(result.snapshot.wasmBytes), expectedWasm);

  // The result does not depend on the package path after snapshot creation.
  writeFileSync(join(staged, "module.wasm"), new Uint8Array(expectedWasm.byteLength));
  rmSync(staged, { recursive: true, force: true });
  assert.deepEqual(Buffer.from(result.snapshot.wasmBytes), expectedWasm);
  assert.equal(
    computeArtifactDigest(result.snapshot.wasmBytes),
    result.snapshot.package.artifactDigest,
  );
});

test("Wasm snapshot enforces its byte budget during the scan", async (t) => {
  const root = fixture(t);
  const staged = makeWasmPackage(root, "org.example.snapshot-budget");
  const result = await snapshotWasmReleasePackageDirectory(staged, 1);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors.join("\n"), /configured byte limit of 1 bytes/);
});

test("Wasm snapshot refuses JavaScript packages without importing them", async (t) => {
  const root = fixture(t);
  const staged = join(root, "javascript-package");
  copyPackage(javascriptFixture, staged);
  const result = await snapshotWasmReleasePackageDirectory(staged, SNAPSHOT_BUDGET);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors.join("\n"), /accepts only wasm-core/);
});

test("project snapshot verifies every locked Wasm package in profile order within one aggregate budget", async (t) => {
  const root = fixture(t);
  const firstStage = makeWasmPackage(root, "org.example.snapshot-one");
  const secondStage = makeWasmPackage(root, "org.example.snapshot-two");
  const store = join(root, "store");

  await registerStagedPackage(firstStage, store);
  await registerStagedPackage(secondStage, store);

  const profile = projectProfile();
  const lock = await createProjectLock(store, profile);
  const expectedTotal = packageByteLength(firstStage) + packageByteLength(secondStage);

  const snapshot = await snapshotWasmProjectLock(store, profile, lock, expectedTotal);
  assert.equal(snapshot.totalBytes, expectedTotal);
  assert.deepEqual(
    snapshot.modules.map((item) => item.entry.moduleId),
    profile.modules.map((item) => item.moduleId),
  );
  for (let index = 0; index < snapshot.modules.length; index += 1) {
    const item = snapshot.modules[index]!;
    assert.equal(item.entry.packageTreeDigest, lock.modules[index]!.packageTreeDigest);
    assert.equal(computeArtifactDigest(item.wasmBytes), item.entry.artifactDigest);
    assert.equal(item.manifest.moduleId, item.entry.moduleId);
  }

  await assert.rejects(
    snapshotWasmProjectLock(store, profile, lock, expectedTotal - 1),
    /configured byte limit/,
  );
});

test("project snapshot preflights all runtimes and refuses JavaScript before package scanning", async (t) => {
  const root = fixture(t);
  const wasmStage = makeWasmPackage(root, "org.example.snapshot-one");
  const javascriptStage = join(root, "javascript-package");
  copyPackage(javascriptFixture, javascriptStage);
  const javascriptManifest = JSON.parse(readFileSync(join(javascriptStage, "manifest.json"), "utf8")) as {
    moduleId: string;
    version: string;
  };
  const store = join(root, "store");

  await registerStagedPackage(wasmStage, store);
  await registerStagedPackage(javascriptStage, store);
  const profile = {
    profileId: "org.example.mixed-snapshot",
    name: "Mixed Snapshot",
    modules: [
      { moduleId: "org.example.snapshot-one", version: "1.0.0" },
      { moduleId: javascriptManifest.moduleId, version: javascriptManifest.version },
    ],
  };
  const lock = await createProjectLock(store, profile);

  await assert.rejects(
    snapshotWasmProjectLock(store, profile, lock, SNAPSHOT_BUDGET),
    /Wasm-only project snapshot refuses .*javascript-esm/,
  );
});

test("project snapshot refuses a corrupt later package without returning a partial snapshot", async (t) => {
  const root = fixture(t);
  const firstStage = makeWasmPackage(root, "org.example.snapshot-one");
  const secondStage = makeWasmPackage(root, "org.example.snapshot-two");
  const store = join(root, "store");

  await registerStagedPackage(firstStage, store);
  await registerStagedPackage(secondStage, store);
  const profile = projectProfile();
  const lock = await createProjectLock(store, profile);

  const secondDigest = lock.modules[1]!.packageTreeDigest.slice("sha256:".length);
  const secondObject = join(
    store,
    "objects",
    "cgp.package-tree",
    "1",
    "sha256",
    secondDigest,
  );
  const readme = join(secondObject, "README.md");
  chmodSync(readme, 0o644);
  writeFileSync(readme, "tampered after lock creation\n");

  await assert.rejects(
    snapshotWasmProjectLock(store, profile, lock, SNAPSHOT_BUDGET),
    /Stored package bytes differ from the exact lock identity/,
  );
});

test("a resource-importing Wasm package retains every file from the verified scan", async (t) => {
  const root = fixture(t);
  const note = "alpha-note";
  const staged = makeResourcePackage(root, "org.example.snapshot-reader", note, "alpha");
  const expectedWasm = readFileSync(join(staged, "module.wasm"));
  const expectedNote = readFileSync(join(staged, "note.txt"));
  const expectedReadme = readFileSync(join(staged, "README.md"));
  const expectedPackageBytes = packageByteLength(staged);

  const result = await snapshotWasmReleasePackageDirectory(staged, SNAPSHOT_BUDGET);
  assert.equal(result.ok, true, result.ok ? "" : result.errors.join("\n"));
  if (!result.ok) return;
  assert.equal(result.snapshot.packageBytes, expectedPackageBytes);
  assert.ok(result.snapshot.files);
  assert.equal(Object.isFrozen(result.snapshot.files), true);
  assert.deepEqual(result.snapshot.files.map((file) => file.path).sort(), [
    "README.md",
    "cgp-package.json",
    "manifest.json",
    "module.wasm",
    "note.txt",
  ]);
  const wasmFile = result.snapshot.files.find((file) => file.path === "module.wasm");
  const noteFile = result.snapshot.files.find((file) => file.path === "note.txt");
  const readmeFile = result.snapshot.files.find((file) => file.path === "README.md");
  assert.ok(wasmFile && noteFile && readmeFile);
  assert.equal(Object.isFrozen(wasmFile), true);
  assert.equal(wasmFile.bytes, result.snapshot.wasmBytes);
  assert.deepEqual(Buffer.from(wasmFile.bytes), expectedWasm);
  assert.deepEqual(Buffer.from(noteFile.bytes), expectedNote);
  assert.deepEqual(Buffer.from(readmeFile.bytes), expectedReadme);
  assert.equal(
    result.snapshot.files.reduce((sum, file) => sum + file.bytes.byteLength, 0),
    result.snapshot.packageBytes,
  );

  writeFileSync(join(staged, "note.txt"), "changed-after-snapshot");
  writeFileSync(join(staged, "module.wasm"), new Uint8Array(expectedWasm.byteLength));
  rmSync(staged, { recursive: true, force: true });
  assert.deepEqual(Buffer.from(noteFile.bytes), expectedNote);
  assert.deepEqual(Buffer.from(result.snapshot.wasmBytes), expectedWasm);
  assert.equal(wasmFile.bytes, result.snapshot.wasmBytes);
});

test("a Wasm package without resource_read does not retain extra file buffers", async (t) => {
  const root = fixture(t);
  const staged = makeWasmPackage(root, "org.example.snapshot-plain");
  writeFileSync(join(staged, "note.txt"), "plain-note");
  const expectedPackageBytes = packageByteLength(staged);
  const result = await snapshotWasmReleasePackageDirectory(staged, SNAPSHOT_BUDGET);
  assert.equal(result.ok, true, result.ok ? "" : result.errors.join("\n"));
  if (!result.ok) return;
  assert.equal("files" in result.snapshot, false);
  assert.equal(result.snapshot.packageBytes, expectedPackageBytes);
  assert.ok(result.snapshot.packageBytes > result.snapshot.wasmBytes.byteLength);
});

test("Wasm project snapshots keep independent file collections without changing byte accounting", async (t) => {
  const root = fixture(t);
  const plain = makeWasmPackage(root, "org.example.snapshot-plain");
  writeFileSync(join(plain, "note.txt"), "plain-only");
  const reader = makeResourcePackage(root, "org.example.snapshot-reader", "reader-note", "alpha");
  const store = join(root, "store");
  await registerStagedPackage(plain, store);
  await registerStagedPackage(reader, store);
  const profile = {
    profileId: "org.example.resource-snapshot",
    name: "Resource Snapshot",
    modules: [
      { moduleId: "org.example.snapshot-plain", version: "1.0.0" },
      { moduleId: "org.example.snapshot-reader", version: "1.0.0" },
    ],
  };
  const lock = await createProjectLock(store, profile);
  const expectedTotal = packageByteLength(plain) + packageByteLength(reader);
  const snapshot = await snapshotWasmProjectLock(store, profile, lock, expectedTotal);
  assert.equal(snapshot.totalBytes, expectedTotal);
  assert.deepEqual(snapshot.modules.map((item) => item.entry.moduleId), [
    "org.example.snapshot-plain",
    "org.example.snapshot-reader",
  ]);
  assert.equal(snapshot.modules[0]!.files, undefined);
  assert.equal(snapshot.modules[0]!.packageBytes, packageByteLength(plain));
  const retained = snapshot.modules[1]!.files;
  assert.ok(retained);
  assert.equal(retained.find((file) => file.path === "module.wasm")?.bytes, snapshot.modules[1]!.wasmBytes);
  assert.equal(Buffer.from(retained.find((file) => file.path === "note.txt")!.bytes).toString("utf8"), "reader-note");
  assert.notEqual(snapshot.modules[0]!.wasmBytes, snapshot.modules[1]!.wasmBytes);
  assert.equal(
    retained.reduce((sum, file) => sum + file.bytes.byteLength, 0),
    snapshot.modules[1]!.packageBytes,
  );

  const readerObject = join(store, "objects", "cgp.package-tree", "1", "sha256", lock.modules[1]!.packageTreeDigest.slice("sha256:".length));
  chmodSync(join(readerObject, "note.txt"), 0o644);
  writeFileSync(join(readerObject, "note.txt"), "store-rewritten");
  assert.equal(Buffer.from(retained.find((file) => file.path === "note.txt")!.bytes).toString("utf8"), "reader-note");
});

test("a bad later resource package still prevents a partial Wasm snapshot", async (t) => {
  const root = fixture(t);
  const first = makeResourcePackage(root, "org.example.snapshot-one", "kept-note", "alpha");
  const second = makeResourcePackage(root, "org.example.snapshot-two", "dropped-note", "beta");
  const store = join(root, "store");
  await registerStagedPackage(first, store);
  await registerStagedPackage(second, store);
  const profile = projectProfile();
  const lock = await createProjectLock(store, profile);
  const secondObject = join(
    store,
    "objects",
    "cgp.package-tree",
    "1",
    "sha256",
    lock.modules[1]!.packageTreeDigest.slice("sha256:".length),
  );
  chmodSync(join(secondObject, "note.txt"), 0o644);
  writeFileSync(join(secondObject, "note.txt"), "tampered");
  await assert.rejects(
    snapshotWasmProjectLock(store, profile, lock, SNAPSHOT_BUDGET),
    /Stored package bytes differ from the exact lock identity/,
  );
});
