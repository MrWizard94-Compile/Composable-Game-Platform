import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { discoverModules, loadInProcessImplementations } from "./discover-node.ts";
import { compose, type ModulePackage } from "./host.ts";
import { IN_PROCESS_POLICY, type ExecutionPolicy } from "./backend.ts";
import { captureSave, restoreSave } from "./save.ts";
import { publish } from "./dispatch.ts";
import { createWasmBackend, inspectWasm } from "./wasm-backend.ts";
import {
  counterGuest,
  growGuest,
  hugeTableGuest,
  logGuest,
  loopingGuest,
  openTableGuest,
  readerGuest,
  sharedGuest,
  startLoopGuest,
  storeGuest,
  unboundedGuest,
  wasiGuest,
  wideGuest,
} from "./wasm-build.ts";

function manifest(moduleId: string, extra: Record<string, unknown> = {}) {
  return {
    moduleId,
    name: moduleId.split(".").at(-1) ?? moduleId,
    version: "1.0.0",
    moduleApi: ">=1.0.0 <2.0.0",
    ...extra,
  };
}

function wasmPolicy(extra: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  return { allowGrants: [], maxHookMs: 1000, maxMemoryBytes: 65536, ...extra };
}

function pkg(moduleId: string, wasm: Uint8Array, extra: Record<string, unknown> = {}, implementationExtra: Record<string, unknown> = {}): ModulePackage {
  return { manifest: manifest(moduleId, extra), implementation: { wasm, ...implementationExtra } };
}

describe("isolated wasm execution", () => {
  it("does not import or instantiate during discovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "cgp-discover-"));
    const folder = join(root, "trap");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(folder);
    writeFileSync(
      join(folder, "module.ts"),
      "globalThis.__cgDiscoveryRan = true; throw new Error('discovery executed module code');\n",
    );
    writeFileSync(join(folder, "manifest.json"), JSON.stringify(manifest("org.example.trap")));
    writeFileSync(join(folder, "module.wasm"), startLoopGuest());
    delete (globalThis as { __cgDiscoveryRan?: boolean }).__cgDiscoveryRan;
    const discovered = await Promise.race([
      discoverModules(root),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("discovery executed a module")), 1000)),
    ]);
    assert.equal((globalThis as { __cgDiscoveryRan?: boolean }).__cgDiscoveryRan, undefined);
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0]?.implementation?.register, undefined);
    assert.ok(discovered[0]?.implementation?.wasm && discovered[0].implementation.wasm.byteLength > 0);
    const inspected = inspectWasm(discovered[0].implementation.wasm);
    assert.equal("min" in inspected.memory, true);
    await assert.rejects(() => loadInProcessImplementations(discovered));
    assert.equal((globalThis as { __cgDiscoveryRan?: boolean }).__cgDiscoveryRan, true);
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses a wasi import, an unbounded memory, and a memory above the limit before the guest runs", async () => {
    const backend = createWasmBackend();
    const policy = wasmPolicy();
    const wasi = await compose([pkg("org.example.wasi", wasiGuest())], { backend, policy });
    assert.equal(wasi.runtimeActive, false);
    assert.match(wasi.diagnostics.map((item) => item.message).join("\n"), /Unauthorized import wasi_snapshot_preview1.fd_write/);
    const open = await compose([pkg("org.example.open", unboundedGuest())], { backend, policy });
    assert.match(open.diagnostics.map((item) => item.message).join("\n"), /no maximum/);
    const wide = await compose([pkg("org.example.wide", wideGuest())], { backend, policy });
    assert.match(wide.diagnostics.map((item) => item.message).join("\n"), /131072/);
    const foreign = await compose([pkg("org.example.fs", logGuest("node:fs"))], { backend, policy });
    assert.match(foreign.diagnostics.map((item) => item.message).join("\n"), /Unauthorized import node:fs.log/);
    assert.equal(backend.openSessions(), 0);
    backend.dispose();
  });

  it("stops an infinite loop and still runs a later module", async () => {
    const backend = createWasmBackend();
    const policy = wasmPolicy({ maxHookMs: 400 });
    const stuck = await compose([pkg("org.example.loop", loopingGuest())], { backend, policy });
    assert.equal(stuck.runtimeActive, false);
    assert.match(stuck.diagnostics.map((item) => item.message).join("\n"), /Time limit exceeded/);
    const live = await compose([pkg("org.example.meter", storeGuest('{"contributions":[]}'), { save: { version: "1.0.0" } })], {
      backend,
      policy: wasmPolicy(),
    });
    assert.equal(live.runtimeActive, true, live.diagnostics.map((item) => item.message).join("\n"));
    const saved = await captureSave(live);
    assert.equal(saved.ok, true);
    assert.deepEqual(saved.document.slices[0]?.payload, { count: 0 });
    await live.shutdown();
  });

  it("denies memory growth past the declared maximum", async () => {
    const backend = createWasmBackend();
    const result = await compose([pkg("org.example.grow", growGuest())], { backend, policy: wasmPolicy() });
    assert.equal(result.runtimeActive, true, result.diagnostics.map((item) => item.message).join("\n"));
    await result.shutdown();
  });

  it("grants cgp.log only when the manifest and the policy both allow it", async () => {
    const denied = createWasmBackend();
    const refused = await compose([pkg("org.example.log", logGuest(), { permissions: ["cgp.log"] })], {
      backend: denied,
      policy: wasmPolicy(),
    });
    assert.equal(refused.runtimeActive, false);
    assert.match(refused.diagnostics.map((item) => item.message).join("\n"), /cgp\.log is not granted/);
    denied.dispose();

    const allowed = createWasmBackend();
    const live = await compose([pkg("org.example.log", logGuest(), { permissions: ["cgp.log"] })], {
      backend: allowed,
      policy: wasmPolicy({ allowCapabilities: ["cgp.log"] }),
    });
    assert.equal(live.runtimeActive, true, live.diagnostics.map((item) => item.message).join("\n"));
    assert.ok(allowed.takeLogs().some((line) => line === "[org.example.log] ping"));
    await live.shutdown();
  });

  it("keeps guest memories apart and does not call a JavaScript hook", async () => {
    let called = false;
    const backend = createWasmBackend();
    const desk = pkg("org.example.desk", storeGuest('{"contributions":[]}'), {
      exposesSlots: [
        {
          slotId: "meter.hear",
          contract: "meter.hear",
          contractVersion: "1.0.0",
          kind: "subscriber",
          required: false,
        },
      ],
    });
    const writer = pkg(
      "org.example.writer",
      counterGuest(),
      {
        save: { version: "1.0.0" },
        connectsTo: [{ slot: "meter.hear", contract: "meter.hear/1" }],
      },
      {
        register() {
          called = true;
        },
      },
    );
    const reader = pkg("org.example.reader", readerGuest(), {
      save: { version: "1.0.0" },
      connectsTo: [{ slot: "meter.hear", contract: "meter.hear/1" }],
    });
    const result = await compose([desk, writer, reader], { backend, policy: wasmPolicy() });
    assert.equal(result.runtimeActive, true, result.diagnostics.map((item) => item.message).join("\n"));
    assert.equal(called, false);
    const fan = await publish(result, "meter.hear", { token: "once" });
    assert.equal(fan.ok, true, fan.reason ?? fan.deliveries.map((item) => item.message).join("\n"));
    const saved = await captureSave(result);
    const payload = (id: string) => saved.document.slices.find((item) => item.moduleId === id)?.payload;
    assert.deepEqual(payload("org.example.writer"), { n: 1 });
    assert.deepEqual(payload("org.example.reader"), { b0: 0 });
    await result.shutdown();
  });

  it("restores a plain JSON slice on a new isolate and on the in-process backend", async () => {
    const bytes = storeGuest('{"contributions":[]}');
    const manifestRow = manifest("org.example.meter", { save: { version: "1.0.0" } });
    const policy = wasmPolicy();
    const firstBackend = createWasmBackend();
    const first = await compose([{ manifest: manifestRow, implementation: { wasm: bytes } }], { backend: firstBackend, policy });
    assert.equal(first.runtimeActive, true, first.diagnostics.map((item) => item.message).join("\n"));
    const saved = await captureSave(first);
    assert.equal(saved.ok, true);
    assert.deepEqual(saved.document.slices[0]?.payload, { count: 0 });
    assert.equal(JSON.stringify(saved.document.slices).includes("wasm"), false);
    await first.shutdown();

    const document = structuredClone(saved.document);
    document.slices[0] = { ...document.slices[0]!, payload: { count: 4 } };
    const secondBackend = createWasmBackend();
    const second = await compose([{ manifest: manifestRow, implementation: { wasm: bytes } }], { backend: secondBackend, policy });
    const restored = await restoreSave(second, document);
    assert.equal(restored.ok, true, restored.notices.map((item) => item.message).join("\n"));
    const again = await captureSave(second);
    assert.deepEqual(again.document.slices[0]?.payload, { count: 4 });
    await second.shutdown();

    let held: unknown = { count: 0 };
    const local = await compose(
      [
        {
          manifest: manifestRow,
          implementation: {
            exportState: () => held,
            importState(_ctx, value) {
              held = value;
            },
          },
        },
      ],
      { policy: IN_PROCESS_POLICY },
    );
    const crossed = await restoreSave(local, document);
    assert.equal(crossed.ok, true, crossed.notices.map((item) => item.message).join("\n"));
    assert.deepEqual((await captureSave(local)).document.slices[0]?.payload, { count: 4 });
    await local.shutdown();
  });

  it("refuses a shared memory, an open table, and a table above the limit before the guest runs", async () => {
    const backend = createWasmBackend();
    const shared = await compose([pkg("org.example.shared", sharedGuest())], { backend, policy: wasmPolicy() });
    assert.match(shared.diagnostics.map((item) => item.message).join("\n"), /shared memory/);
    const open = await compose([pkg("org.example.table", openTableGuest())], { backend, policy: wasmPolicy() });
    assert.match(open.diagnostics.map((item) => item.message).join("\n"), /table has no maximum/);
    const huge = await compose([pkg("org.example.huge", hugeTableGuest())], { backend, policy: wasmPolicy() });
    assert.match(huge.diagnostics.map((item) => item.message).join("\n"), /1000000/);
    assert.equal(backend.openSessions(), 0);
    backend.dispose();
  });

  it("stops a start-function loop without blocking another composition", async () => {
    const backend = createWasmBackend();
    const policy = wasmPolicy({ maxHookMs: 1500 });
    const stuckPromise = compose([pkg("org.example.start", startLoopGuest())], { backend, policy });
    const started = Date.now();
    const live = await compose(
      [pkg("org.example.meter", storeGuest('{"contributions":[]}'), { save: { version: "1.0.0" } })],
      { backend, policy: wasmPolicy() },
    );
    const elapsed = Date.now() - started;
    assert.equal(live.runtimeActive, true, live.diagnostics.map((item) => item.message).join("\n"));
    assert.ok(elapsed < 1000, `host blocked for ${elapsed}ms while another guest was looping`);
    await live.shutdown();
    const stuck = await stuckPromise;
    assert.equal(stuck.runtimeActive, false);
    assert.match(stuck.diagnostics.map((item) => item.message).join("\n"), /Time limit exceeded/);
    assert.equal(backend.openSessions(), 0);
    backend.dispose();
  });

  it("keeps simultaneous compositions of two versions of one module apart", async () => {
    const backend = createWasmBackend();
    const policy = wasmPolicy();
    const desk = (moduleId: string): ModulePackage =>
      pkg(moduleId, storeGuest('{"contributions":[]}'), {
        exposesSlots: [
          {
            slotId: "meter.hear",
            contract: "meter.hear",
            contractVersion: "1.0.0",
            kind: "subscriber",
            required: false,
          },
        ],
      });
    const meter = (version: string): ModulePackage =>
      pkg(
        "org.example.counter",
        counterGuest(),
        {
          version,
          save: { version: "1.0.0" },
          connectsTo: [{ slot: "meter.hear", contract: "meter.hear/1" }],
        },
      );
    const [left, right] = await Promise.all([
      compose([desk("org.example.desk-a"), meter("1.2.0")], { backend, policy, profileName: "left" }),
      compose([desk("org.example.desk-b"), meter("2.0.0")], { backend, policy, profileName: "right" }),
    ]);
    assert.equal(left.runtimeActive, true, left.diagnostics.map((item) => item.message).join("\n"));
    assert.equal(right.runtimeActive, true, right.diagnostics.map((item) => item.message).join("\n"));
    assert.equal(backend.openSessions(), 2);
    assert.notEqual(left.fingerprint, right.fingerprint);
    assert.equal(left.modules.find((item) => item.moduleId === "org.example.counter")?.version, "1.2.0");
    assert.equal(right.modules.find((item) => item.moduleId === "org.example.counter")?.version, "2.0.0");
    const [leftFan, rightFan] = await Promise.all([
      publish(left, "meter.hear", { token: "left" }),
      publish(right, "meter.hear", { token: "right" }),
    ]);
    assert.equal(leftFan.ok, true, leftFan.reason ?? "");
    assert.equal(rightFan.ok, true, rightFan.reason ?? "");
    const countOf = async (result: Awaited<ReturnType<typeof compose>>) => {
      const saved = await captureSave(result);
      return saved.document.slices.find((item) => item.moduleId === "org.example.counter")?.payload;
    };
    assert.deepEqual(await countOf(left), { n: 1 });
    assert.deepEqual(await countOf(right), { n: 1 });
    await left.shutdown();
    assert.equal(backend.openSessions(), 1);
    const again = await publish(right, "meter.hear", { token: "right-again" });
    assert.equal(again.ok, true, again.reason ?? "");
    assert.deepEqual(await countOf(right), { n: 2 });
    await right.shutdown();
    assert.equal(backend.openSessions(), 0);
    const fresh = await compose([desk("org.example.desk-c"), meter("1.2.0")], { backend, policy });
    assert.equal(fresh.runtimeActive, true, fresh.diagnostics.map((item) => item.message).join("\n"));
    assert.equal((await publish(fresh, "meter.hear", { token: "fresh" })).ok, true);
    assert.deepEqual(await countOf(fresh), { n: 1 });
    await fresh.shutdown();
    assert.equal(backend.openSessions(), 0);
    backend.dispose();
  });
});
