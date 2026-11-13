import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { discoverModules, loadInProcessImplementations } from "./discover-node.ts";
import { compose, sessionOf, type ModulePackage } from "./host.ts";
import { IN_PROCESS_POLICY, type ExecutionPolicy } from "./backend.ts";
import { captureSave, restoreSave } from "./save.ts";
import { publish } from "./dispatch.ts";
import { ABI_ID, abiHandleOwned, copyJsonData, encodeAbiCall, encodeAbiJson, guestContributions, isAbiHandle, materializeAbiValue, mintAbiHandle } from "./abi.ts";
import { createWasmBackend, inspectWasm } from "./wasm-backend.ts";
import {
  counterGuest,
  echoGuest,
  growGuest,
  hugeTableGuest,
  logGuest,
  loopingGuest,
  openTableGuest,
  readerGuest,
  sharedGuest,
  startLoopGuest,
  storeGuest,
  scriptedGuest,
  unboundedGuest,
  wasiGuest,
  wideGuest,
  withCustomPadding,
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

function messages(result: { diagnostics: Array<{ message: string }> }): string {
  return result.diagnostics.map((item) => item.message).join("\n");
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

  it("limits a guest binary separately from its linear memory", async () => {
    const backend = createWasmBackend();
    const small = storeGuest("{}");
    const tight = await compose([pkg("org.example.small", small)], {
      backend,
      policy: wasmPolicy({ maxBinaryBytes: 32, maxMemoryBytes: 65536 }),
    });
    assert.equal(tight.runtimeActive, false);
    assert.match(messages(tight), new RegExp(`binary is ${small.byteLength} bytes\\. The binary limit is 32\\.`));
    assert.doesNotMatch(messages(tight), /memory maximum/);

    const padded = withCustomPadding(small, 70_000);
    assert.ok(padded.byteLength > 65536);
    const memory = await compose([pkg("org.example.wide-file", padded)], {
      backend,
      policy: wasmPolicy({ maxMemoryBytes: 65536 }),
    });
    assert.match(messages(memory), /binary limit is 65536/);
    const allowed = await compose([pkg("org.example.wide-file", padded)], {
      backend,
      policy: wasmPolicy({ maxMemoryBytes: 65536, maxBinaryBytes: padded.byteLength }),
    });
    assert.equal(allowed.runtimeActive, true, messages(allowed));
    assert.equal(backend.resourceUsage().memoryBytes, 65536);
    assert.equal(backend.resourceUsage().binaryBytes, padded.byteLength);
    await allowed.shutdown();
    assert.equal(backend.resourceUsage().binaryBytes, 0);
    await backend.dispose();
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

describe("abi payloads and cleanup", () => {
  const link = { connectsTo: [{ slot: "platform.systems", contract: "platform.system/1" }] };

  it("names the values that cannot cross the ABI", () => {
    const reason = (value: unknown) => {
      const encoded = encodeAbiJson(value);
      return encoded.ok ? "" : encoded.error;
    };
    assert.equal(encodeAbiJson({ ok: true, n: 1 }).ok, true);
    assert.equal(encodeAbiJson(null).ok, true);
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    assert.match(reason(cycle), /circular/);
    assert.match(reason(1n), /bigint/);
    assert.match(reason(undefined), /undefined/);
    assert.match(reason(() => 1), /function/);
    assert.match(reason(Symbol("x")), /symbol/);
    assert.match(reason(Number.POSITIVE_INFINITY), /non-finite/);
    assert.match(reason(new Date(0)), /non-plain object/);
    const shared = { n: 1 };
    assert.equal(encodeAbiJson({ arg: shared, args: [shared] }).ok, true);
  });

  it("refuses a non-JSON call or import and still releases the guest", async () => {
    const backend = createWasmBackend();
    const bytes = storeGuest(
      JSON.stringify({
        contributions: [{ slotId: "platform.systems", id: "echo", dispatch: true, payload: { systemId: "echo" } }],
      }),
    );
    const result = await compose([pkg("org.example.echo", bytes, { ...link, save: { version: "1.0.0" } })], {
      backend,
      policy: wasmPolicy(),
    });
    assert.equal(result.runtimeActive, true, messages(result));
    const session = sessionOf(result);
    const handle = result.contributions.find((item) => item.id === "echo")?.payload;
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;

    const circular = await session.callPayload(handle, [cycle]);
    assert.equal(circular.ok, false);
    if (circular.ok || circular.code !== "threw") assert.fail("circular call was accepted");
    assert.match(String(circular.error), /ABI payload is not JSON \(circular\)/);

    const big = await session.callPayload(handle, [1n]);
    assert.equal(big.ok, false);
    if (big.ok || big.code !== "threw") assert.fail("bigint call was accepted");
    assert.match(String(big.error), /ABI payload is not JSON \(bigint\)/);

    const fn = await session.callPayload(handle, [() => 1]);
    assert.equal(fn.ok, false);
    if (fn.ok || fn.code !== "threw") assert.fail("function call was accepted");
    assert.match(String(fn.error), /ABI payload is not JSON \(function\)/);

    const imported = await session.invoke({
      moduleId: "org.example.echo",
      hook: "importState",
      implementation: { wasm: bytes },
      args: [{}, cycle],
    });
    assert.equal(imported.ok, false);
    if (imported.ok) return;
    assert.match(imported.error instanceof Error ? imported.error.message : String(imported.error), /circular/);

    const omitted = await session.invoke({
      moduleId: "org.example.echo",
      hook: "importState",
      implementation: { wasm: bytes },
      args: [{}],
    });
    assert.equal(omitted.ok, false);
    if (omitted.ok) return;
    assert.match(omitted.error instanceof Error ? omitted.error.message : String(omitted.error), /undefined/);

    const again = await session.callPayload(handle, [{ n: 1 }]);
    assert.equal(again.ok, true, failureText(again));
    if (again.ok) assert.deepEqual(again.value, { count: 0 });
    const saved = await captureSave(result);
    assert.equal(saved.ok, true, saved.notices.map((item) => item.message).join("\n"));
    assert.deepEqual(saved.document.slices[0]?.payload, { count: 0 });

    const racing = session.callPayload(handle, [cycle]);
    await within(Promise.all([racing, result.shutdown(), backend.dispose()]));
    assert.equal(backend.openSessions(), 0);
    assert.equal(backend.resourceUsage().guests, 0);
    assert.equal(backend.resourceUsage().memoryBytes, 0);
    assert.equal(backend.resourceUsage().binaryBytes, 0);
  });

  it("stops a guest whose register or export is not JSON and returns the reservation", async () => {
    const linkSave = { ...link, save: { version: "1.0.0" } };
    const cases: Array<[string, Uint8Array, RegExp]> = [
      ["torn", scriptedGuest({ register: "{" }), /Guest result was not JSON/],
      ["shape", scriptedGuest({ register: '{"contributions":{}}' }), /contributions must be an array/],
      ["row", scriptedGuest({ register: '{"contributions":[null]}' }), /missing a slot or an id/],
      [
        "order",
        scriptedGuest({
          register:
            '{"contributions":[{"slotId":"platform.systems","id":"echo","order":1.5,"payload":{"systemId":"echo"}}]}',
        }),
        /non-integer order/,
      ],
    ];
    for (const [name, wasm, pattern] of cases) {
      const backend = createWasmBackend();
      const result = await compose([pkg(`org.example.${name}`, wasm, link)], { backend, policy: wasmPolicy() });
      assert.equal(result.runtimeActive, false, name);
      assert.match(messages(result), pattern, name);
      assert.equal(backend.openSessions(), 0, name);
      assert.equal(backend.resourceUsage().guests, 0, name);
      assert.equal(backend.resourceUsage().memoryBytes, 0, name);
      await backend.dispose();
    }

    const backend = createWasmBackend();
    const bytes = scriptedGuest({
      register: JSON.stringify({
        contributions: [{ slotId: "platform.systems", id: "echo", dispatch: true, payload: { systemId: "echo" } }],
      }),
      exportState: "{",
      call: "not-json",
    });
    const result = await compose([pkg("org.example.bad-export", bytes, linkSave)], { backend, policy: wasmPolicy() });
    assert.equal(result.runtimeActive, true, messages(result));
    const session = sessionOf(result);
    const handle = result.contributions.find((item) => item.id === "echo")?.payload;
    const called = await session.callPayload(handle, [{ ok: true }]);
    assert.equal(called.ok, false);
    if (called.ok || called.code !== "threw") assert.fail("non-JSON call was accepted");
    assert.match(String(called.error), /Guest result was not JSON/);
    const calledAgain = await session.callPayload(handle, [{ ok: true }]);
    assert.equal(calledAgain.ok, false);
    if (calledAgain.ok || calledAgain.code !== "threw") assert.fail("second call was accepted");
    assert.match(String(calledAgain.error), /Guest result was not JSON/);
    assert.doesNotMatch(String(calledAgain.error), /was stopped/);
    const saved = await captureSave(result);
    assert.equal(saved.ok, false);
    assert.match(saved.notices.map((item) => item.message).join("\n"), /Guest result was not JSON/);
    await result.shutdown();
    assert.equal(backend.openSessions(), 0);
    assert.equal(backend.resourceUsage().guests, 0);
    assert.equal(backend.resourceUsage().memoryBytes, 0);
    assert.equal(backend.resourceUsage().binaryBytes, 0);
    await backend.dispose();
  });

  it("returns the reservation after a time limit and after dispose during a running guest", async () => {
    const timed = createWasmBackend();
    const stuck = await compose([pkg("org.example.loop", loopingGuest())], {
      backend: timed,
      policy: wasmPolicy({ maxHookMs: 250 }),
    });
    assert.equal(stuck.runtimeActive, false);
    assert.match(messages(stuck), /Time limit exceeded/);
    assert.equal(timed.openSessions(), 0);
    assert.equal(timed.resourceUsage().guests, 0);
    assert.equal(timed.resourceUsage().memoryBytes, 0);
    assert.equal(timed.resourceUsage().binaryBytes, 0);
    await timed.dispose();

    const backend = createWasmBackend();
    const session = backend.open();
    const pending = session.invoke({
      moduleId: "org.example.loop",
      hook: "register",
      implementation: { wasm: loopingGuest() },
      args: [],
    });
    const outcome = await within(Promise.all([pending, backend.dispose()]).then(([value]) => value));
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.match(outcome.error instanceof Error ? outcome.error.message : String(outcome.error), /released|Time limit exceeded/);
    assert.equal(backend.openSessions(), 0);
    assert.equal(backend.resourceUsage().guests, 0);
    assert.equal(backend.resourceUsage().memoryBytes, 0);
    assert.equal(backend.resourceUsage().binaryBytes, 0);
  });

  it("rejects a forged handle, a copied handle, and a handle from another composition", async () => {
    const scope = {};
    const mint = (moduleId: string, contributionId: string) => mintAbiHandle(scope, moduleId, contributionId);
    const handle = mint("org.example.victim", "a");
    assert.equal(isAbiHandle(handle), true);
    assert.equal(abiHandleOwned(handle, scope), true);
    assert.equal(abiHandleOwned(handle, {}), false);
    assert.equal(isAbiHandle({ abi: ABI_ID, moduleId: "org.example.victim", contributionId: "a" }), false);
    assert.equal(isAbiHandle(JSON.parse(JSON.stringify(handle))), false);
    assert.equal(isAbiHandle({ ...handle }), false);
    assert.throws(() => {
      (handle as { moduleId: string }).moduleId = "org.example.thief";
    }, TypeError);
    const lookalike = guestContributions(
      "org.example.thief",
      {
        contributions: [
          {
            slotId: "platform.systems",
            id: "lookalike",
            payload: { abi: ABI_ID, moduleId: "org.example.victim", contributionId: "a" },
          },
        ],
      },
      mint,
    );
    assert.equal(isAbiHandle(lookalike[0]?.payload), false);
    assert.equal((lookalike[0]?.payload as { moduleId?: string }).moduleId, "org.example.victim");
    const inherited = Object.create({ dispatch: true, slotId: "platform.systems", id: "stolen" });
    assert.throws(() => guestContributions("org.example.thief", { contributions: [inherited] }, mint), /missing a slot or an id/);

    const backend = createWasmBackend();
    const desk = (moduleId: string) =>
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
    const victim = (version = "1.0.0") =>
      pkg("org.example.victim", counterGuest(), {
        version,
        save: { version: "1.0.0" },
        connectsTo: [{ slot: "meter.hear", contract: "meter.hear/1" }],
      });
    const thief = pkg(
      "org.example.thief",
      storeGuest(
        JSON.stringify({
          contributions: [
            {
              slotId: "platform.systems",
              id: "lookalike",
              payload: { abi: ABI_ID, moduleId: "org.example.victim", contributionId: "a" },
            },
          ],
        }),
      ),
      { connectsTo: [{ slot: "platform.systems", contract: "platform.system/1" }] },
    );
    const result = await compose([desk("org.example.desk"), victim(), thief], { backend, policy: wasmPolicy() });
    assert.equal(result.runtimeActive, true, messages(result));
    const session = sessionOf(result);
    const real = result.contributions.find((item) => item.moduleId === "org.example.victim" && item.id === "a")?.payload;
    const forged = result.contributions.find((item) => item.id === "lookalike")?.payload;
    assert.equal(isAbiHandle(real), true);
    assert.equal(isAbiHandle(forged), false);

    const attacks = [
      forged,
      JSON.parse(JSON.stringify(real)),
      { ...((real ?? {}) as object) },
      structuredClone(real),
      { abi: ABI_ID, moduleId: "org.example.victim", contributionId: "a" },
      Object.create(real as object),
    ];
    for (const payload of attacks) {
      const called = await session.callPayload(payload, [{ token: "steal" }]);
      assert.equal(called.ok, false);
      if (called.ok || called.code !== "not-callable") assert.fail("forged handle was accepted");
    }
    const carrier = {};
    Object.setPrototypeOf(carrier, real as object);
    const viaProto = await session.callPayload(carrier, [{}]);
    assert.equal(viaProto.ok, false);
    if (viaProto.ok || viaProto.code !== "not-callable") assert.fail("prototype handle was accepted");

    const before = await captureSave(result);
    assert.equal(before.ok, true, before.notices.map((item) => item.message).join("\n"));
    assert.deepEqual(before.document.slices.find((item) => item.moduleId === "org.example.victim")?.payload, { n: 0 });

    const heard = await publish(result, "meter.hear", { token: "once" });
    assert.equal(heard.ok, true, heard.reason ?? heard.deliveries.map((item) => item.message).join("\n"));
    const after = await captureSave(result);
    assert.deepEqual(after.document.slices.find((item) => item.moduleId === "org.example.victim")?.payload, { n: 1 });

    const other = await compose([desk("org.example.desk-b"), victim("1.1.0")], {
      backend,
      policy: wasmPolicy(),
      profileName: "other",
    });
    assert.equal(other.runtimeActive, true, messages(other));
    const crossed = await sessionOf(other).callPayload(real, [{ token: "steal" }]);
    assert.equal(crossed.ok, false);
    if (crossed.ok || crossed.code !== "threw") assert.fail("foreign handle was accepted");
    assert.ok(crossed.error instanceof Error);
    assert.match(crossed.error.message, /another composition/);
    const otherSaved = await captureSave(other);
    assert.equal(otherSaved.ok, true, otherSaved.notices.map((item) => item.message).join("\n"));
    assert.deepEqual(otherSaved.document.slices.find((item) => item.moduleId === "org.example.victim")?.payload, { n: 0 });
    const still = await captureSave(result);
    assert.deepEqual(still.document.slices.find((item) => item.moduleId === "org.example.victim")?.payload, { n: 1 });

    await result.shutdown();
    await other.shutdown();
    assert.equal(backend.openSessions(), 0);
    assert.equal(backend.resourceUsage().guests, 0);
    assert.equal(backend.resourceUsage().memoryBytes, 0);
    assert.equal(backend.resourceUsage().binaryBytes, 0);
    await backend.dispose();
  });

  it("copies guest JSON without applying prototype fields", async () => {
    const parsed = JSON.parse(
      '{"__proto__":{"polluted":true,"dispatch":true},"constructor":{"prototype":{"polluted":true}},"n":1}',
    );
    const copied = copyJsonData(parsed) as { n?: number; polluted?: unknown };
    assert.equal(copied.n, 1);
    assert.equal(copied.polluted, undefined);
    assert.equal(Object.getPrototypeOf(copied), Object.prototype);
    assert.equal(Object.hasOwn(copied, "__proto__"), true);
    assert.equal(({} as { polluted?: unknown }).polluted, undefined);
    assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);

    const scope = {};
    const mint = (moduleId: string, contributionId: string) => mintAbiHandle(scope, moduleId, contributionId);
    const nested = materializeAbiValue("org.example.thief", "lookalike", JSON.parse('{"__proto__":{"dispatch":true}}'), mint);
    assert.equal(isAbiHandle(nested), false);
    assert.equal(Object.getPrototypeOf(nested), Object.prototype);
    const inner = (nested as Record<string, unknown>)["__proto__"];
    assert.equal(isAbiHandle(inner), true);
    if (!isAbiHandle(inner)) return;
    assert.equal(inner.moduleId, "org.example.thief");
    assert.equal(inner.contributionId, "lookalike");
    assert.notEqual(inner.moduleId, "org.example.victim");

    const backend = createWasmBackend();
    const register =
      '{"contributions":[{"slotId":"platform.systems","id":"p","payload":{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}}]}';
    const result = await compose(
      [pkg("org.example.poison", scriptedGuest({ register }), link)],
      { backend, policy: wasmPolicy() },
    );
    assert.equal(result.runtimeActive, true, messages(result));
    const payload = result.contributions.find((item) => item.id === "p")?.payload as
      | { polluted?: unknown; constructor?: { prototype?: { polluted?: unknown } } }
      | undefined;
    assert.ok(payload);
    assert.equal(isAbiHandle(payload), false);
    assert.equal(Object.getPrototypeOf(payload), Object.prototype);
    assert.equal(payload.polluted, undefined);
    assert.equal(payload.constructor?.prototype?.polluted, true);
    assert.equal(({} as { polluted?: unknown }).polluted, undefined);
    assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
    await result.shutdown();
    await backend.dispose();
  });

  it("sends null for a zero-argument call and normalizes a throwing input", async () => {
    const leaking = {};
    Object.defineProperty(leaking, "n", {
      enumerable: true,
      get() {
        throw "leak-marker";
      },
    });
    const hidden = {};
    Object.defineProperty(hidden, "toJSON", {
      enumerable: false,
      value() {
        throw "leak-marker";
      },
    });
    for (const value of [leaking, hidden]) {
      const encoded = encodeAbiJson(value);
      assert.equal(encoded.ok, false);
      if (encoded.ok) return;
      assert.equal(encoded.error, "ABI payload is not JSON (could not encode).");
      assert.equal(encoded.error.includes("leak-marker"), false);
    }
    const none = encodeAbiCall("echo", []);
    assert.equal(none.ok, true);
    if (none.ok) assert.equal(none.json, JSON.stringify({ contributionId: "echo", arg: null, args: [] }));
    const explicit = encodeAbiCall("echo", [undefined]);
    assert.equal(explicit.ok, false);
    if (!explicit.ok) assert.match(explicit.error, /undefined/);
    const present = encodeAbiCall("echo", [null]);
    assert.equal(present.ok, true);
    if (present.ok) assert.equal(present.json, JSON.stringify({ contributionId: "echo", arg: null, args: [null] }));

    const backend = createWasmBackend();
    const result = await compose([pkg("org.example.echo", echoGuest(), link)], { backend, policy: wasmPolicy() });
    assert.equal(result.runtimeActive, true, messages(result));
    const session = sessionOf(result);
    const handle = result.contributions.find((item) => item.id === "echo")?.payload;
    const empty = await session.callPayload(handle, []);
    assert.equal(empty.ok, true, failureText(empty));
    if (empty.ok) assert.deepEqual(empty.value, { contributionId: "echo", arg: null, args: [] });
    const omitted = await session.callPayload(handle, [undefined]);
    assert.equal(omitted.ok, false);
    if (omitted.ok || omitted.code !== "threw") assert.fail("undefined call was accepted");
    assert.ok(omitted.error instanceof Error);
    assert.match(omitted.error.message, /undefined/);
    const nulled = await session.callPayload(handle, [null]);
    assert.equal(nulled.ok, true, failureText(nulled));
    if (nulled.ok) assert.deepEqual(nulled.value, { contributionId: "echo", arg: null, args: [null] });
    const thrown = await session.callPayload(handle, [leaking]);
    assert.equal(thrown.ok, false);
    if (thrown.ok || thrown.code !== "threw") assert.fail("throwing input was accepted");
    assert.ok(thrown.error instanceof Error);
    assert.equal(thrown.error.message, "ABI payload is not JSON (could not encode).");
    assert.equal(thrown.error.message.includes("leak-marker"), false);
    const proxied = new Proxy([1], {
      get() {
        throw "leak-marker";
      },
    });
    const broken = await session.callPayload(handle, proxied);
    assert.equal(broken.ok, false);
    if (broken.ok || broken.code !== "threw") assert.fail("proxy input was accepted");
    assert.ok(broken.error instanceof Error);
    assert.equal(broken.error.message, "ABI payload is not JSON (could not encode).");
    const again = await session.callPayload(handle, []);
    assert.equal(again.ok, true, failureText(again));
    if (again.ok) assert.deepEqual(again.value, { contributionId: "echo", arg: null, args: [] });
    await result.shutdown();
    assert.equal(backend.openSessions(), 0);
    assert.equal(backend.resourceUsage().guests, 0);
    await backend.dispose();
  });
});

function failureText(result: { ok: boolean; error?: unknown; code?: string }): string {
  if (result.ok) return "";
  return result.error instanceof Error ? result.error.message : String(result.error ?? result.code ?? "");
}

function within<T>(work: Promise<T>, ms = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("cleanup hung")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
