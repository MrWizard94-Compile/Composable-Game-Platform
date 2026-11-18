import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applyLocalStoreGarbageCollection, previewLocalStoreGarbageCollection, registerStagedPackage, removeLocalRetentionPin } from "./local-store.ts";
import { createProjectLock } from "./project-lock.ts";
import { buildReleasePackage } from "./release-pipeline.ts";
import { activateProject } from "./project-activation.ts";
import { CLOSED_POLICY } from "../foundations/index.ts";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const wasmPackage = join(repositoryRoot, "examples/third-party-module");
const javascriptPackage = join(repositoryRoot, "examples/javascript-module");
const limits = { maxHookMs: 1000, maxMemoryBytes: 65536, maxBinaryBytes: 65536 };
const later = () => new Date(Date.now() + 60_000);

function fixture(t: { after(callback: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), "cgp-project-activation-test-"));
  t.after(() => { makeWritable(root); rmSync(root, { recursive: true, force: true }); });
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
function leaseNames(store: string): string[] {
  const directory = join(store, ".cgp-store.composition-leases");
  return existsSync(directory) ? readdirSync(directory) : [];
}
async function stageJavaScript(root: string, moduleId: string, source: string): Promise<string> {
  const sourceDir = join(root, moduleId + "-source");
  mkdirSync(sourceDir);
  writeFileSync(join(sourceDir, "manifest.json"), JSON.stringify({
    moduleId, name: moduleId, version: "1.0.0", moduleApi: ">=1.0.0 <2.0.0", permissions: [],
  }, null, 2) + "\n");
  writeFileSync(join(sourceDir, "module.ts"), source);
  const staging = join(root, moduleId + "-stage");
  await buildReleasePackage({
    sourceDirectory: sourceDir,
    releaseDirectory: join(root, moduleId + "-release"),
    stagingDirectory: staging,
  });
  return staging;
}
function markerSource(label: string): string {
  return [
    "import { writeFileSync } from \"node:fs\";",
    "const marker = process.env.CGP_ACTIVATION_MARKER;",
    "if (marker) writeFileSync(marker, " + JSON.stringify(label) + ");",
    "export const implementation = {};",
    "",
  ].join("\n");
}

test("refuses JavaScript until the caller opts into trusted in-process execution", async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  const marker = join(root, "marker");
  const staging = await stageJavaScript(root, "org.example.side", markerSource("ran"));
  await registerStagedPackage(staging, store);
  const project = { profileId: "org.example.js-only", name: "JS", modules: [{ moduleId: "org.example.side", version: "1.0.0" }] };
  const lock = await createProjectLock(store, project);
  process.env.CGP_ACTIVATION_MARKER = marker;
  try {
    await assert.rejects(
      activateProject(store, project, lock, { maxSnapshotBytes: 1024 * 1024 }),
      /not sandboxed/,
    );
    await assert.rejects(
      activateProject(store, project, lock, { maxSnapshotBytes: 1024 * 1024, policy: { allowGrants: ["filesystem", "network", "os"] } }),
      /not sandboxed/,
    );
  } finally {
    delete process.env.CGP_ACTIVATION_MARKER;
  }
  assert.equal(existsSync(marker), false);
  assert.deepEqual(leaseNames(store), []);
});

test("imports JavaScript only after every locked package verifies", async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  const marker = join(root, "marker");
  const first = await stageJavaScript(root, "org.example.first", markerSource("first"));
  const second = await stageJavaScript(root, "org.example.second", "export const implementation = {};\n");
  const registeredFirst = await registerStagedPackage(first, store);
  const registeredSecond = await registerStagedPackage(second, store);
  const project = {
    profileId: "org.example.two-js",
    name: "Two",
    modules: [
      { moduleId: "org.example.first", version: "1.0.0" },
      { moduleId: "org.example.second", version: "1.0.0" },
    ],
  };
  const lock = await createProjectLock(store, project);
  chmodSync(registeredSecond.objectDirectory, 0o755);
  chmodSync(join(registeredSecond.objectDirectory, "module.mjs"), 0o644);
  writeFileSync(join(registeredSecond.objectDirectory, "module.mjs"), "export const implementation = {};\nthis is not javascript\n");
  process.env.CGP_ACTIVATION_MARKER = marker;
  try {
    await assert.rejects(
      activateProject(store, project, lock, { maxSnapshotBytes: 2 * 1024 * 1024, javascript: "trusted-in-process" }),
      /failed validation|snapshot failed|malformed|JavaScript/i,
    );
  } finally {
    delete process.env.CGP_ACTIVATION_MARKER;
  }
  assert.equal(existsSync(marker), false);
  assert.deepEqual(leaseNames(store), []);
  assert.equal(existsSync(registeredFirst.objectDirectory), true);
});

test("runs opted-in JavaScript, shuts it down once, and releases the lease", async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  const marker = join(root, "marker");
  const shutdownMarker = join(root, "shutdown");
  const source = [
    "import { appendFileSync, writeFileSync } from \"node:fs\";",
    "if (process.env.CGP_ACTIVATION_MARKER) writeFileSync(process.env.CGP_ACTIVATION_MARKER, \"ran\");",
    "export const implementation = {",
    "  shutdown() { appendFileSync(process.env.CGP_SHUTDOWN_MARKER, \"x\"); },",
    "};",
    "",
  ].join("\n");
  const staging = await stageJavaScript(root, "org.example.live", source);
  const registered = await registerStagedPackage(staging, store);
  await removeLocalRetentionPin(store, registered.entry.packageTreeDigest);
  const project = { profileId: "org.example.live-js", name: "Live", modules: [{ moduleId: "org.example.live", version: "1.0.0" }] };
  const lock = await createProjectLock(store, project);
  process.env.CGP_ACTIVATION_MARKER = marker;
  process.env.CGP_SHUTDOWN_MARKER = shutdownMarker;
  const activation = await activateProject(store, project, lock, { maxSnapshotBytes: 1024 * 1024, javascript: "trusted-in-process" });
  try {
    assert.equal(activation.ok, true, activation.composition.diagnostics.map((item) => item.message).join("\n"));
    assert.equal(activation.javascriptTrust, "trusted-in-process");
    assert.equal(activation.composition.backendId, "in-process");
    assert.equal(activation.composition.limitsEnforced, false);
    assert.deepEqual(activation.composition.grants, ["filesystem", "network", "os"]);
    assert.equal(readFileSync(marker, "utf8"), "ran");
    assert.equal(leaseNames(store).length, 1);
    const preview = await previewLocalStoreGarbageCollection(store, { gracePeriodMs: 0, now: later() });
    assert.equal(preview.objects.find((item) => item.digest === registered.entry.packageTreeDigest)?.status, "retained");
    const applied = await applyLocalStoreGarbageCollection(store, { gracePeriodMs: 0, now: later() });
    assert.equal(applied.deleted.includes(registered.entry.packageTreeDigest), false);
    const stopped = await activation.shutdown();
    assert.equal(stopped.already, false);
    assert.equal(readFileSync(shutdownMarker, "utf8"), "x");
    const repeated = await activation.shutdown();
    assert.equal(repeated.already, true);
    assert.equal(readFileSync(shutdownMarker, "utf8"), "x");
  } finally {
    delete process.env.CGP_ACTIVATION_MARKER;
    delete process.env.CGP_SHUTDOWN_MARKER;
    await activation.shutdown();
  }
  assert.deepEqual(leaseNames(store), []);
});

test("a closed policy does not import opted-in JavaScript", async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  const marker = join(root, "marker");
  const staging = await stageJavaScript(root, "org.example.closed", markerSource("ran"));
  await registerStagedPackage(staging, store);
  const project = { profileId: "org.example.closed-js", name: "Closed", modules: [{ moduleId: "org.example.closed", version: "1.0.0" }] };
  const lock = await createProjectLock(store, project);
  process.env.CGP_ACTIVATION_MARKER = marker;
  const activation = await activateProject(store, project, lock, {
    maxSnapshotBytes: 1024 * 1024,
    javascript: "trusted-in-process",
    policy: CLOSED_POLICY,
  });
  delete process.env.CGP_ACTIVATION_MARKER;
  assert.equal(activation.ok, false);
  assert.equal(existsSync(marker), false);
  assert.ok(activation.composition.diagnostics.some((item) => item.code === "trust.grants"));
  assert.deepEqual(leaseNames(store), []);
  const repeated = await activation.shutdown();
  assert.equal(repeated.already, true);
});

test("releases the lease when JavaScript import or initialization fails", async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  const boom = await stageJavaScript(root, "org.example.boom", "export const implementation = {};\nthrow new Error(\"import-boom\");\n");
  await registerStagedPackage(boom, store);
  const boomProject = { profileId: "org.example.boom-project", name: "Boom", modules: [{ moduleId: "org.example.boom", version: "1.0.0" }] };
  const boomLock = await createProjectLock(store, boomProject);
  await assert.rejects(
    activateProject(store, boomProject, boomLock, { maxSnapshotBytes: 1024 * 1024, javascript: "trusted-in-process" }),
    /import-boom/,
  );
  assert.deepEqual(leaseNames(store), []);

  const init = await stageJavaScript(root, "org.example.init", "export const implementation = { initialize() { throw new Error(\"init-boom\"); } };\n");
  await registerStagedPackage(init, store);
  const initProject = { profileId: "org.example.init-project", name: "Init", modules: [{ moduleId: "org.example.init", version: "1.0.0" }] };
  const initLock = await createProjectLock(store, initProject);
  const activation = await activateProject(store, initProject, initLock, { maxSnapshotBytes: 1024 * 1024, javascript: "trusted-in-process" });
  assert.equal(activation.ok, false);
  assert.ok(activation.composition.diagnostics.some((item) => item.message.includes("init-boom")));
  assert.deepEqual(leaseNames(store), []);
  assert.equal((await activation.shutdown()).already, true);
});

test("activates a mixed project on the cross backend without sandboxing JavaScript", async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  const wasm = await registerStagedPackage(wasmPackage, store);
  const javascript = await registerStagedPackage(javascriptPackage, store);
  const extraSource = join(repositoryRoot, "examples/starter-module");
  const extraStage = join(root, "extra-stage");
  await buildReleasePackage({
    sourceDirectory: extraSource,
    releaseDirectory: join(root, "extra-release"),
    stagingDirectory: extraStage,
  });
  const extra = await registerStagedPackage(extraStage, store);
  await removeLocalRetentionPin(store, wasm.entry.packageTreeDigest);
  await removeLocalRetentionPin(store, javascript.entry.packageTreeDigest);
  await removeLocalRetentionPin(store, extra.entry.packageTreeDigest);
  const project = {
    profileId: "org.example.mixed",
    name: "Mixed",
    modules: [
      { moduleId: "org.example.javascript-starter", version: "1.0.0" },
      { moduleId: "org.example.beacon", version: "1.0.0" },
    ],
  };
  const lock = await createProjectLock(store, project);
  const activation = await activateProject(store, project, lock, {
    maxSnapshotBytes: 8 * 1024 * 1024,
    javascript: "trusted-in-process",
    backendOptions: limits,
  });
  try {
    assert.equal(activation.ok, true, activation.composition.diagnostics.map((item) => item.message).join("\n"));
    assert.equal(activation.composition.backendId, "cross");
    assert.equal(activation.composition.limitsEnforced, true);
    assert.deepEqual([...activation.composition.grants], ["filesystem", "network", "os"]);
    assert.equal(activation.javascriptTrust, "trusted-in-process");
    assert.deepEqual(activation.modules.map((item) => item.runtime), ["javascript-esm", "wasm-core"]);
    const lease = JSON.parse(readFileSync(join(store, ".cgp-store.composition-leases", activation.leaseId + ".json"), "utf8")) as { digests: string[] };
    assert.equal(lease.digests.includes(wasm.entry.packageTreeDigest), true);
    assert.equal(lease.digests.includes(javascript.entry.packageTreeDigest), true);
    const applied = await applyLocalStoreGarbageCollection(store, { gracePeriodMs: 0, now: later() });
    assert.equal(applied.deleted.includes(extra.entry.packageTreeDigest), true);
    assert.equal(applied.deleted.includes(wasm.entry.packageTreeDigest), false);
    assert.equal(applied.deleted.includes(javascript.entry.packageTreeDigest), false);
    assert.equal(existsSync(wasm.objectDirectory), true);
    assert.equal(existsSync(javascript.objectDirectory), true);
  } finally {
    await activation.shutdown();
  }
  assert.deepEqual(leaseNames(store), []);
  const removed = await applyLocalStoreGarbageCollection(store, { gracePeriodMs: 0, now: later() });
  assert.equal(removed.deleted.includes(wasm.entry.packageTreeDigest), true);
  assert.equal(removed.deleted.includes(javascript.entry.packageTreeDigest), true);
  assert.match(readFileSync(join(store, "catalog.json"), "utf8"), /org\.example\.beacon/);
});

test("rejects a bad lock before leasing and reports a failed Wasm budget without keeping the lease", async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  const wasm = await registerStagedPackage(wasmPackage, store);
  const project = { profileId: "org.example.wasm-general", name: "Wasm", modules: [{ moduleId: "org.example.beacon", version: "1.0.0" }] };
  const lock = await createProjectLock(store, project);
  const missing = {
    ...lock,
    modules: [{ ...lock.modules[0]!, moduleId: "org.example.missing" }],
  };
  await assert.rejects(activateProject(store, project, missing, { maxSnapshotBytes: 1024 * 1024 }), /differs from the project profile|not registered|validation failed/);
  const unsupported = { ...lock, modules: [{ ...lock.modules[0]!, runtime: "python" }] };
  await assert.rejects(activateProject(store, project, unsupported, { maxSnapshotBytes: 1024 * 1024 }), /validation failed|invalid release identity/);
  assert.deepEqual(leaseNames(store), []);
  const activation = await activateProject(store, project, lock, {
    maxSnapshotBytes: 8 * 1024 * 1024,
    backendOptions: { ...limits, maxBinaryBytes: 1 },
  });
  assert.equal(activation.ok, false);
  assert.equal(activation.composition.backendId, "wasm-isolate");
  assert.equal("javascriptTrust" in activation, false);
  assert.deepEqual(leaseNames(store), []);
  assert.equal((await activation.shutdown()).already, true);
  assert.equal(existsSync(wasm.objectDirectory), true);
});

test("a failed lease release stays visible and can be retried", async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  const staging = await stageJavaScript(root, "org.example.retry", "export const implementation = {};\n");
  await registerStagedPackage(staging, store);
  const project = { profileId: "org.example.retry-project", name: "Retry", modules: [{ moduleId: "org.example.retry", version: "1.0.0" }] };
  const lock = await createProjectLock(store, project);
  const activation = await activateProject(store, project, lock, { maxSnapshotBytes: 1024 * 1024, javascript: "trusted-in-process" });
  const directory = join(store, ".cgp-store.composition-leases");
  const leasePath = join(directory, activation.leaseId + ".json");
  const saved = readFileSync(leasePath);
  rmSync(leasePath);
  mkdirSync(leasePath);
  try {
    await assert.rejects(activation.shutdown(), /regular file|composition lease/);
    assert.equal(existsSync(leasePath), true);
  } finally {
    rmSync(leasePath, { recursive: true, force: true });
    writeFileSync(leasePath, saved);
  }
  const stopped = await activation.shutdown();
  assert.equal(stopped.already, false);
  assert.deepEqual(leaseNames(store), []);
  assert.equal((await activation.shutdown()).already, true);
});
