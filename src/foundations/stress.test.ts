import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { IN_PROCESS_POLICY, type ExecutionPolicy } from "./backend.ts";
import { ABI_ID, isAbiHandle } from "./abi.ts";
import { CROSS_POLICY, createCrossBackend } from "./cross-backend.ts";
import { publish } from "./dispatch.ts";
import { compose, sessionOf, type ModulePackage } from "./host.ts";
import { captureSave } from "./save.ts";
import { counterGuest, shutdownLoopGuest, storeGuest, templateGuest, callLoopGuest, initFaultGuest, missingAbiGuest } from "./wasm-build.ts";
import { createWasmBackend } from "./wasm-backend.ts";
import { duneGrowthGuest } from "../modules/org.cgp.dune-growth/guest.ts";
import { duneWasmBytes } from "../modules/org.cgp.dune-growth/bytes.ts";
import { packagesFor } from "../modules/registry.ts";
import { advanceFlora, type Season } from "../modules/runners.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

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

function pkg(moduleId: string, wasm: Uint8Array, extra: Record<string, unknown> = {}): ModulePackage {
  return { manifest: manifest(moduleId, extra), implementation: { wasm } };
}

function messages(result: { diagnostics: Array<{ message: string }> }): string {
  return result.diagnostics.map((item) => item.message).join("\n");
}

function seasonal(rate: number, max: number, season: Season, stage: number): number {
  const factor = { spring: 1.15, summer: 1, autumn: 0.45, winter: 0.12 }[season];
  return Math.round(Math.min(max, stage + rate * factor) * 100) / 100;
}

describe("cross-backend execution", () => {
  it("runs a javascript subscriber and a wasm subscriber through one composition", async () => {
    const heard: string[] = [];
    const backend = createWasmBackend();
    const result = await compose(
      [
        {
          manifest: manifest("org.example.meter", {
            provides: [{ capability: "meter.core", version: "1.0.0" }],
            connectsTo: [{ slot: "platform.systems", contract: "platform.system/1" }],
            exposesSlots: [
              {
                slotId: "meter.hear",
                contract: "meter.hear",
                contractVersion: "1.0.0",
                kind: "subscriber",
              },
            ],
          }),
          implementation: {
            register(ctx: { contribute: (slotId: string, contribution: { id: string; payload: unknown }) => void }) {
              ctx.contribute("platform.systems", { id: "meter", payload: { systemId: "meter" } });
            },
          },
        },
        pkg("org.example.counter", counterGuest(), {
          requires: [{ capability: "meter.core", version: "^1.0.0" }],
          connectsTo: [{ slot: "meter.hear", contract: "meter.hear/1" }],
        }),
        {
          manifest: manifest("org.example.hear", {
            requires: [{ capability: "meter.core", version: "^1.0.0" }],
            connectsTo: [{ slot: "meter.hear", contract: "meter.hear/1" }],
          }),
          implementation: {
            register(ctx: { contribute: (slotId: string, contribution: { id: string; payload: unknown }) => void }) {
              ctx.contribute("meter.hear", {
                id: "js",
                payload() {
                  heard.push("js");
                },
              });
            },
          },
        },
      ],
      { backend: createCrossBackend(backend), policy: CROSS_POLICY },
    );
    assert.equal(result.runtimeActive, true, messages(result));
    assert.equal(result.backendId, "cross");
    assert.equal(result.limitsEnforced, true);
    const handle = result.contributions.find((item) => item.id === "a")?.payload;
    const called = await sessionOf(result).callPayload(handle, [{ n: 0 }]);
    assert.equal(called.ok, true);
    if (called.ok) assert.deepEqual(called.value, { n: 1 });
    const report = await publish(result, "meter.hear", { n: 1 });
    assert.equal(report.ok, true, report.reason);
    assert.equal(report.deliveries.length, 2);
    assert.deepEqual(heard, ["js"]);
    await result.shutdown();
    assert.equal(backend.openSessions(), 0);
  });

  it("refuses a forged handle and a foreign handle through the cross router", async () => {
    const wasm = createWasmBackend();
    const heard: unknown[] = [];
    const heardOther: unknown[] = [];
    const desk = (moduleId: string, forgedId?: string) => ({
      manifest: manifest(moduleId, {
        exposesSlots: [
          {
            slotId: "meter.hear",
            contract: "meter.hear",
            contractVersion: "1.0.0",
            kind: "subscriber" as const,
            required: false,
          },
        ],
        ...(forgedId
          ? { connectsTo: [{ slot: "platform.systems", contract: "platform.system/1" }] }
          : {}),
      }),
      implementation: {
        register(ctx: { contribute: (slotId: string, contribution: { id: string; payload: unknown }) => void }) {
          if (!forgedId) return;
          ctx.contribute("platform.systems", {
            id: forgedId,
            payload: { abi: ABI_ID, moduleId: "org.example.victim", contributionId: "a" },
          });
        },
      },
    });
    const hear = (moduleId: string, sink: unknown[]) => ({
      manifest: manifest(moduleId, {
        connectsTo: [{ slot: "meter.hear", contract: "meter.hear/1" }],
      }),
      implementation: {
        register(ctx: { contribute: (slotId: string, contribution: { id: string; payload: unknown }) => void }) {
          ctx.contribute("meter.hear", {
            id: "js",
            payload(event: unknown) {
              sink.push(event);
            },
          });
        },
      },
    });
    const victim = (version: string) =>
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
    const result = await compose(
      [desk("org.example.desk", "js-copy"), hear("org.example.hear", heard), victim("1.0.0"), thief],
      { backend: createCrossBackend(wasm), policy: CROSS_POLICY },
    );
    assert.equal(result.runtimeActive, true, messages(result));
    assert.equal(result.backendId, "cross");
    const session = sessionOf(result);
    assert.match(session.id, /^cross-/);
    const real = result.contributions.find((item) => item.moduleId === "org.example.victim" && item.id === "a")?.payload;
    const forged = result.contributions.find((item) => item.id === "lookalike")?.payload;
    const jsCopy = result.contributions.find((item) => item.id === "js-copy")?.payload;
    const jsPayload = result.contributions.find((item) => item.id === "js")?.payload;
    assert.equal(isAbiHandle(real), true);
    assert.equal(isAbiHandle(forged), false);
    assert.equal(isAbiHandle(jsCopy), false);
    assert.equal(typeof jsPayload, "function");

    const attacks = [
      forged,
      jsCopy,
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
    assert.deepEqual(heard, []);

    const local = await session.callPayload(jsPayload, [{ token: "local" }]);
    assert.equal(local.ok, true, local.ok ? "" : String(local.code));
    assert.deepEqual(heard, [{ token: "local" }]);
    const called = await session.callPayload(real, [{ token: "once" }]);
    if (!called.ok) assert.fail(called.code === "threw" ? String(called.error) : called.code);
    assert.deepEqual(called.value, { n: 1 });
    const fan = await publish(result, "meter.hear", { token: "fan" });
    assert.equal(fan.ok, true, fan.reason ?? fan.deliveries.map((item) => item.message).join("\n"));
    assert.equal(fan.deliveries.length, 2);
    assert.deepEqual(heard, [{ token: "local" }, { token: "fan" }]);
    const after = await captureSave(result);
    assert.deepEqual(after.document.slices.find((item) => item.moduleId === "org.example.victim")?.payload, { n: 2 });

    const other = await compose(
      [desk("org.example.desk-b"), hear("org.example.hear-b", heardOther), victim("1.1.0")],
      { backend: createCrossBackend(wasm), policy: CROSS_POLICY, profileName: "other" },
    );
    assert.equal(other.runtimeActive, true, messages(other));
    assert.match(sessionOf(other).id, /^cross-/);
    const crossed = await sessionOf(other).callPayload(real, [{ token: "steal" }]);
    assert.equal(crossed.ok, false);
    if (crossed.ok || crossed.code !== "threw") assert.fail("foreign handle was accepted");
    assert.ok(crossed.error instanceof Error);
    assert.match(crossed.error.message, /another composition/);
    const otherSaved = await captureSave(other);
    assert.equal(otherSaved.ok, true, otherSaved.notices.map((item) => item.message).join("\n"));
    assert.deepEqual(otherSaved.document.slices.find((item) => item.moduleId === "org.example.victim")?.payload, { n: 0 });
    assert.deepEqual(heardOther, []);
    const still = await captureSave(result);
    assert.deepEqual(still.document.slices.find((item) => item.moduleId === "org.example.victim")?.payload, { n: 2 });

    const otherHandle = other.contributions.find((item) => item.moduleId === "org.example.victim")?.payload;
    const otherCall = await sessionOf(other).callPayload(otherHandle, [{ token: "own" }]);
    if (!otherCall.ok) assert.fail(otherCall.code === "threw" ? String(otherCall.error) : otherCall.code);
    assert.deepEqual(otherCall.value, { n: 1 });
    const otherJs = other.contributions.find((item) => item.id === "js")?.payload;
    const otherLocal = await sessionOf(other).callPayload(otherJs, [{ token: "own" }]);
    assert.equal(otherLocal.ok, true);
    assert.deepEqual(heardOther, [{ token: "own" }]);
    const untouched = await captureSave(result);
    assert.deepEqual(untouched.document.slices.find((item) => item.moduleId === "org.example.victim")?.payload, { n: 2 });

    await result.shutdown();
    await other.shutdown();
    assert.equal(wasm.openSessions(), 0);
    assert.equal(wasm.resourceUsage().guests, 0);
    assert.equal(wasm.resourceUsage().memoryBytes, 0);
    assert.equal(wasm.resourceUsage().binaryBytes, 0);
    await wasm.dispose();
  });

  it("steps the wasm growth guest and keeps the seasonal result distinct", async () => {
    const wasm = createWasmBackend();
    const dune = await compose(packagesFor(["org.cgp.flora-core", "org.cgp.desert-plants", "org.cgp.dune-growth"]), {
      backend: createCrossBackend(wasm),
      policy: CROSS_POLICY,
      profileName: "dune",
    });
    assert.equal(dune.runtimeActive, true, messages(dune));
    const spring = await advanceFlora(dune, {}, "spring");
    assert.equal(spring.ok, true, spring.ok ? "" : spring.reason);
    if (!spring.ok) return;
    assert.equal(spring.strategy, "Dune growth");
    assert.equal(spring.rows.find((row) => row.id === "cactus")?.stage, 0.18);
    assert.equal(spring.rows.find((row) => row.id === "sage")?.stage, 0.48);
    assert.equal(seasonal(0.15, 6, "spring", 0), 0.17);
    const winter = await advanceFlora(dune, {}, "winter");
    if (!winter.ok) assert.fail(winter.reason);
    assert.equal(winter.rows.find((row) => row.id === "sage")?.stage, 0.02);
    const capped = await advanceFlora(dune, { cactus: 5.9 }, "spring");
    if (!capped.ok) assert.fail(capped.reason);
    assert.equal(capped.rows.find((row) => row.id === "cactus")?.stage, 6);
    await dune.shutdown();

    const seasonalRun = await compose(
      packagesFor(["org.cgp.flora-core", "org.cgp.desert-plants", "org.cgp.seasonal-growth"]),
      { policy: IN_PROCESS_POLICY },
    );
    const compared = await advanceFlora(seasonalRun, {}, "spring");
    if (!compared.ok) assert.fail(compared.reason);
    assert.equal(compared.rows.find((row) => row.id === "cactus")?.stage, 0.17);
    await seasonalRun.shutdown();
  });
});

describe("aggregate budgets", () => {
  it("counts guests, memory, and bytes per composition and clears a tighter budget", async () => {
    const backend = createWasmBackend();
    const one = storeGuest("{}");
    const crowded = await compose([pkg("org.example.one", one), pkg("org.example.two", one)], {
      backend,
      policy: wasmPolicy({ maxGuests: 1 }),
    });
    assert.equal(crowded.runtimeActive, false);
    assert.match(messages(crowded), /Module "org\.example\.two" exceeds the composition guest budget of 1\./);

    const memory = await compose([pkg("org.example.one", one), pkg("org.example.two", one)], {
      backend,
      policy: wasmPolicy({ maxTotalMemoryBytes: 65536 }),
    });
    assert.match(messages(memory), /exceeds the composition memory budget of 65536 bytes\./);

    const binary = await compose([pkg("org.example.one", one), pkg("org.example.two", one)], {
      backend,
      policy: wasmPolicy({ maxTotalBinaryBytes: one.byteLength }),
    });
    assert.match(messages(binary), new RegExp(`exceeds the composition binary budget of ${one.byteLength} bytes\\.`));

    const open = await compose([pkg("org.example.one", one), pkg("org.example.two", one)], {
      backend,
      policy: wasmPolicy(),
    });
    assert.equal(open.runtimeActive, true, messages(open));
    await open.shutdown();

    const [left, right] = await Promise.all([
      compose([pkg("org.example.left", one)], { backend, policy: wasmPolicy({ maxGuests: 1 }) }),
      compose([pkg("org.example.right", one)], { backend, policy: wasmPolicy({ maxGuests: 1 }) }),
    ]);
    assert.equal(left.runtimeActive, true, messages(left));
    assert.equal(right.runtimeActive, true, messages(right));
    await left.shutdown();
    await right.shutdown();
    assert.equal(backend.openSessions(), 0);
  });

  it("refuses another hook after the composition hook budget is spent", async () => {
    const backend = createWasmBackend();
    const result = await compose([pkg("org.example.meter", storeGuest("{}"))], {
      backend,
      policy: wasmPolicy({ maxTotalHookMs: 1, maxHookMs: 1000 }),
    });
    assert.equal(result.runtimeActive, false);
    assert.match(messages(result), /Composition hook budget exceeded\./);
  });

  it("refuses an aggregate budget the in-process backend cannot enforce", async () => {
    const result = await compose(
      [{ manifest: manifest("org.example.plain"), implementation: { register() {} } }],
      { policy: { ...IN_PROCESS_POLICY, maxGuests: 1 } },
    );
    assert.equal(result.runtimeActive, false);
    assert.match(messages(result), /cannot enforce execution or memory limits/);
  });
});

describe("lifecycle termination", () => {
  it("releases after a looping shutdown and still runs the later module", async () => {
    let aliveShut = false;
    const backend = createWasmBackend();
    const result = await compose(
      [
        pkg("org.example.zloop", shutdownLoopGuest()),
        {
          manifest: manifest("org.example.alive"),
          implementation: {
            shutdown() {
              aliveShut = true;
            },
          },
        },
      ],
      { backend: createCrossBackend(backend), policy: { ...CROSS_POLICY, maxHookMs: 200 } },
    );
    assert.equal(result.runtimeActive, true, messages(result));
    const first = result.shutdown();
    const second = result.shutdown();
    const [report, again] = await Promise.all([first, second]);
    assert.equal(report.already, false);
    assert.equal(again.already, true);
    assert.deepEqual(again.order, []);
    assert.deepEqual(report.order, ["org.example.zloop", "org.example.alive"]);
    assert.equal(aliveShut, true);
    assert.ok(report.diagnostics.some((item) => item.moduleId === "org.example.zloop"));
    const third = await result.shutdown();
    assert.equal(third.already, true);
    assert.equal(backend.openSessions(), 0);
  });

  it("enforces host ceilings across compositions and returns guest slots on release", async () => {
    const one = storeGuest("{}");
    const capped = createWasmBackend({ host: { maxGuests: 1, maxBinaryBytes: one.byteLength * 4 } });
    const first = await compose([pkg("org.example.one", one)], { backend: capped, policy: wasmPolicy() });
    assert.equal(first.runtimeActive, true, messages(first));
    const second = await compose([pkg("org.example.two", one)], { backend: capped, policy: wasmPolicy() });
    assert.match(messages(second), /exceeds the host guest budget of 1/);
    await first.shutdown();
    const third = await compose([pkg("org.example.three", one)], { backend: capped, policy: wasmPolicy() });
    assert.equal(third.runtimeActive, true, messages(third));
    await third.shutdown();
    assert.equal(capped.openSessions(), 0);

    const bytes = createWasmBackend({ host: { maxBinaryBytes: one.byteLength } });
    const crowded = await compose([pkg("org.example.a", one), pkg("org.example.b", one)], {
      backend: bytes,
      policy: wasmPolicy(),
    });
    assert.match(messages(crowded), new RegExp(`exceeds the host binary budget of ${one.byteLength} bytes`));
    assert.equal(bytes.openSessions(), 0);
  });

  it("keeps spent host hook time after the composition is released", async () => {
    const backend = createWasmBackend({ host: { maxHookMs: 1 } });
    const one = storeGuest("{}");
    const first = await compose([pkg("org.example.one", one)], { backend, policy: wasmPolicy() });
    assert.match(messages(first), /Host hook budget exceeded\./);
    const second = await compose([pkg("org.example.two", one)], { backend, policy: wasmPolicy() });
    assert.match(messages(second), /Host hook budget exceeded\./);
    assert.equal(backend.openSessions(), 0);
  });

  it("admits budgeted hook calls one at a time", async () => {
    const backend = createWasmBackend();
    const link = { connectsTo: [{ slot: "platform.systems", contract: "platform.system/1" }] };
    const result = await compose(
      [pkg("org.example.a", callLoopGuest("a"), link), pkg("org.example.b", callLoopGuest("b"), link)],
      {
      backend,
      policy: wasmPolicy({ maxHookMs: 180, maxTotalHookMs: 60_000 }),
    });
    assert.equal(result.runtimeActive, true, messages(result));
    const session = sessionOf(result);
    const handles = result.contributions.filter((item) => item.id === "a" || item.id === "b");
    assert.equal(handles.length, 2);
    const started = Date.now();
    const [left, right] = await Promise.all(handles.map((item) => session.callPayload(item.payload, [{}])));
    const elapsed = Date.now() - started;
    assert.equal(left.ok, false);
    assert.equal(right.ok, false);
    if (left.ok || left.code !== "threw") assert.fail("expected the first call to hit the time limit");
    assert.match(String(left.error), /Time limit exceeded/);
    assert.ok(elapsed >= 300, `budgeted calls overlapped or returned early (${elapsed}ms)`);
    await result.shutdown();
    assert.equal(backend.openSessions(), 0);
  });
});

describe("host lifecycle", () => {
  const link = { connectsTo: [{ slot: "platform.systems", contract: "platform.system/1" }] };

  it("charges declared memory and returns it after release", async () => {
    const one = storeGuest("{}");
    const backend = createWasmBackend({ host: { maxMemoryBytes: 65536 } });
    const first = await compose([pkg("org.example.one", one)], { backend, policy: wasmPolicy() });
    assert.equal(first.runtimeActive, true, messages(first));
    assert.equal(backend.resourceUsage().guests, 1);
    assert.equal(backend.resourceUsage().memoryBytes, 65536);
    assert.equal(backend.resourceUsage().binaryBytes, one.byteLength);
    const second = await compose([pkg("org.example.two", one)], { backend, policy: wasmPolicy() });
    assert.match(messages(second), /exceeds the host memory budget of 65536 bytes/);
    assert.equal(backend.resourceUsage().memoryBytes, 65536);
    await first.shutdown();
    assert.equal(backend.resourceUsage().guests, 0);
    assert.equal(backend.resourceUsage().memoryBytes, 0);
    assert.equal(backend.resourceUsage().binaryBytes, 0);
    await backend.dispose();
  });

  it("refunds a failed initialize and a failed instantiation", async () => {
    const backend = createWasmBackend({ host: { maxGuests: 1, maxMemoryBytes: 65536 } });
    const fault = await compose([pkg("org.example.fault", initFaultGuest(), link)], { backend, policy: wasmPolicy() });
    assert.equal(fault.runtimeActive, false);
    assert.match(messages(fault), /initialize|Guest hook status 1/i);
    assert.equal(backend.resourceUsage().guests, 0);
    assert.equal(backend.resourceUsage().memoryBytes, 0);
    const missing = await compose([pkg("org.example.missing", missingAbiGuest())], { backend, policy: wasmPolicy() });
    assert.equal(missing.runtimeActive, false);
    assert.match(messages(missing), /did not export the ABI/);
    assert.equal(backend.resourceUsage().guests, 0);
    assert.equal(backend.resourceUsage().memoryBytes, 0);
    const recovered = await compose([pkg("org.example.ok", storeGuest("{}"))], { backend, policy: wasmPolicy() });
    assert.equal(recovered.runtimeActive, true, messages(recovered));
    await recovered.shutdown();
    assert.equal(backend.openSessions(), 0);
  });

  it("recreates compositions and disposes while shutdown is in flight", async () => {
    const backend = createWasmBackend({ host: { maxGuests: 2, maxMemoryBytes: 65536 * 2 } });
    const one = storeGuest("{}");
    for (let i = 0; i < 6; i += 1) {
      const result = await compose([pkg(`org.example.m${i}`, one)], { backend, policy: wasmPolicy() });
      assert.equal(result.runtimeActive, true, messages(result));
      await result.shutdown();
      assert.equal(backend.resourceUsage().guests, 0);
      assert.equal(backend.resourceUsage().memoryBytes, 0);
    }
    const batch = await Promise.all(
      [0, 1, 2, 3].map((i) => compose([pkg(`org.example.c${i}`, one)], { backend, policy: wasmPolicy() })),
    );
    const active = batch.filter((result) => result.runtimeActive);
    assert.equal(active.length, 2, batch.map((result) => messages(result)).join("\n"));
    assert.equal(backend.resourceUsage().guests, 2);
    assert.equal(backend.resourceUsage().memoryBytes, 131072);
    await Promise.all(batch.map((result) => result.shutdown()));
    assert.equal(backend.resourceUsage().guests, 0);
    assert.equal(backend.resourceUsage().memoryBytes, 0);

    const live = await compose([pkg("org.example.live", one)], { backend, policy: wasmPolicy() });
    assert.equal(live.runtimeActive, true, messages(live));
    await Promise.all([live.shutdown(), backend.dispose(), live.shutdown()]);
    assert.equal(backend.openSessions(), 0);
    assert.equal(backend.resourceUsage().guests, 0);
    const refused = await compose([pkg("org.example.after", one)], { backend, policy: wasmPolicy() });
    assert.equal(refused.runtimeActive, false);
    assert.match(messages(refused), /disposed/);
  });
});

describe("shipped wasm bytes", () => {
  it("matches the guest generator and the template module", () => {
    const dune = duneGrowthGuest();
    assert.deepEqual(duneWasmBytes, dune);
    assert.deepEqual(new Uint8Array(readFileSync(join(root, "src/modules/org.cgp.dune-growth/module.wasm"))), dune);
    assert.deepEqual(new Uint8Array(readFileSync(join(root, "examples/wasm-module/module.wasm"))), templateGuest());
  });
});
