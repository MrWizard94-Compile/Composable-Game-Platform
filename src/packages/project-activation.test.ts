import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applyLocalStoreGarbageCollection, previewLocalStoreGarbageCollection, registerStagedPackage, removeLocalRetentionPin } from "./local-store.ts";
import { createProjectLock } from "./project-lock.ts";
import { buildReleasePackage } from "./release-pipeline.ts";
import { activateProject, platformJavascriptCleanupSupported, setProjectActivationTestProbes } from "./project-activation.ts";
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
function removeSymlink(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code === "EPERM" || code === "EISDIR" || code === "EACCES") {
      rmdirSync(path);
      return;
    }
    throw error;
  }
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
async function rejectedShutdown(shutdown: () => Promise<{ already: boolean }>): Promise<string> {
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

test("retries source cleanup until the owned directory is removable and does not follow symlinks", { skip: process.platform === "win32" ? "Windows does not implement POSIX owner mode bits; removal failure is injected separately" : false }, async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  const dirMarker = join(root, "source-dir");
  const shutdownMarker = join(root, "shutdown");
  const sentinel = join(root, "sentinel.txt");
  const sentinelDir = join(root, "sentinel-dir");
  writeFileSync(sentinel, "keep-file");
  mkdirSync(sentinelDir);
  writeFileSync(join(sentinelDir, "keep.txt"), "keep-dir");
  const source = [
    "import { appendFileSync, chmodSync, symlinkSync, writeFileSync } from \"node:fs\";",
    "import { dirname } from \"node:path\";",
    "import { fileURLToPath } from \"node:url\";",
    "const here = dirname(fileURLToPath(import.meta.url));",
    "const dirMarker = process.env.CGP_SOURCE_CLEANUP_DIR;",
    "const shutdownMarker = process.env.CGP_SOURCE_CLEANUP_SHUTDOWN;",
    "const sentinelFile = process.env.CGP_SOURCE_CLEANUP_SENTINEL;",
    "const sentinelDir = process.env.CGP_SOURCE_CLEANUP_SENTINEL_DIR;",
    "if (dirMarker) writeFileSync(dirMarker, here);",
    "if (sentinelFile) symlinkSync(sentinelFile, here + \"/escape-file\", \"file\");",
    "if (sentinelDir) symlinkSync(sentinelDir, here + \"/escape-dir\", \"dir\");",
    "export const implementation = {",
    "  shutdown() {",
    "    if (shutdownMarker) appendFileSync(shutdownMarker, \"x\");",
    "    chmodSync(here, 0o555);",
    "  },",
    "};",
    "",
  ].join("\n");
  const staging = await stageJavaScript(root, "org.example.cleanup", source);
  await registerStagedPackage(staging, store);
  const project = { profileId: "org.example.cleanup-project", name: "Cleanup", modules: [{ moduleId: "org.example.cleanup", version: "1.0.0" }] };
  const lock = await createProjectLock(store, project);
  process.env.CGP_SOURCE_CLEANUP_DIR = dirMarker;
  process.env.CGP_SOURCE_CLEANUP_SHUTDOWN = shutdownMarker;
  process.env.CGP_SOURCE_CLEANUP_SENTINEL = sentinel;
  process.env.CGP_SOURCE_CLEANUP_SENTINEL_DIR = sentinelDir;
  let tempDir = "";
  let activation: Awaited<ReturnType<typeof activateProject>> | undefined;
  try {
    activation = await activateProject(store, project, lock, { maxSnapshotBytes: 1024 * 1024, javascript: "trusted-in-process" });
    tempDir = readFileSync(dirMarker, "utf8");
    assert.equal(existsSync(join(tempDir, "escape-file")), true);
    assert.equal(lstatSync(join(tempDir, "escape-dir")).isSymbolicLink(), true);
    const directory = join(store, ".cgp-store.composition-leases");
    const leasePath = join(directory, activation.leaseId + ".json");
    const saved = readFileSync(leasePath);
    rmSync(leasePath);
    mkdirSync(leasePath);
    const first = await rejectedShutdown(activation.shutdown);
    assert.match(first, /permissions \(555\)/);
    assert.match(first, /Composition lease must be a regular file/);
    assert.equal((lstatSync(tempDir).mode & 0o777), 0o555);
    assert.equal(existsSync(leasePath), true);
    assert.equal(readFileSync(sentinel, "utf8"), "keep-file");
    assert.equal(readFileSync(join(sentinelDir, "keep.txt"), "utf8"), "keep-dir");
    const second = await rejectedShutdown(activation.shutdown);
    assert.match(second, /permissions \(555\)/);
    assert.match(second, /Composition lease must be a regular file/);
    assert.equal(readFileSync(shutdownMarker, "utf8"), "x");
    rmSync(leasePath, { recursive: true, force: true });
    writeFileSync(leasePath, saved);
    const third = await rejectedShutdown(activation.shutdown);
    assert.match(third, /permissions \(555\)/);
    assert.equal(/regular file/.test(third), false);
    assert.equal(existsSync(tempDir), true);
    assert.deepEqual(leaseNames(store), []);
    assert.equal(readFileSync(sentinel, "utf8"), "keep-file");
    const fourth = await rejectedShutdown(activation.shutdown);
    assert.match(fourth, /permissions \(555\)/);
    chmodSync(tempDir, 0o755);
    const stopped = await activation.shutdown();
    assert.equal(stopped.already, false);
    assert.equal(existsSync(tempDir), false);
    tempDir = "";
    assert.equal(readFileSync(sentinel, "utf8"), "keep-file");
    assert.equal(readFileSync(join(sentinelDir, "keep.txt"), "utf8"), "keep-dir");
    assert.equal(readFileSync(shutdownMarker, "utf8"), "x");
    assert.equal((await activation.shutdown()).already, true);
  } finally {
    delete process.env.CGP_SOURCE_CLEANUP_DIR;
    delete process.env.CGP_SOURCE_CLEANUP_SHUTDOWN;
    delete process.env.CGP_SOURCE_CLEANUP_SENTINEL;
    delete process.env.CGP_SOURCE_CLEANUP_SENTINEL_DIR;
    if (tempDir && existsSync(tempDir)) {
      const info = lstatSync(tempDir);
      if (info.isSymbolicLink()) unlinkSync(tempDir);
      else {
        chmodSync(tempDir, 0o755);
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
    if (activation) await activation.shutdown().catch(() => undefined);
  }
});

test("source cleanup does not follow a symlink swapped in for the activation directory", async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  const dirMarker = join(root, "source-dir");
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.txt"), "keep");
  const source = [
    "import { writeFileSync } from \"node:fs\";",
    "import { dirname } from \"node:path\";",
    "import { fileURLToPath } from \"node:url\";",
    "const marker = process.env.CGP_SOURCE_LINK_DIR;",
    "if (marker) writeFileSync(marker, dirname(fileURLToPath(import.meta.url)));",
    "export const implementation = {};",
    "",
  ].join("\n");
  const staging = await stageJavaScript(root, "org.example.linkswap", source);
  await registerStagedPackage(staging, store);
  const project = { profileId: "org.example.linkswap-project", name: "Link", modules: [{ moduleId: "org.example.linkswap", version: "1.0.0" }] };
  const lock = await createProjectLock(store, project);
  process.env.CGP_SOURCE_LINK_DIR = dirMarker;
  let tempDir = "";
  let parked = "";
  let activation: Awaited<ReturnType<typeof activateProject>> | undefined;
  try {
    activation = await activateProject(store, project, lock, { maxSnapshotBytes: 1024 * 1024, javascript: "trusted-in-process" });
    tempDir = readFileSync(dirMarker, "utf8");
    parked = tempDir + "-parked";
    renameSync(tempDir, parked);
    symlinkSync(outside, tempDir, "dir");
    const first = await rejectedShutdown(activation.shutdown);
    assert.match(first, /refuses to follow a symlink/);
    assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "keep");
    assert.equal(existsSync(join(parked, "0.mjs")), true);
    assert.deepEqual(leaseNames(store), []);
    const second = await rejectedShutdown(activation.shutdown);
    assert.match(second, /refuses to follow a symlink/);
    assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "keep");
    removeSymlink(tempDir);
    renameSync(parked, tempDir);
    parked = "";
    const stopped = await activation.shutdown();
    assert.equal(stopped.already, false);
    assert.equal(existsSync(tempDir), false);
    tempDir = "";
    assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "keep");
    assert.equal((await activation.shutdown()).already, true);
  } finally {
    delete process.env.CGP_SOURCE_LINK_DIR;
    if (tempDir && existsSync(tempDir)) {
      const info = lstatSync(tempDir);
      if (info.isSymbolicLink()) removeSymlink(tempDir);
      else rmSync(tempDir, { recursive: true, force: true });
    }
    if (parked && existsSync(parked)) rmSync(parked, { recursive: true, force: true });
    if (activation) await activation.shutdown().catch(() => undefined);
  }
});

test("reports the cleanup platforms without treating Windows or macOS as an fd walk", () => {
  assert.equal(platformJavascriptCleanupSupported("win32"), true);
  assert.equal(platformJavascriptCleanupSupported("darwin"), true);
  assert.equal(platformJavascriptCleanupSupported("freebsd"), false);
  assert.equal(platformJavascriptCleanupSupported("aix"), false);
  assert.equal(platformJavascriptCleanupSupported(process.platform), true);
});

test("an injected source-removal failure stays retryable and does not report already", async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  const dirMarker = join(root, "source-dir");
  const source = [
    "import { writeFileSync } from \"node:fs\";",
    "import { dirname } from \"node:path\";",
    "import { fileURLToPath } from \"node:url\";",
    "const marker = process.env.CGP_INJECTED_SOURCE_DIR;",
    "if (marker) writeFileSync(marker, dirname(fileURLToPath(import.meta.url)));",
    "export const implementation = {};",
    "",
  ].join("\n");
  const staging = await stageJavaScript(root, "org.example.injected", source);
  await registerStagedPackage(staging, store);
  const project = { profileId: "org.example.injected-project", name: "Injected", modules: [{ moduleId: "org.example.injected", version: "1.0.0" }] };
  const lock = await createProjectLock(store, project);
  process.env.CGP_INJECTED_SOURCE_DIR = dirMarker;
  setProjectActivationTestProbes({
    beforeRemoveSources() { throw new Error("injected-source-removal-failure"); },
  });
  let tempDir = "";
  let activation: Awaited<ReturnType<typeof activateProject>> | undefined;
  try {
    activation = await activateProject(store, project, lock, { maxSnapshotBytes: 1024 * 1024, javascript: "trusted-in-process" });
    tempDir = readFileSync(dirMarker, "utf8");
    const first = await rejectedShutdown(activation.shutdown);
    assert.match(first, /injected-source-removal-failure/);
    assert.equal(/already/i.test(first), false);
    assert.equal(existsSync(join(tempDir, "0.mjs")), true);
    const second = await rejectedShutdown(activation.shutdown);
    assert.match(second, /injected-source-removal-failure/);
    assert.equal(existsSync(join(tempDir, "0.mjs")), true);
    setProjectActivationTestProbes(undefined);
    const stopped = await activation.shutdown();
    assert.equal(stopped.already, false);
    assert.equal(existsSync(tempDir), false);
    tempDir = "";
    assert.deepEqual(leaseNames(store), []);
    assert.equal((await activation.shutdown()).already, true);
  } finally {
    delete process.env.CGP_INJECTED_SOURCE_DIR;
    setProjectActivationTestProbes(undefined);
    if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    if (activation) await activation.shutdown().catch(() => undefined);
  }
});

test("removes symlink entries inside the activation directory without deleting their targets", async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  const dirMarker = join(root, "source-dir");
  const sentinel = join(root, "sentinel.txt");
  const sentinelDir = join(root, "sentinel-dir");
  writeFileSync(sentinel, "keep-file");
  mkdirSync(sentinelDir);
  writeFileSync(join(sentinelDir, "keep.txt"), "keep-dir");
  const source = [
    "import { symlinkSync, writeFileSync } from \"node:fs\";",
    "import { dirname } from \"node:path\";",
    "import { fileURLToPath } from \"node:url\";",
    "const here = dirname(fileURLToPath(import.meta.url));",
    "const dirMarker = process.env.CGP_CHILD_LINK_DIR;",
    "const sentinelFile = process.env.CGP_CHILD_LINK_FILE;",
    "const sentinelDirectory = process.env.CGP_CHILD_LINK_DIR_TARGET;",
    "if (dirMarker) writeFileSync(dirMarker, here);",
    "if (sentinelFile) symlinkSync(sentinelFile, here + \"/escape-file\", \"file\");",
    "if (sentinelDirectory) symlinkSync(sentinelDirectory, here + \"/escape-dir\", \"dir\");",
    "export const implementation = {};",
    "",
  ].join("\n");
  const staging = await stageJavaScript(root, "org.example.childlink", source);
  await registerStagedPackage(staging, store);
  const project = { profileId: "org.example.childlink-project", name: "Child", modules: [{ moduleId: "org.example.childlink", version: "1.0.0" }] };
  const lock = await createProjectLock(store, project);
  process.env.CGP_CHILD_LINK_DIR = dirMarker;
  process.env.CGP_CHILD_LINK_FILE = sentinel;
  process.env.CGP_CHILD_LINK_DIR_TARGET = sentinelDir;
  let tempDir = "";
  let activation: Awaited<ReturnType<typeof activateProject>> | undefined;
  try {
    activation = await activateProject(store, project, lock, { maxSnapshotBytes: 1024 * 1024, javascript: "trusted-in-process" });
    tempDir = readFileSync(dirMarker, "utf8");
    assert.equal(lstatSync(join(tempDir, "escape-file")).isSymbolicLink(), true);
    assert.equal(lstatSync(join(tempDir, "escape-dir")).isSymbolicLink(), true);
    const stopped = await activation.shutdown();
    assert.equal(stopped.already, false);
    assert.equal(existsSync(tempDir), false);
    tempDir = "";
    assert.equal(readFileSync(sentinel, "utf8"), "keep-file");
    assert.equal(readFileSync(join(sentinelDir, "keep.txt"), "utf8"), "keep-dir");
    assert.deepEqual(leaseNames(store), []);
    assert.equal((await activation.shutdown()).already, true);
  } finally {
    delete process.env.CGP_CHILD_LINK_DIR;
    delete process.env.CGP_CHILD_LINK_FILE;
    delete process.env.CGP_CHILD_LINK_DIR_TARGET;
    if (tempDir && existsSync(tempDir)) {
      const info = lstatSync(tempDir);
      if (info.isSymbolicLink()) removeSymlink(tempDir);
      else rmSync(tempDir, { recursive: true, force: true });
    }
    if (activation) await activation.shutdown().catch(() => undefined);
  }
});

test("concurrent shutdown shares one cleanup and does not double-release", async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  const marker = join(root, "shutdown");
  const source = [
    "import { appendFileSync } from \"node:fs\";",
    "export const implementation = {",
    "  async shutdown() {",
    "    await globalThis.__cgpConcurrentGate;",
    "    const marker = process.env.CGP_CONCURRENT_SHUTDOWN;",
    "    if (marker) appendFileSync(marker, \"x\");",
    "  },",
    "};",
    "",
  ].join("\n");
  const staging = await stageJavaScript(root, "org.example.concurrent", source);
  await registerStagedPackage(staging, store);
  const project = { profileId: "org.example.concurrent-project", name: "Concurrent", modules: [{ moduleId: "org.example.concurrent", version: "1.0.0" }] };
  const lock = await createProjectLock(store, project);
  process.env.CGP_CONCURRENT_SHUTDOWN = marker;
  let release = () => {};
  (globalThis as { __cgpConcurrentGate?: Promise<void> }).__cgpConcurrentGate = new Promise((done) => { release = done; });
  let activation: Awaited<ReturnType<typeof activateProject>> | undefined;
  try {
    activation = await activateProject(store, project, lock, { maxSnapshotBytes: 1024 * 1024, javascript: "trusted-in-process" });
    const first = activation.shutdown();
    const second = activation.shutdown();
    assert.equal(first, second);
    release();
    const stopped = await first;
    assert.equal(stopped.already, false);
    assert.equal(await second, stopped);
    assert.equal(readFileSync(marker, "utf8"), "x");
    assert.deepEqual(leaseNames(store), []);
    assert.equal((await activation.shutdown()).already, true);
    assert.equal(readFileSync(marker, "utf8"), "x");
  } finally {
    delete process.env.CGP_CONCURRENT_SHUTDOWN;
    delete (globalThis as { __cgpConcurrentGate?: Promise<void> }).__cgpConcurrentGate;
    release();
    if (activation) await activation.shutdown().catch(() => undefined);
  }
});

test("backend disposal and lease release failures stay independent and retryable", async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  const staging = await stageJavaScript(root, "org.example.dispose", "export const implementation = {};\n");
  await registerStagedPackage(staging, store);
  const project = { profileId: "org.example.dispose-project", name: "Dispose", modules: [{ moduleId: "org.example.dispose", version: "1.0.0" }] };
  const lock = await createProjectLock(store, project);
  const activation = await activateProject(store, project, lock, { maxSnapshotBytes: 1024 * 1024, javascript: "trusted-in-process" });
  const leasePath = join(store, ".cgp-store.composition-leases", activation.leaseId + ".json");
  const saved = readFileSync(leasePath);
  setProjectActivationTestProbes({
    beforeDisposeBackend() { throw new Error("injected-dispose-failure"); },
  });
  try {
    rmSync(leasePath);
    mkdirSync(leasePath);
    const first = await rejectedShutdown(activation.shutdown);
    assert.match(first, /injected-dispose-failure/);
    assert.match(first, /Composition lease must be a regular file/);
    assert.equal(/already/i.test(first), false);
    setProjectActivationTestProbes(undefined);
    const second = await rejectedShutdown(activation.shutdown);
    assert.match(second, /Composition lease must be a regular file/);
    assert.equal(/injected-dispose-failure/.test(second), false);
    rmSync(leasePath, { recursive: true, force: true });
    writeFileSync(leasePath, saved);
    const stopped = await activation.shutdown();
    assert.equal(stopped.already, false);
    assert.deepEqual(leaseNames(store), []);
    assert.equal((await activation.shutdown()).already, true);
  } finally {
    setProjectActivationTestProbes(undefined);
    if (existsSync(leasePath)) {
      const info = lstatSync(leasePath);
      if (info.isDirectory()) rmSync(leasePath, { recursive: true, force: true });
    }
    await activation.shutdown().catch(() => undefined);
  }
});

test("refuses JavaScript before import when source cleanup cannot be supported", async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  const marker = join(root, "marker");
  const staging = await stageJavaScript(root, "org.example.unsupported", markerSource("ran"));
  await registerStagedPackage(staging, store);
  const project = { profileId: "org.example.unsupported-project", name: "Unsupported", modules: [{ moduleId: "org.example.unsupported", version: "1.0.0" }] };
  const lock = await createProjectLock(store, project);
  process.env.CGP_ACTIVATION_MARKER = marker;
  setProjectActivationTestProbes({ cleanupSupported: false });
  try {
    await assert.rejects(
      activateProject(store, project, lock, { maxSnapshotBytes: 1024 * 1024, javascript: "trusted-in-process" }),
      /No composition lease was acquired and JavaScript was not imported/,
    );
    assert.equal(existsSync(marker), false);
    assert.deepEqual(leaseNames(store), []);
  } finally {
    delete process.env.CGP_ACTIVATION_MARKER;
    setProjectActivationTestProbes(undefined);
  }

  setProjectActivationTestProbes({ cleanupSupported: false });
  process.env.CGP_ACTIVATION_MARKER = marker;
  try {
    const closed = await activateProject(store, project, lock, {
      maxSnapshotBytes: 1024 * 1024,
      javascript: "trusted-in-process",
      policy: CLOSED_POLICY,
    });
    assert.equal(closed.ok, false);
    assert.equal(existsSync(marker), false);
    assert.deepEqual(leaseNames(store), []);
    assert.equal((await closed.shutdown()).already, true);
  } finally {
    delete process.env.CGP_ACTIVATION_MARKER;
    setProjectActivationTestProbes(undefined);
  }

  const wasm = await registerStagedPackage(wasmPackage, store);
  const wasmProject = { profileId: "org.example.unsupported-wasm", name: "Wasm", modules: [{ moduleId: "org.example.beacon", version: "1.0.0" }] };
  const wasmLock = await createProjectLock(store, wasmProject);
  setProjectActivationTestProbes({ cleanupSupported: false });
  try {
    const activation = await activateProject(store, wasmProject, wasmLock, { maxSnapshotBytes: 8 * 1024 * 1024 });
    assert.equal(activation.ok, true, activation.composition.diagnostics.map((item) => item.message).join("\n"));
    assert.equal(existsSync(wasm.objectDirectory), true);
    await activation.shutdown();
    assert.deepEqual(leaseNames(store), []);
  } finally {
    setProjectActivationTestProbes(undefined);
  }
});
