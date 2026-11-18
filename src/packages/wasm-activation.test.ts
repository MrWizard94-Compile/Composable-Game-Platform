import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { previewLocalStoreGarbageCollection, registerStagedPackage, removeLocalRetentionPin, applyLocalStoreGarbageCollection } from "./local-store.ts";
import { createProjectLock } from "./project-lock.ts";
import { activateWasmProject } from "./wasm-activation.ts";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const wasmPackage = join(repositoryRoot, "examples/third-party-module");
const javascriptPackage = join(repositoryRoot, "examples/javascript-module");

function fixture(t: { after(callback: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), "cgp-wasm-activation-test-"));
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

function profile(moduleId: string, profileId = "org.example.activation-project") {
  return {
    profileId,
    name: "Activation Project",
    modules: [{ moduleId, version: "1.0.0" }],
  };
}

test("activates an exact Wasm lock through Foundations and releases the runtime on shutdown", async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  await registerStagedPackage(wasmPackage, store);

  const project = profile("org.example.beacon");
  const lock = await createProjectLock(store, project);
  const activation = await activateWasmProject(store, project, lock, {
    maxSnapshotBytes: 8 * 1024 * 1024,
    backendOptions: {
      maxHookMs: 1000,
      maxMemoryBytes: 65536,
      maxBinaryBytes: 65536,
    },
  });

  assert.equal(activation.ok, true, activation.composition.diagnostics.map((item) => item.message).join("\n"));
  assert.equal(activation.profileId, project.profileId);
  assert.equal(activation.composition.runtimeActive, true);
  assert.equal(activation.composition.backendId, "wasm-isolate");
  assert.equal(activation.composition.limitsEnforced, true);
  assert.deepEqual(activation.composition.grants, []);
  assert.equal(activation.modules.length, 1);
  assert.equal(activation.modules[0]!.moduleId, "org.example.beacon");
  assert.equal(activation.modules[0]!.packageTreeDigest, lock.modules[0]!.packageTreeDigest);
  assert.equal(activation.modules[0]!.runtime, "wasm-core");
  assert.ok(activation.totalSnapshotBytes > 0);
  assert.ok(activation.composition.contributions.length > 0);
  assert.match(activation.leaseId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(existsSync(join(store, ".cgp-store.composition-leases", activation.leaseId + ".json")), true);

  const stopped = await activation.shutdown();
  assert.equal(stopped.already, false);
  assert.ok(stopped.order.includes("org.example.beacon"));
  assert.equal(activation.composition.quiesced, true);
  assert.equal(existsSync(join(store, ".cgp-store.composition-leases", activation.leaseId + ".json")), false);

  // Both exposed shutdown paths share one idempotent cleanup owner.
  const repeated = await activation.composition.shutdown();
  assert.equal(repeated.already, true);
});

test("refuses a JavaScript lock before creating or starting a runtime", async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  await registerStagedPackage(javascriptPackage, store);

  const project = profile("org.example.javascript-starter", "org.example.js-project");
  const lock = await createProjectLock(store, project);

  await assert.rejects(
    activateWasmProject(store, project, lock, { maxSnapshotBytes: 8 * 1024 * 1024 }),
    /Wasm-only project snapshot refuses .*javascript-esm/,
  );
  assert.equal(existsSync(join(store, ".cgp-store.composition-leases")), false);
});

test("returns a failed activation and disposes the backend when runtime policy is invalid", async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  await registerStagedPackage(wasmPackage, store);

  const project = profile("org.example.beacon", "org.example.invalid-policy");
  const lock = await createProjectLock(store, project);
  const activation = await activateWasmProject(store, project, lock, {
    maxSnapshotBytes: 8 * 1024 * 1024,
    policy: { allowGrants: [], maxHookMs: 0 },
  });

  assert.equal(activation.ok, false);
  assert.equal(activation.composition.runtimeActive, false);
  assert.ok(activation.composition.diagnostics.some((item) => item.code === "trust.limits"));
  assert.equal(activation.composition.backendId, "wasm-isolate");
  assert.deepEqual(readdirSync(join(store, ".cgp-store.composition-leases")), []);

  // Failed compositions are cleaned up before the operation returns.
  const repeated = await activation.shutdown();
  assert.equal(repeated.already, true);
});

test("holds a composition lease until shutdown so GC cannot quarantine the live package", async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  const wasm = await registerStagedPackage(wasmPackage, store);
  const javascript = await registerStagedPackage(javascriptPackage, store);
  await removeLocalRetentionPin(store, wasm.entry.packageTreeDigest);
  await removeLocalRetentionPin(store, javascript.entry.packageTreeDigest);
  const project = profile("org.example.beacon", "org.example.leased-activation");
  const lock = await createProjectLock(store, project);
  const activation = await activateWasmProject(store, project, lock, {
    maxSnapshotBytes: 8 * 1024 * 1024,
    backendOptions: { maxHookMs: 1000, maxMemoryBytes: 65536, maxBinaryBytes: 65536 },
  });
  const when = new Date(Date.now() + 60_000);
  try {
    assert.equal(activation.ok, true, activation.composition.diagnostics.map((item) => item.message).join("\n"));
    assert.equal("token" in activation, false);
    const leasePath = join(store, ".cgp-store.composition-leases", activation.leaseId + ".json");
    const lease = JSON.parse(readFileSync(leasePath, "utf8")) as { schema: string; token: string; digests: string[] };
    assert.equal(lease.schema, "cgp.store-composition-lease/1");
    assert.equal(lease.digests.includes(wasm.entry.packageTreeDigest), true);
    assert.equal(JSON.stringify(activation).includes(lease.token), false);
    const preview = await previewLocalStoreGarbageCollection(store, { gracePeriodMs: 0, now: when });
    const retained = preview.objects.find((item) => item.digest === wasm.entry.packageTreeDigest);
    assert.equal(retained?.status, "retained");
    assert.deepEqual(retained?.retentionRoots, ["composition:" + activation.leaseId]);
    const applied = await applyLocalStoreGarbageCollection(store, { gracePeriodMs: 0, now: when });
    assert.equal(applied.deleted.includes(wasm.entry.packageTreeDigest), false);
    assert.equal(applied.deleted.includes(javascript.entry.packageTreeDigest), true);
    assert.equal(existsSync(wasm.objectDirectory), true);
    assert.equal(existsSync(javascript.objectDirectory), false);
    const stopped = await activation.shutdown();
    assert.equal(stopped.already, false);
  } finally {
    await activation.shutdown();
  }
  assert.equal(existsSync(join(store, ".cgp-store.composition-leases", activation.leaseId + ".json")), false);
  const after = await previewLocalStoreGarbageCollection(store, { gracePeriodMs: 0, now: when });
  assert.equal(after.candidates.some((item) => item.digest === wasm.entry.packageTreeDigest), true);
  const removed = await applyLocalStoreGarbageCollection(store, { gracePeriodMs: 0, now: when });
  assert.equal(removed.deleted.includes(wasm.entry.packageTreeDigest), true);
  assert.equal(existsSync(wasm.objectDirectory), false);
  assert.match(readFileSync(join(store, "catalog.json"), "utf8"), /org\.example\.beacon/);
});

test("releases the composition lease when the snapshot budget fails", async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  await registerStagedPackage(wasmPackage, store);
  const project = profile("org.example.beacon", "org.example.snapshot-budget");
  const lock = await createProjectLock(store, project);
  await assert.rejects(
    activateWasmProject(store, project, lock, { maxSnapshotBytes: 1 }),
    /Wasm snapshot failed .*byte limit/,
  );
  const directory = join(store, ".cgp-store.composition-leases");
  assert.equal(existsSync(directory), true);
  assert.deepEqual(readdirSync(directory), []);
});
