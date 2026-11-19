import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CLOSED_POLICY, inspectWasm } from "../foundations/index.ts";
import { applyLocalStoreGarbageCollection, registerStagedPackage, removeLocalRetentionPin } from "./local-store.ts";
import { createProjectLock } from "./project-lock.ts";
import { buildReleasePackage } from "./release-pipeline.ts";
import { activateProject, platformJavascriptCleanupSupported, setProjectActivationTestProbes, type PackageResourceView } from "./project-activation.ts";

const skipWithoutPinnedCleanup: string | false = platformJavascriptCleanupSupported()
  ? false
  : "JavaScript activation is refused on this platform because cleanup cannot pin the directory against a symlink swap.";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const wasmPackage = join(repositoryRoot, "examples/third-party-module");
const hello = "hello-from-package\n";
const later = () => new Date(Date.now() + 60_000);

function fixture(t: { after(callback: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), "cgp-package-resources-"));
  t.after(() => { makeWritable(root); rmSync(root, { recursive: true, force: true }); });
  return root;
}
function makeWritable(directory: string): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) makeWritable(path);
    try { chmodSync(path, entry.isDirectory() ? 0o755 : 0o644); } catch { /* best effort */ }
  }
  try { chmodSync(directory, 0o755); } catch { /* best effort */ }
}
function leaseNames(store: string): string[] {
  const directory = join(store, ".cgp-store.composition-leases");
  return existsSync(directory) ? readdirSync(directory) : [];
}
async function stageJavaScript(
  root: string,
  moduleId: string,
  source: string,
  files: Readonly<Record<string, string>> = {},
): Promise<string> {
  const sourceDir = join(root, moduleId + "-source");
  mkdirSync(sourceDir);
  writeFileSync(join(sourceDir, "manifest.json"), JSON.stringify({
    moduleId, name: moduleId, version: "1.0.0", moduleApi: ">=1.0.0 <2.0.0", permissions: [],
  }, null, 2) + "\n");
  writeFileSync(join(sourceDir, "module.ts"), source);
  for (const [path, contents] of Object.entries(files)) {
    const full = join(sourceDir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  const staging = join(root, moduleId + "-stage");
  await buildReleasePackage({
    sourceDirectory: sourceDir,
    releaseDirectory: join(root, moduleId + "-release"),
    stagingDirectory: staging,
  });
  return staging;
}
function resourceSource(slot: string): string {
  return [
    "import { writeFileSync } from \"node:fs\";",
    "let resources;",
    "export const implementation = {",
    "  openResources(view) {",
    "    resources = view;",
    "    globalThis[" + JSON.stringify(slot) + "] = view;",
    "  },",
    "  shutdown() {",
    "    const marker = process.env.CGP_RESOURCE_SHUTDOWN;",
    "    if (!marker || !resources) return;",
    "    writeFileSync(marker, new TextDecoder().decode(resources.read(\"data/hello.txt\")));",
    "  },",
    "};",
    "",
  ].join("\n");
}
function viewAt(slot: string): PackageResourceView {
  const view = (globalThis as unknown as Record<string, PackageResourceView | undefined>)[slot];
  if (!view) throw new Error("module did not receive a package resource view");
  return view;
}
function clearView(slot: string): void {
  delete (globalThis as Record<string, unknown>)[slot];
}
async function rejected(shutdown: () => Promise<{ already: boolean }>): Promise<string> {
  try {
    const report = await shutdown();
    assert.fail("shutdown resolved already=" + String(report.already));
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    if (error instanceof AggregateError) {
      return [error.message, ...error.errors.map((item) => item instanceof Error ? item.message : String(item))].join("\n");
    }
    return error instanceof Error ? error.message : String(error);
  }
}

test("a module reads exact package-tree bytes and cannot mutate the retained snapshot", { skip: skipWithoutPinnedCleanup }, async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  const shutdownMarker = join(root, "shutdown");
  const slot = "__cgpResourceExact";
  const staging = await stageJavaScript(root, "org.example.resources", resourceSource(slot), { "data/hello.txt": hello });
  const registered = await registerStagedPackage(staging, store);
  const project = { profileId: "org.example.resources-project", name: "Resources", modules: [{ moduleId: "org.example.resources", version: "1.0.0" }] };
  const lock = await createProjectLock(store, project);
  process.env.CGP_RESOURCE_SHUTDOWN = shutdownMarker;
  const activation = await activateProject(store, project, lock, { maxSnapshotBytes: 1024 * 1024, javascript: "trusted-in-process" });
  try {
    assert.equal(activation.ok, true, activation.composition.diagnostics.map((item) => item.message).join("\n"));
    const view = viewAt(slot);
    assert.equal(view.packageTreeDigest, registered.entry.packageTreeDigest);
    assert.equal(view.packageTreeDigest.includes(store), false);
    const names = Object.getOwnPropertyNames(view);
    assert.deepEqual(names.slice().sort(), ["list", "packageTreeDigest", "read"]);
    const listed = view.list();
    assert.equal(listed.includes("data/hello.txt"), true);
    assert.equal(listed.includes("manifest.json"), true);
    assert.equal(listed.includes("cgp-package.json"), true);
    assert.equal(listed.includes("module.mjs"), true);
    assert.equal(listed.join("\n").includes(store), false);
    assert.equal(listed.join("\n").includes(root), false);
    const first = view.read("data/hello.txt");
    const second = view.read("data/hello.txt");
    assert.equal(Buffer.from(first).toString("utf8"), hello);
    assert.notEqual(first, second);
    first[0] = first[0]! ^ 0xff;
    assert.equal(Buffer.from(view.read("data/hello.txt")).toString("utf8"), hello);
    assert.equal(Buffer.from(second).toString("utf8"), hello);
    const stopped = await activation.shutdown();
    assert.equal(stopped.already, false);
    assert.equal(readFileSync(shutdownMarker, "utf8"), hello);
    assert.throws(() => view.read("data/hello.txt"), /Package resources are closed/);
    assert.throws(() => view.list(), /Package resources are closed/);
    assert.equal((await activation.shutdown()).already, true);
    assert.deepEqual(leaseNames(store), []);
  } finally {
    delete process.env.CGP_RESOURCE_SHUTDOWN;
    clearView(slot);
    await activation.shutdown().catch(() => undefined);
  }
});

test("changing a data file changes the package-tree identity and not only the artifact digest", async (t) => {
  const root = fixture(t);
  const sourceDir = join(root, "source");
  mkdirSync(join(sourceDir, "data"), { recursive: true });
  writeFileSync(join(sourceDir, "manifest.json"), JSON.stringify({
    moduleId: "org.example.same-bytes", name: "org.example.same-bytes", version: "1.0.0",
    moduleApi: ">=1.0.0 <2.0.0", permissions: [],
  }, null, 2) + "\n");
  writeFileSync(join(sourceDir, "module.ts"), "export const implementation = {};\n");
  writeFileSync(join(sourceDir, "data", "hello.txt"), "one\n");
  const stageA = join(root, "stage-a");
  await buildReleasePackage({
    sourceDirectory: sourceDir,
    releaseDirectory: join(root, "release-a"),
    stagingDirectory: stageA,
  });
  writeFileSync(join(sourceDir, "data", "hello.txt"), "two\n");
  const stageB = join(root, "stage-b");
  await buildReleasePackage({
    sourceDirectory: sourceDir,
    releaseDirectory: join(root, "release-b"),
    stagingDirectory: stageB,
  });
  const storeA = join(root, "store-a");
  const storeB = join(root, "store-b");
  const first = await registerStagedPackage(stageA, storeA);
  const second = await registerStagedPackage(stageB, storeB);
  assert.equal(first.entry.artifactDigest, second.entry.artifactDigest);
  assert.notEqual(first.entry.packageTreeDigest, second.entry.packageTreeDigest);
  const project = { profileId: "org.example.same-bytes-project", name: "Bytes", modules: [{ moduleId: "org.example.same-bytes", version: "1.0.0" }] };
  const lockA = await createProjectLock(storeA, project);
  const lockB = await createProjectLock(storeB, project);
  assert.equal(lockA.modules[0]!.artifactDigest, lockB.modules[0]!.artifactDigest);
  assert.notEqual(lockA.modules[0]!.packageTreeDigest, lockB.modules[0]!.packageTreeDigest);
  assert.notEqual(JSON.stringify(lockA), JSON.stringify(lockB));
});

test("rejects paths that are not the exact package key and hides the other package", { skip: skipWithoutPinnedCleanup }, async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  const slotA = "__cgpResourceA";
  const slotB = "__cgpResourceB";
  const capture = (slot: string) => [
    "export const implementation = {",
    "  openResources(view) { globalThis[" + JSON.stringify(slot) + "] = view; },",
    "};",
    "",
  ].join("\n");
  const stageA = await stageJavaScript(root, "org.example.pack-a", capture(slotA), { "data/only-a.txt": "aaa" });
  const stageB = await stageJavaScript(root, "org.example.pack-b", capture(slotB), { "data/only-b.txt": "bbb" });
  await registerStagedPackage(stageA, store);
  await registerStagedPackage(stageB, store);
  const project = {
    profileId: "org.example.two-resources",
    name: "Two",
    modules: [
      { moduleId: "org.example.pack-a", version: "1.0.0" },
      { moduleId: "org.example.pack-b", version: "1.0.0" },
    ],
  };
  const lock = await createProjectLock(store, project);
  const activation = await activateProject(store, project, lock, { maxSnapshotBytes: 2 * 1024 * 1024, javascript: "trusted-in-process" });
  try {
    assert.equal(activation.ok, true, activation.composition.diagnostics.map((item) => item.message).join("\n"));
    const viewA = viewAt(slotA);
    const viewB = viewAt(slotB);
    assert.equal(Buffer.from(viewA.read("data/only-a.txt")).toString("utf8"), "aaa");
    assert.equal(Buffer.from(viewB.read("data/only-b.txt")).toString("utf8"), "bbb");
    assert.throws(() => viewA.read("data/only-b.txt"), /not in this snapshot/);
    assert.throws(() => viewB.read("data/only-a.txt"), /not in this snapshot/);
    assert.throws(() => viewA.read("data/missing.txt"), /not in this snapshot/);
    assert.throws(() => viewA.read("/data/only-a.txt"), /not an exact package path/);
    assert.throws(() => viewA.read(store + "/data/only-a.txt"), /not an exact package path/);
    assert.throws(() => viewA.read("data/../data/only-a.txt"), /not an exact package path/);
    assert.throws(() => viewA.read("data\\only-a.txt"), /not an exact package path/);
    assert.throws(() => viewA.read("data/%2e%2e/only-a.txt"), /not an exact package path/);
    assert.throws(() => viewA.read("data/%2e/only-a.txt"), /not an exact package path/);
    assert.throws(() => viewA.read("data/./only-a.txt"), /not an exact package path/);
    assert.throws(() => viewA.read("data/Only-a.txt"), /not in this snapshot/);
    assert.throws(() => viewA.read("Data/only-a.txt"), /not in this snapshot/);
    for (const read of [
      () => viewA.read("data/../secret"),
      () => viewA.read("data\\only-a.txt"),
      () => viewA.read("data/%2e%2e/only-a.txt"),
    ]) {
      try {
        read();
        assert.fail("read resolved");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        assert.equal(message.includes(store), false, message);
        assert.equal(message.includes(root), false, message);
      }
    }
    const revealed = JSON.stringify({
      digest: viewA.packageTreeDigest,
      paths: viewA.list(),
      other: viewB.packageTreeDigest,
    });
    assert.equal(revealed.includes(store), false);
    assert.equal(revealed.includes(root), false);
  } finally {
    clearView(slotA);
    clearView(slotB);
    await activation.shutdown().catch(() => undefined);
  }
});

test("a closed policy does not import JavaScript or hand out a resource view", async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  const marker = join(root, "marker");
  const slot = "__cgpResourceClosed";
  const source = [
    "import { writeFileSync } from \"node:fs\";",
    "const marker = process.env.CGP_RESOURCE_CLOSED;",
    "if (marker) writeFileSync(marker, \"ran\");",
    "export const implementation = {",
    "  openResources() { if (process.env.CGP_RESOURCE_CLOSED) writeFileSync(process.env.CGP_RESOURCE_CLOSED, \"opened\"); },",
    "};",
    "",
  ].join("\n");
  const staging = await stageJavaScript(root, "org.example.closed-resources", source, { "data/hello.txt": hello });
  await registerStagedPackage(staging, store);
  const project = { profileId: "org.example.closed-resources-project", name: "Closed", modules: [{ moduleId: "org.example.closed-resources", version: "1.0.0" }] };
  const lock = await createProjectLock(store, project);
  process.env.CGP_RESOURCE_CLOSED = marker;
  const activation = await activateProject(store, project, lock, {
    maxSnapshotBytes: 1024 * 1024,
    javascript: "trusted-in-process",
    policy: CLOSED_POLICY,
  });
  delete process.env.CGP_RESOURCE_CLOSED;
  assert.equal(activation.ok, false);
  assert.equal(existsSync(marker), false);
  assert.equal((globalThis as Record<string, unknown>)[slot], undefined);
  assert.ok(activation.composition.diagnostics.some((item) => item.code === "trust.grants"));
  assert.deepEqual(leaseNames(store), []);
  assert.equal((await activation.shutdown()).already, true);
});

test("one bad package prevents activation before any JavaScript import or resource view", async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  const marker = join(root, "marker");
  const source = [
    "import { writeFileSync } from \"node:fs\";",
    "const marker = process.env.CGP_RESOURCE_BAD;",
    "if (marker) writeFileSync(marker, \"ran\");",
    "export const implementation = { openResources() { if (process.env.CGP_RESOURCE_BAD) writeFileSync(process.env.CGP_RESOURCE_BAD, \"opened\"); } };",
    "",
  ].join("\n");
  const first = await stageJavaScript(root, "org.example.resource-first", source, { "data/hello.txt": hello });
  const second = await stageJavaScript(root, "org.example.resource-second", "export const implementation = {};\n");
  await registerStagedPackage(first, store);
  const registeredSecond = await registerStagedPackage(second, store);
  const project = {
    profileId: "org.example.resource-bad",
    name: "Bad",
    modules: [
      { moduleId: "org.example.resource-first", version: "1.0.0" },
      { moduleId: "org.example.resource-second", version: "1.0.0" },
    ],
  };
  const lock = await createProjectLock(store, project);
  chmodSync(registeredSecond.objectDirectory, 0o755);
  chmodSync(join(registeredSecond.objectDirectory, "module.mjs"), 0o644);
  writeFileSync(join(registeredSecond.objectDirectory, "module.mjs"), "export const implementation = {};\nthis is not javascript\n");
  process.env.CGP_RESOURCE_BAD = marker;
  try {
    await assert.rejects(
      activateProject(store, project, lock, { maxSnapshotBytes: 2 * 1024 * 1024, javascript: "trusted-in-process" }),
      platformJavascriptCleanupSupported()
        ? /failed validation|snapshot failed|malformed/
        : /cannot pin the directory against a symlink swap/,
    );
  } finally {
    delete process.env.CGP_RESOURCE_BAD;
  }
  assert.equal(existsSync(marker), false);
  assert.deepEqual(leaseNames(store), []);
});

test("snapshot budget failure happens before import and releases the lease", async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  const marker = join(root, "marker");
  const source = [
    "import { writeFileSync } from \"node:fs\";",
    "if (process.env.CGP_RESOURCE_BUDGET) writeFileSync(process.env.CGP_RESOURCE_BUDGET, \"ran\");",
    "export const implementation = { openResources() { if (process.env.CGP_RESOURCE_BUDGET) writeFileSync(process.env.CGP_RESOURCE_BUDGET, \"opened\"); } };",
    "",
  ].join("\n");
  const staging = await stageJavaScript(root, "org.example.resource-budget", source, { "data/hello.txt": hello });
  await registerStagedPackage(staging, store);
  const project = { profileId: "org.example.resource-budget-project", name: "Budget", modules: [{ moduleId: "org.example.resource-budget", version: "1.0.0" }] };
  const lock = await createProjectLock(store, project);
  process.env.CGP_RESOURCE_BUDGET = marker;
  try {
    await assert.rejects(
      activateProject(store, project, lock, { maxSnapshotBytes: 1, javascript: "trusted-in-process" }),
      platformJavascriptCleanupSupported()
        ? /byte limit/
        : /cannot pin the directory against a symlink swap/,
    );
  } finally {
    delete process.env.CGP_RESOURCE_BUDGET;
  }
  assert.equal(existsSync(marker), false);
  assert.deepEqual(leaseNames(store), []);
});

test("an unrelated unpinned object can be collected while leased resource bytes stay unchanged", { skip: skipWithoutPinnedCleanup }, async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  const slot = "__cgpResourceKeep";
  const staging = await stageJavaScript(root, "org.example.resource-keep", resourceSource(slot), { "data/hello.txt": hello });
  const extraStage = await stageJavaScript(root, "org.example.resource-extra", "export const implementation = {};\n");
  const registered = await registerStagedPackage(staging, store);
  const extra = await registerStagedPackage(extraStage, store);
  await removeLocalRetentionPin(store, registered.entry.packageTreeDigest);
  await removeLocalRetentionPin(store, extra.entry.packageTreeDigest);
  const project = { profileId: "org.example.resource-keep-project", name: "Keep", modules: [{ moduleId: "org.example.resource-keep", version: "1.0.0" }] };
  const lock = await createProjectLock(store, project);
  const activation = await activateProject(store, project, lock, { maxSnapshotBytes: 1024 * 1024, javascript: "trusted-in-process" });
  try {
    const before = Buffer.from(viewAt(slot).read("data/hello.txt"));
    const applied = await applyLocalStoreGarbageCollection(store, { gracePeriodMs: 0, now: later() });
    assert.equal(applied.deleted.includes(extra.entry.packageTreeDigest), true);
    assert.equal(applied.deleted.includes(registered.entry.packageTreeDigest), false);
    assert.equal(existsSync(extra.objectDirectory), false);
    assert.equal(existsSync(registered.objectDirectory), true);
    const after = viewAt(slot).read("data/hello.txt");
    assert.equal(Buffer.from(after).toString("utf8"), hello);
    assert.equal(Buffer.compare(before, Buffer.from(after)), 0);
  } finally {
    clearView(slot);
    await activation.shutdown().catch(() => undefined);
  }
});

test("resource invalidation failure stays visible and retryable without reporting the lease released", { skip: skipWithoutPinnedCleanup }, async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  const slot = "__cgpResourceClose";
  const staging = await stageJavaScript(root, "org.example.resource-close", resourceSource(slot), { "data/hello.txt": hello });
  await registerStagedPackage(staging, store);
  const project = { profileId: "org.example.resource-close-project", name: "Close", modules: [{ moduleId: "org.example.resource-close", version: "1.0.0" }] };
  const lock = await createProjectLock(store, project);
  const activation = await activateProject(store, project, lock, { maxSnapshotBytes: 1024 * 1024, javascript: "trusted-in-process" });
  const view = viewAt(slot);
  const leasePath = join(store, ".cgp-store.composition-leases", activation.leaseId + ".json");
  const saved = readFileSync(leasePath);
  setProjectActivationTestProbes({
    beforeCloseResources() { throw new Error("injected-resource-close"); },
  });
  try {
    rmSync(leasePath);
    mkdirSync(leasePath);
    const first = await rejected(activation.shutdown);
    assert.match(first, /injected-resource-close/);
    assert.match(first, /Composition lease must be a regular file/);
    assert.equal(/lease was released/i.test(first), false);
    assert.equal(/already/i.test(first), false);
    assert.equal(existsSync(leasePath), true);
    assert.equal(Buffer.from(view.read("data/hello.txt")).toString("utf8"), hello);
    const second = await rejected(activation.shutdown);
    assert.match(second, /injected-resource-close/);
    assert.match(second, /Composition lease must be a regular file/);
    assert.equal(Buffer.from(view.read("data/hello.txt")).toString("utf8"), hello);
    setProjectActivationTestProbes(undefined);
    rmSync(leasePath, { recursive: true, force: true });
    writeFileSync(leasePath, saved);
    const stopped = await activation.shutdown();
    assert.equal(stopped.already, false);
    assert.throws(() => view.read("data/hello.txt"), /Package resources are closed/);
    assert.deepEqual(leaseNames(store), []);
    assert.equal((await activation.shutdown()).already, true);
  } finally {
    setProjectActivationTestProbes(undefined);
    clearView(slot);
    if (existsSync(leasePath)) rmSync(leasePath, { recursive: true, force: true });
    await activation.shutdown().catch(() => undefined);
  }
});

test("a Wasm package in the same project gains no resource or filesystem import", { skip: skipWithoutPinnedCleanup }, async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  const slot = "__cgpResourceWasm";
  const jsStage = await stageJavaScript(root, "org.example.resource-with-wasm", resourceSource(slot), { "data/hello.txt": hello });
  await registerStagedPackage(wasmPackage, store);
  await registerStagedPackage(jsStage, store);
  const project = {
    profileId: "org.example.resource-wasm",
    name: "Mixed",
    modules: [
      { moduleId: "org.example.resource-with-wasm", version: "1.0.0" },
      { moduleId: "org.example.beacon", version: "1.0.0" },
    ],
  };
  const lock = await createProjectLock(store, project);
  const guest = inspectWasm(readFileSync(join(wasmPackage, "module.wasm")));
  assert.deepEqual(guest.imports, []);
  const activation = await activateProject(store, project, lock, {
    maxSnapshotBytes: 8 * 1024 * 1024,
    javascript: "trusted-in-process",
    backendOptions: { maxHookMs: 1000, maxMemoryBytes: 65536, maxBinaryBytes: 65536 },
  });
  try {
    assert.equal(activation.ok, true, activation.composition.diagnostics.map((item) => item.message).join("\n"));
    assert.equal(activation.composition.backendId, "cross");
    assert.deepEqual(activation.modules.map((item) => item.runtime), ["javascript-esm", "wasm-core"]);
    const view = viewAt(slot);
    assert.equal(Buffer.from(view.read("data/hello.txt")).toString("utf8"), hello);
    assert.equal(view.list().includes("module.wasm"), false);
    assert.equal(view.list().join("\n").includes(store), false);
    const again = inspectWasm(readFileSync(join(wasmPackage, "module.wasm")));
    assert.deepEqual(again.imports, []);
  } finally {
    clearView(slot);
    await activation.shutdown().catch(() => undefined);
  }
});
