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
import { previewLocalStoreGarbageCollection, registerStagedPackage, removeLocalRetentionPin, applyLocalStoreGarbageCollection } from "./local-store.ts";
import { createProjectLock } from "./project-lock.ts";
import { activateWasmProject } from "./wasm-activation.ts";
import { resourceActivationGuest } from "../foundations/wasm-build.ts";

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

const resourceLimits = { maxHookMs: 1000, maxMemoryBytes: 65536, maxBinaryBytes: 65536 };
const resourcePolicy = { allowGrants: [] as const, allowCapabilities: ["cgp.resource.read"] };

function stageResource(root: string, moduleId: string, note: string, contributionId: string): string {
  const directory = join(root, moduleId.replaceAll(".", "-"));
  mkdirSync(directory, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(wasmPackage, "manifest.json"), "utf8")) as {
    moduleId: string;
    name: string;
    permissions?: string[];
  };
  manifest.moduleId = moduleId;
  manifest.name = moduleId;
  manifest.permissions = ["cgp.resource.read"];
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(directory, "cgp-package.json"), readFileSync(join(wasmPackage, "cgp-package.json")));
  writeFileSync(join(directory, "module.wasm"), resourceActivationGuest(contributionId));
  writeFileSync(join(directory, "note.txt"), note);
  writeFileSync(join(directory, "README.md"), "Activation fixture for " + moduleId + "\n");
  return directory;
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

function assertPack(
  payload: unknown,
  note: string,
  wasm: Uint8Array,
): void {
  assert.ok(payload && typeof payload === "object");
  const row = payload as { noteLength: string; noteHex: string; wasmLength: string; wasmPrefix: string; foreign: string };
  const noteBytes = Buffer.from(note, "utf8");
  assert.equal(Number(row.noteLength), noteBytes.byteLength);
  assert.equal(row.noteHex.slice(0, noteBytes.byteLength * 2), noteBytes.toString("hex"));
  assert.equal(Number(row.wasmLength), wasm.byteLength);
  assert.equal(row.wasmPrefix, Buffer.from(wasm.subarray(0, 16)).toString("hex"));
  assert.equal(Number(row.foreign), 2);
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

test("a permitted Wasm guest reads its own verified package through activateWasmProject", async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  const note = "alpha-note";
  const staged = stageResource(root, "org.example.reader", note, "alpha");
  const wasm = readFileSync(join(staged, "module.wasm"));
  const registered = await registerStagedPackage(staged, store);
  const project = profile("org.example.reader", "org.example.reader-project");
  const lock = await createProjectLock(store, project);
  const activation = await activateWasmProject(store, project, lock, {
    maxSnapshotBytes: packageByteLength(staged),
    policy: resourcePolicy,
    backendOptions: resourceLimits,
  });
  try {
    assert.equal(activation.ok, true, activation.composition.diagnostics.map((item) => item.message).join("\n"));
    const contribution = activation.composition.contributions.find((item) => item.moduleId === "org.example.reader" && item.id === "alpha");
    assert.ok(contribution);
    assertPack(contribution.payload, note, wasm);
    chmodSync(join(registered.objectDirectory, "note.txt"), 0o644);
    writeFileSync(join(registered.objectDirectory, "note.txt"), "rewritten-after-activation");
    const stopped = await activation.shutdown();
    assert.equal(stopped.already, false);
    assert.deepEqual(stopped.diagnostics, []);
    assert.ok(stopped.order.includes("org.example.reader"));
    assert.equal(activation.composition.quiesced, true);
    assert.equal(existsSync(join(store, ".cgp-store.composition-leases", activation.leaseId + ".json")), false);
  } finally {
    await activation.shutdown();
  }
});

test("two resource guests cannot read each other's files at the same relative path", async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  const firstStage = stageResource(root, "org.example.reader-a", "alpha-note", "alpha");
  const secondStage = stageResource(root, "org.example.reader-b", "beta-note", "beta");
  const firstWasm = readFileSync(join(firstStage, "module.wasm"));
  const secondWasm = readFileSync(join(secondStage, "module.wasm"));
  await registerStagedPackage(firstStage, store);
  await registerStagedPackage(secondStage, store);
  const project = {
    profileId: "org.example.two-readers",
    name: "Two Readers",
    modules: [
      { moduleId: "org.example.reader-a", version: "1.0.0" },
      { moduleId: "org.example.reader-b", version: "1.0.0" },
    ],
  };
  const lock = await createProjectLock(store, project);
  const activation = await activateWasmProject(store, project, lock, {
    maxSnapshotBytes: packageByteLength(firstStage) + packageByteLength(secondStage),
    policy: resourcePolicy,
    backendOptions: resourceLimits,
  });
  try {
    assert.equal(activation.ok, true, activation.composition.diagnostics.map((item) => item.message).join("\n"));
    const alpha = activation.composition.contributions.find((item) => item.id === "alpha");
    const beta = activation.composition.contributions.find((item) => item.id === "beta");
    assert.ok(alpha && beta);
    assertPack(alpha.payload, "alpha-note", firstWasm);
    assertPack(beta.payload, "beta-note", secondWasm);
    assert.notEqual(
      (alpha.payload as { noteHex: string }).noteHex,
      (beta.payload as { noteHex: string }).noteHex,
    );
  } finally {
    await activation.shutdown();
  }
});

test("a package without resource_read does not need or receive a resource pack", async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  const directory = join(root, "plain");
  mkdirSync(directory);
  for (const name of ["manifest.json", "cgp-package.json", "module.wasm", "guest.json"] as const) {
    writeFileSync(join(directory, name), readFileSync(join(wasmPackage, name)));
  }
  writeFileSync(join(directory, "note.txt"), "not-a-resource");
  await registerStagedPackage(directory, store);
  const project = profile("org.example.beacon", "org.example.plain-pack");
  const lock = await createProjectLock(store, project);
  const activation = await activateWasmProject(store, project, lock, {
    maxSnapshotBytes: packageByteLength(directory),
    backendOptions: resourceLimits,
  });
  try {
    assert.equal(activation.ok, true, activation.composition.diagnostics.map((item) => item.message).join("\n"));
    const beacon = activation.composition.contributions.find((item) => item.id === "beacon");
    assert.deepEqual(beacon?.payload, { systemId: "beacon", label: "Beacon" });
    assert.equal(activation.composition.contributions.some((item) => item.id === "alpha"), false);
    assert.equal(JSON.stringify(activation.composition.contributions).includes("not-a-resource"), false);
  } finally {
    await activation.shutdown();
  }
});

test("missing resource policy refuses activation without a running guest or lease", async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  const staged = stageResource(root, "org.example.reader", "alpha-note", "alpha");
  await registerStagedPackage(staged, store);
  const project = profile("org.example.reader", "org.example.reader-denied");
  const lock = await createProjectLock(store, project);
  const activation = await activateWasmProject(store, project, lock, {
    maxSnapshotBytes: packageByteLength(staged),
    backendOptions: resourceLimits,
  });
  assert.equal(activation.ok, false);
  assert.equal(activation.composition.runtimeActive, false);
  assert.ok(activation.composition.diagnostics.some((item) => /not granted/i.test(item.message)));
  assert.equal(activation.composition.contributions.length, 0);
  assert.deepEqual(readdirSync(join(store, ".cgp-store.composition-leases")), []);
  assert.equal((await activation.shutdown()).already, true);
});

test("a corrupt later package prevents Wasm activation and releases the lease", async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  const first = stageResource(root, "org.example.reader-a", "alpha-note", "alpha");
  const second = stageResource(root, "org.example.reader-b", "beta-note", "beta");
  await registerStagedPackage(first, store);
  const registeredSecond = await registerStagedPackage(second, store);
  const project = {
    profileId: "org.example.corrupt-later",
    name: "Corrupt Later",
    modules: [
      { moduleId: "org.example.reader-a", version: "1.0.0" },
      { moduleId: "org.example.reader-b", version: "1.0.0" },
    ],
  };
  const lock = await createProjectLock(store, project);
  chmodSync(join(registeredSecond.objectDirectory, "note.txt"), 0o644);
  writeFileSync(join(registeredSecond.objectDirectory, "note.txt"), "tampered");
  await assert.rejects(
    activateWasmProject(store, project, lock, {
      maxSnapshotBytes: 8 * 1024 * 1024,
      policy: resourcePolicy,
      backendOptions: resourceLimits,
    }),
    /Package object directory digest does not match|Stored package bytes differ from the exact lock identity/,
  );
  const leases = join(store, ".cgp-store.composition-leases");
  assert.equal(existsSync(leases) && readdirSync(leases).length > 0, false);
});

test("separate activations do not charge each other's resource packs", async (t) => {
  const root = fixture(t);
  const store = join(root, "store");
  const firstStage = stageResource(root, "org.example.reader-a", "alpha-note", "alpha");
  const secondStage = stageResource(root, "org.example.reader-b", "beta-note", "beta");
  const firstWasm = readFileSync(join(firstStage, "module.wasm"));
  const secondWasm = readFileSync(join(secondStage, "module.wasm"));
  await registerStagedPackage(firstStage, store);
  await registerStagedPackage(secondStage, store);
  const firstProject = profile("org.example.reader-a", "org.example.reader-a-project");
  const secondProject = profile("org.example.reader-b", "org.example.reader-b-project");
  const firstLock = await createProjectLock(store, firstProject);
  const secondLock = await createProjectLock(store, secondProject);
  const first = await activateWasmProject(store, firstProject, firstLock, {
    maxSnapshotBytes: packageByteLength(firstStage),
    policy: resourcePolicy,
    backendOptions: resourceLimits,
  });
  const second = await activateWasmProject(store, secondProject, secondLock, {
    maxSnapshotBytes: packageByteLength(secondStage),
    policy: resourcePolicy,
    backendOptions: resourceLimits,
  });
  try {
    assert.equal(first.ok, true, first.composition.diagnostics.map((item) => item.message).join("\n"));
    assert.equal(second.ok, true, second.composition.diagnostics.map((item) => item.message).join("\n"));
    assertPack(first.composition.contributions.find((item) => item.id === "alpha")?.payload, "alpha-note", firstWasm);
    assertPack(second.composition.contributions.find((item) => item.id === "beta")?.payload, "beta-note", secondWasm);
  } finally {
    await first.shutdown();
    await second.shutdown();
  }
});
