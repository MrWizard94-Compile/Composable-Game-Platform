import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { CROSS_POLICY, createCrossBackend } from "../foundations/cross-backend.ts";
import { compose, type ModulePackage } from "../foundations/host.ts";
import { captureSave, restoreSave } from "../foundations/save.ts";
import { createWasmBackend, type WasmBackend } from "../foundations/wasm-backend.ts";
import { boundGuest } from "./org.cgp.sim-bound/guest.ts";
import { SIM_IDS, moduleIdOf, packagesFor } from "./registry.ts";
import { advanceSimulation, readSimulation, seedSimulation, type SimDrive, type SimEntity, type SimStep } from "./sim.ts";

const DRIVES: SimDrive[] = [
  { id: "e1", vx: 1, vy: 2 },
  { id: "e2", vx: -1, vy: 0 },
];

function at(steps: number): SimEntity[] {
  return [
    { id: "e1", x: Math.min(1000, steps), y: Math.min(1000, steps * 2) },
    { id: "e2", x: Math.max(0, 10 - steps), y: 0 },
  ];
}

function messages(result: { diagnostics: Array<{ message: string }> }): string {
  return result.diagnostics.map((item) => item.message).join("\n");
}

function slice(document: { slices: Array<{ moduleId: string; payload: unknown }> }, moduleId: string): unknown {
  return document.slices.find((item) => item.moduleId === moduleId)?.payload;
}

async function open(packages: readonly ModulePackage[], wasm: WasmBackend, profileName = "sim") {
  const result = await compose(packages, { backend: createCrossBackend(wasm), policy: CROSS_POLICY, profileName });
  assert.equal(result.runtimeActive, true, messages(result));
  assert.equal(result.backendId, "cross");
  return result;
}

async function plant(result: Awaited<ReturnType<typeof open>>, first: SimEntity, second: SimEntity) {
  assert.equal((await seedSimulation(result, first)).ok, true);
  assert.equal((await seedSimulation(result, second)).ok, true);
}

async function run(result: Awaited<ReturnType<typeof open>>, from: number, count: number, inputs: readonly SimDrive[] = DRIVES) {
  const steps: Array<Extract<SimStep, { ok: true }>> = [];
  for (let offset = 0; offset < count; offset += 1) {
    const step = await advanceSimulation(result, { tick: from + offset, delta: 1, inputs });
    if (!step.ok) assert.fail(step.reason);
    steps.push(step);
  }
  return steps;
}

function manifest(moduleId: string, extra: Record<string, unknown>) {
  return {
    moduleId,
    name: moduleId.split(".").at(-1) ?? moduleId,
    version: "1.0.0",
    moduleApi: ">=1.0.0 <2.0.0",
    ...extra,
  };
}

describe("deterministic simulation", () => {
  it("does not schedule itself", () => {
    const source = readFileSync(new URL("./sim.ts", import.meta.url), "utf8");
    for (const word of ["setTimeout", "setInterval", "setImmediate", "requestAnimationFrame", "queueMicrotask", "performance.now", "Date.now"]) {
      assert.equal(source.includes(word), false, word);
    }
  });

  it("clamps a move inside the guest", () => {
    const bytes = boundGuest();
    const copy = new ArrayBuffer(bytes.byteLength);
    const copied = new Uint8Array(copy);
    for (let index = 0; index < bytes.length; index += 1) copied[index] = bytes[index] ?? 0;
    const exp = new WebAssembly.Instance(new WebAssembly.Module(copy)).exports as {
      memory: WebAssembly.Memory;
      cg_alloc: (size: number) => number;
      cg_hook: (hook: number, ptr: number, len: number) => number;
      cg_out_ptr: () => number;
      cg_out_len: () => number;
    };
    const proposal = {
      tick: 1,
      delta: 1,
      inputs: [{ id: "e1", vx: 1, vy: 0 }],
      entities: [{ id: "e1", x: 0, y: 0 }],
      commands: [{ op: "move", id: "e1", x: -3, y: 5000 }],
    };
    const encoded = new TextEncoder().encode(JSON.stringify({ contributionId: "bound", arg: proposal, args: [proposal] }));
    const ptr = exp.cg_alloc(encoded.length);
    const memoryBytes = new Uint8Array(exp.memory.buffer);
    for (let index = 0; index < encoded.length; index += 1) memoryBytes[ptr + index] = encoded[index] ?? 0;
    assert.equal(exp.cg_hook(5, ptr, encoded.length), 0);
    const out = new TextDecoder().decode(
      new Uint8Array(exp.memory.buffer).subarray(exp.cg_out_ptr(), exp.cg_out_ptr() + exp.cg_out_len()),
    );
    const parsed = JSON.parse(out) as { commands: Array<{ x: number; y: number }> };
    assert.deepEqual(parsed.commands, [{ op: "move", id: "e1", x: 0, y: 1000 }]);
  });

  it("stays put until a caller asks, and refuses a tick that is not next", async () => {
    const wasm = createWasmBackend();
    try {
      const result = await open(packagesFor([...SIM_IDS]), wasm);
      await plant(result, { id: "e1", x: 0, y: 0 }, { id: "e2", x: 10, y: 0 });
      const before = await readSimulation(result);
      if (!before.ok) assert.fail(before.reason);
      const again = await readSimulation(result);
      if (!again.ok) assert.fail(again.reason);
      assert.deepEqual(again.state, before.state);
      assert.equal(again.state.tick, 0);

      const skipped = await advanceSimulation(result, { tick: 2, delta: 1, inputs: DRIVES });
      assert.equal(skipped.ok, false);
      if (skipped.ok) return;
      assert.equal(skipped.reason, "Tick must be the next integer.");
      const stalled = await advanceSimulation(result, { tick: 1, delta: 0, inputs: DRIVES });
      assert.equal(stalled.ok, false);
      if (stalled.ok) return;
      assert.equal(stalled.reason, "Delta must be a positive integer.");
      const idle = await readSimulation(result);
      if (!idle.ok) assert.fail(idle.reason);
      assert.deepEqual(idle.state, before.state);

      const step = await advanceSimulation(result, { tick: 1, delta: 4, inputs: [{ id: "e1", vx: 3, vy: -1 }] });
      if (!step.ok) assert.fail(step.reason);
      assert.deepEqual(step.entities, [
        { id: "e1", x: 12, y: 0 },
        { id: "e2", x: 10, y: 0 },
      ]);
      assert.deepEqual(
        step.stages.map((item) => item.id),
        ["move", "bound"],
      );
      assert.equal(step.deliveries, 1);
      const repeat = await advanceSimulation(result, { tick: 1, delta: 1, inputs: DRIVES });
      assert.equal(repeat.ok, false);
      const closed = await seedSimulation(result, { id: "e3", x: 1, y: 1 });
      assert.equal(closed.ok, false);
      if (closed.ok) return;
      assert.match(closed.reason, /closed/);
      const after = await readSimulation(result);
      if (!after.ok) assert.fail(after.reason);
      assert.equal(after.state.tick, 1);
      assert.equal(after.state.entities.length, 2);

      await result.shutdown();
      assert.equal(wasm.openSessions(), 0);
      assert.equal(wasm.resourceUsage().guests, 0);
      assert.equal(wasm.resourceUsage().memoryBytes, 0);
      assert.equal(wasm.resourceUsage().binaryBytes, 0);
    } finally {
      await wasm.dispose();
    }
  });

  it("replays 100 steps from a save and ignores package order", async () => {
    const wasm = createWasmBackend();
    try {
      const packages = packagesFor([...SIM_IDS]);
      const forward = await open(packages, wasm, "sim-forward");
      const reverse = await open([...packages].reverse(), wasm, "sim-reverse");
      assert.equal(forward.fingerprint, reverse.fingerprint);
      assert.notDeepEqual(packages.map((item) => moduleIdOf(item.manifest)), [...packages].reverse().map((item) => moduleIdOf(item.manifest)));
      await plant(forward, { id: "e1", x: 0, y: 0 }, { id: "e2", x: 10, y: 0 });
      await plant(reverse, { id: "e2", x: 10, y: 0 }, { id: "e1", x: 0, y: 0 });

      const first = await run(forward, 1, 50);
      const other = await run(reverse, 1, 50, [...DRIVES].reverse());
      assert.deepEqual(first[10]?.entities, at(11));
      assert.deepEqual(first[49]?.entities, at(50));
      assert.deepEqual(other[49]?.entities, at(50));
      assert.deepEqual(
        other[0]?.stages.map((item) => `${item.id}@${item.moduleId}`),
        first[0]?.stages.map((item) => `${item.id}@${item.moduleId}`),
      );

      const saved = await captureSave(forward);
      assert.equal(saved.ok, true, saved.notices.map((item) => item.message).join("\n"));
      assert.deepEqual(slice(saved.document, "org.cgp.sim-ledger"), { tick: 50, entities: at(50) });
      assert.deepEqual(slice(saved.document, "org.cgp.sim-witness"), { heard: Array.from({ length: 50 }, (_, index) => index + 1) });

      const restored = await open(packages, wasm, "sim-forward");
      const applied = await restoreSave(restored, saved.document);
      assert.equal(applied.ok, true, applied.notices.map((item) => item.message).join("\n"));
      await run(restored, 51, 50);
      await run(forward, 51, 50);
      await run(reverse, 51, 50, [...DRIVES].reverse());

      const uninterrupted = await captureSave(forward);
      const resumed = await captureSave(restored);
      const reordered = await captureSave(reverse);
      assert.deepEqual(slice(uninterrupted.document, "org.cgp.sim-ledger"), { tick: 100, entities: at(100) });
      assert.deepEqual(slice(resumed.document, "org.cgp.sim-ledger"), slice(uninterrupted.document, "org.cgp.sim-ledger"));
      assert.deepEqual(slice(reordered.document, "org.cgp.sim-ledger"), slice(uninterrupted.document, "org.cgp.sim-ledger"));
      assert.deepEqual(slice(resumed.document, "org.cgp.sim-witness"), { heard: Array.from({ length: 100 }, (_, index) => index + 1) });
      assert.deepEqual(slice(reordered.document, "org.cgp.sim-witness"), slice(uninterrupted.document, "org.cgp.sim-witness"));

      await forward.shutdown();
      await reverse.shutdown();
      await restored.shutdown();
      assert.equal(wasm.openSessions(), 0);
      assert.equal(wasm.resourceUsage().guests, 0);
      assert.equal(wasm.resourceUsage().memoryBytes, 0);
      assert.equal(wasm.resourceUsage().binaryBytes, 0);
    } finally {
      await wasm.dispose();
    }
  });

  it("does not commit a step whose pipeline fails or whose commands are out of range", async () => {
    const wasm = createWasmBackend();
    try {
      let halt = true;
      const halting: ModulePackage = {
        manifest: manifest("org.example.sim-halt", {
          requires: [{ capability: "sim.core", version: "^1.0.0" }],
          connectsTo: [{ slot: "sim.systems", contract: "sim.systems/1" }],
        }),
        implementation: {
          register(ctx) {
            ctx.contribute("sim.systems", {
              id: "halt",
              order: 15,
              payload(input: unknown) {
                const tick = input && typeof input === "object" && "tick" in input ? (input as { tick?: unknown }).tick : undefined;
                if (tick === 2 && halt) {
                  halt = false;
                  throw new Error("halted the step");
                }
                return input;
              },
            });
          },
        },
      };
      let skew = true;
      const skewing: ModulePackage = {
        manifest: manifest("org.example.sim-skew", {
          requires: [{ capability: "sim.core", version: "^1.0.0" }],
          connectsTo: [{ slot: "sim.systems", contract: "sim.systems/1" }],
        }),
        implementation: {
          register(ctx) {
            ctx.contribute("sim.systems", {
              id: "skew",
              order: 30,
              payload(input: unknown) {
                if (!skew || !input || typeof input !== "object" || !("commands" in input)) return input;
                const commands = (input as { commands?: unknown }).commands;
                if (!Array.isArray(commands)) return input;
                skew = false;
                return {
                  ...input,
                  commands: commands.map((command, index) => (index === 0 && command && typeof command === "object" ? { ...command, x: -4 } : command)),
                };
              },
            });
          },
        },
      };
      const packages = packagesFor([...SIM_IDS]);
      const halted = await open([...packages, halting], wasm, "sim-halt");
      await plant(halted, { id: "e1", x: 0, y: 0 }, { id: "e2", x: 10, y: 0 });
      const moved = await run(halted, 1, 1);
      const blocked = await advanceSimulation(halted, { tick: 2, delta: 1, inputs: DRIVES });
      assert.equal(blocked.ok, false);
      if (blocked.ok) return;
      assert.equal(blocked.reason, "halted the step");
      assert.deepEqual(
        blocked.stages.map((item) => item.id),
        ["move", "halt"],
      );
      const held = await readSimulation(halted);
      if (!held.ok) assert.fail(held.reason);
      assert.equal(held.state.tick, 1);
      assert.deepEqual(held.state.entities, moved[0]?.entities);
      const retried = await run(halted, 2, 1);
      assert.deepEqual(retried[0]?.entities, at(2));

      const rejected = await open([...packages, skewing], wasm, "sim-skew");
      await plant(rejected, { id: "e1", x: 0, y: 0 }, { id: "e2", x: 10, y: 0 });
      const denied = await advanceSimulation(rejected, { tick: 1, delta: 1, inputs: DRIVES });
      assert.equal(denied.ok, false);
      if (denied.ok) return;
      assert.equal(denied.reason, "Simulation proposal is not a complete step.");
      assert.deepEqual(
        denied.stages.map((item) => `${item.id}:${item.ok}`),
        ["move:true", "bound:true", "skew:true"],
      );
      const untouched = await readSimulation(rejected);
      if (!untouched.ok) assert.fail(untouched.reason);
      assert.equal(untouched.state.tick, 0);
      assert.deepEqual(untouched.state.entities, [
        { id: "e1", x: 0, y: 0 },
        { id: "e2", x: 10, y: 0 },
      ]);
      const accepted = await run(rejected, 1, 1);
      assert.deepEqual(accepted[0]?.entities, at(1));

      await halted.shutdown();
      await rejected.shutdown();
      assert.equal(wasm.openSessions(), 0);
      assert.equal(wasm.resourceUsage().guests, 0);
      assert.equal(wasm.resourceUsage().memoryBytes, 0);
      assert.equal(wasm.resourceUsage().binaryBytes, 0);
    } finally {
      await wasm.dispose();
    }
  });
});
