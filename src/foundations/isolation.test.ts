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
  logGuest,
  loopingGuest,
  readerGuest,
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

  it("refuses a wasi import, an unbounded memory, and a memory above the limit before the guest runs", () => {
    const backend = createWasmBackend();
    const policy = wasmPolicy();
    const wasi = compose([pkg("org.example.wasi", wasiGuest())], { backend, policy });
    assert.equal(wasi.runtimeActive, false);
    assert.match(wasi.diagnostics.map((item) => item.message).join("\n"), /Unauthorized import wasi_snapshot_preview1.fd_write/);
    const open = compose([pkg("org.example.open", unboundedGuest())], { backend, policy });
    assert.match(open.diagnostics.map((item) => item.message).join("\n"), /no maximum/);
    const wide = compose([pkg("org.example.wide", wideGuest())], { backend, policy });
    assert.match(wide.diagnostics.map((item) => item.message).join("\n"), /131072/);
    const foreign = compose([pkg("org.example.fs", logGuest("node:fs"))], { backend, policy });
    assert.match(foreign.diagnostics.map((item) => item.message).join("\n"), /Unauthorized import node:fs.log/);
    backend.dispose();
  });

  it("stops an infinite loop and still runs a later module", () => {
    const backend = createWasmBackend();
    const policy = wasmPolicy({ maxHookMs: 400 });
    const stuck = compose([pkg("org.example.loop", loopingGuest())], { backend, policy });
    assert.equal(stuck.runtimeActive, false);
    assert.match(stuck.diagnostics.map((item) => item.message).join("\n"), /Time limit exceeded/);
    const live = compose([pkg("org.example.meter", storeGuest('{"contributions":[]}'), { save: { version: "1.0.0" } })], {
      backend,
      policy: wasmPolicy(),
    });
    assert.equal(live.runtimeActive, true, live.diagnostics.map((item) => item.message).join("\n"));
    const saved = captureSave(live);
    assert.equal(saved.ok, true);
    assert.deepEqual(saved.document.slices[0]?.payload, { count: 0 });
    live.shutdown();
  });

  it("denies memory growth past the declared maximum", () => {
    const backend = createWasmBackend();
    const result = compose([pkg("org.example.grow", growGuest())], { backend, policy: wasmPolicy() });
    assert.equal(result.runtimeActive, true, result.diagnostics.map((item) => item.message).join("\n"));
    result.shutdown();
  });

  it("grants cgp.log only when the manifest and the policy both allow it", () => {
    const denied = createWasmBackend();
    const refused = compose([pkg("org.example.log", logGuest(), { permissions: ["cgp.log"] })], {
      backend: denied,
      policy: wasmPolicy(),
    });
    assert.equal(refused.runtimeActive, false);
    assert.match(refused.diagnostics.map((item) => item.message).join("\n"), /cgp\.log is not granted/);
    denied.dispose();

    const allowed = createWasmBackend();
    const live = compose([pkg("org.example.log", logGuest(), { permissions: ["cgp.log"] })], {
      backend: allowed,
      policy: wasmPolicy({ allowCapabilities: ["cgp.log"] }),
    });
    assert.equal(live.runtimeActive, true, live.diagnostics.map((item) => item.message).join("\n"));
    assert.ok(allowed.takeLogs().includes("ping"));
    live.shutdown();
  });

  it("keeps guest memories apart and does not call a JavaScript hook", () => {
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
    const result = compose([desk, writer, reader], { backend, policy: wasmPolicy() });
    assert.equal(result.runtimeActive, true, result.diagnostics.map((item) => item.message).join("\n"));
    assert.equal(called, false);
    const fan = publish(result, "meter.hear", { token: "once" });
    assert.equal(fan.ok, true, fan.reason ?? fan.deliveries.map((item) => item.message).join("\n"));
    const saved = captureSave(result);
    const payload = (id: string) => saved.document.slices.find((item) => item.moduleId === id)?.payload;
    assert.deepEqual(payload("org.example.writer"), { n: 1 });
    assert.deepEqual(payload("org.example.reader"), { b0: 0 });
    result.shutdown();
  });

  it("restores a plain JSON slice on a new isolate and on the in-process backend", () => {
    const bytes = storeGuest('{"contributions":[]}');
    const manifestRow = manifest("org.example.meter", { save: { version: "1.0.0" } });
    const policy = wasmPolicy();
    const firstBackend = createWasmBackend();
    const first = compose([{ manifest: manifestRow, implementation: { wasm: bytes } }], { backend: firstBackend, policy });
    assert.equal(first.runtimeActive, true, first.diagnostics.map((item) => item.message).join("\n"));
    const saved = captureSave(first);
    assert.equal(saved.ok, true);
    assert.deepEqual(saved.document.slices[0]?.payload, { count: 0 });
    assert.equal(JSON.stringify(saved.document.slices).includes("wasm"), false);
    first.shutdown();

    const document = structuredClone(saved.document);
    document.slices[0] = { ...document.slices[0]!, payload: { count: 4 } };
    const secondBackend = createWasmBackend();
    const second = compose([{ manifest: manifestRow, implementation: { wasm: bytes } }], { backend: secondBackend, policy });
    const restored = restoreSave(second, document);
    assert.equal(restored.ok, true, restored.notices.map((item) => item.message).join("\n"));
    const again = captureSave(second);
    assert.deepEqual(again.document.slices[0]?.payload, { count: 4 });
    second.shutdown();

    let held: unknown = { count: 0 };
    const local = compose(
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
    const crossed = restoreSave(local, document);
    assert.equal(crossed.ok, true, crossed.notices.map((item) => item.message).join("\n"));
    assert.deepEqual(captureSave(local).document.slices[0]?.payload, { count: 4 });
    local.shutdown();
  });
});
