import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { IN_PROCESS_POLICY, type ExecutionPolicy } from "./backend.ts";
import { CROSS_POLICY, createCrossBackend } from "./cross-backend.ts";
import { publish } from "./dispatch.ts";
import { compose, sessionOf, type ModulePackage } from "./host.ts";
import { counterGuest, shutdownLoopGuest, storeGuest, templateGuest } from "./wasm-build.ts";
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
});

describe("shipped wasm bytes", () => {
  it("matches the guest generator and the template module", () => {
    const dune = duneGrowthGuest();
    assert.deepEqual(duneWasmBytes, dune);
    assert.deepEqual(new Uint8Array(readFileSync(join(root, "src/modules/org.cgp.dune-growth/module.wasm"))), dune);
    assert.deepEqual(new Uint8Array(readFileSync(join(root, "examples/wasm-module/module.wasm"))), templateGuest());
  });
});
