import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { CROSS_POLICY, createCrossBackend } from "../foundations/cross-backend.ts";
import { callService } from "../foundations/dispatch.ts";
import { isAbiHandle } from "../foundations/abi.ts";
import { compose, type ModulePackage } from "../foundations/host.ts";
import { captureSave, restoreSave } from "../foundations/save.ts";
import { createWasmBackend, type WasmBackend } from "../foundations/wasm-backend.ts";
import { runBrowserSimulationCheck } from "../../scripts/browser-wasm.ts";
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
      assert.equal(typeof result.contributions.find((item) => item.id === "move")?.payload, "function");
      assert.equal(isAbiHandle(result.contributions.find((item) => item.id === "bound")?.payload), true);
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

  it("enforces the ledger rules on a direct service call", async () => {
    const wasm = createWasmBackend();
    try {
      const result = await open(packagesFor([...SIM_IDS]), wasm, "sim-direct");
      const outside = await seedSimulation(result, { id: "e1", x: 1001, y: 0 });
      assert.equal(outside.ok, false);
      if (outside.ok) return;
      assert.match(outside.reason, /outside 0 through 1000/);
      const fractional = await seedSimulation(result, { id: "e1", x: 1.5, y: 0 });
      assert.equal(fractional.ok, false);
      if (fractional.ok) return;
      assert.match(fractional.reason, /integer entity/);
      const empty = await readSimulation(result);
      if (!empty.ok) assert.fail(empty.reason);
      assert.equal(empty.state.entities.length, 0);

      assert.equal((await seedSimulation(result, { id: "e1", x: 0, y: 0 })).ok, true);
      assert.equal((await seedSimulation(result, { id: "e2", x: 1000, y: 1000 })).ok, true);
      const read = await readSimulation(result);
      if (!read.ok) assert.fail(read.reason);
      const same = read.state.entities.map((item) => ({ id: item.id, x: item.x, y: item.y }));
      const saved = await captureSave(result);
      assert.equal(saved.ok, true);
      const hostile = structuredClone(saved.document);
      const ledger = hostile.slices.find((item) => item.moduleId === "org.cgp.sim-ledger");
      assert.ok(ledger);
      ledger.payload = {
        tick: 0,
        entities: [
          { id: "e1", x: 1001, y: 0 },
          { id: "e2", x: 1000, y: 1000 },
        ],
      };
      const restored = await restoreSave(result, hostile);
      assert.equal(restored.ok, false);
      assert.match(restored.notices.map((item) => item.message).join("\n"), /outside 0 through 1000/);
      const kept = await readSimulation(result);
      if (!kept.ok) assert.fail(kept.reason);
      assert.deepEqual(kept.state.entities, same);

      const closed = await callService(result, "sim.commit", { tick: 1, entities: same });
      assert.equal(closed.ok, false);
      assert.match(closed.message ?? "", /not an open step/);
      const jump = await callService(result, "sim.commit", { phase: "open", tick: 5 });
      assert.equal(jump.ok, false);
      assert.match(jump.message ?? "", /next tick/);
      const opened = await callService(result, "sim.commit", { phase: "open", tick: 1 });
      assert.equal(opened.ok, true, opened.message ?? opened.reason ?? "");
      const again = await callService(result, "sim.commit", { phase: "open", tick: 1 });
      assert.equal(again.ok, false);
      assert.match(again.message ?? "", /already open/);
      const low = await callService(result, "sim.commit", {
        tick: 1,
        entities: same.map((item, index) => (index === 0 ? { ...item, x: -1 } : item)),
      });
      assert.equal(low.ok, false);
      assert.match(low.message ?? "", /outside 0 through 1000/);
      const swapped = await callService(result, "sim.commit", { tick: 1, entities: [...same].reverse() });
      assert.equal(swapped.ok, false);
      assert.match(swapped.message ?? "", /entity set/);
      const stale = await callService(result, "sim.commit", { tick: 2, entities: same });
      assert.equal(stale.ok, false);
      assert.match(stale.message ?? "", /next tick/);
      const held = await readSimulation(result);
      if (!held.ok) assert.fail(held.reason);
      assert.equal(held.state.tick, 0);
      assert.deepEqual(held.state.entities, same);

      assert.equal((await callService(result, "sim.commit", { phase: "abort" })).ok, true);
      assert.equal((await callService(result, "sim.commit", { phase: "open", tick: 1 })).ok, true);
      const accepted = await callService(result, "sim.commit", { tick: 1, entities: same });
      assert.equal(accepted.ok, true, accepted.message ?? accepted.reason ?? "");
      const after = await readSimulation(result);
      if (!after.ok) assert.fail(after.reason);
      assert.equal(after.state.tick, 1);
      assert.deepEqual(after.state.entities, [
        { id: "e1", x: 0, y: 0 },
        { id: "e2", x: 1000, y: 1000 },
      ]);
      const witness = await captureSave(result);
      assert.deepEqual(slice(witness.document, "org.cgp.sim-witness"), { heard: [] });
      const replay = await callService(result, "sim.commit", { phase: "open", tick: 1 });
      assert.equal(replay.ok, false);
      assert.match(replay.message ?? "", /next tick/);
      const skip = await callService(result, "sim.commit", { phase: "open", tick: 3 });
      assert.equal(skip.ok, false);
      assert.match(skip.message ?? "", /next tick/);
      const still = await readSimulation(result);
      if (!still.ok) assert.fail(still.reason);
      assert.equal(still.state.tick, 1);
      assert.deepEqual(still.state.entities, after.state.entities);

      await result.shutdown();
      assert.equal(wasm.openSessions(), 0);
      assert.equal(wasm.resourceUsage().guests, 0);
      assert.equal(wasm.resourceUsage().memoryBytes, 0);
      assert.equal(wasm.resourceUsage().binaryBytes, 0);
    } finally {
      await wasm.dispose();
    }
  });

  it("runs one step at a time and refuses a seed while that step is open", async () => {
    const wasm = createWasmBackend();
    try {
      const result = await open(packagesFor([...SIM_IDS]), wasm, "sim-race");
      await plant(result, { id: "e1", x: 0, y: 0 }, { id: "e2", x: 10, y: 0 });
      const [first, second] = await Promise.all([
        advanceSimulation(result, { tick: 1, delta: 1, inputs: DRIVES }),
        advanceSimulation(result, { tick: 1, delta: 1, inputs: DRIVES }),
      ]);
      assert.equal(first.ok, true, first.ok ? "" : first.reason);
      assert.equal(second.ok, false);
      if (second.ok) return;
      assert.equal(second.reason, "Tick must be the next integer.");
      const raced = await readSimulation(result);
      if (!raced.ok) assert.fail(raced.reason);
      assert.equal(raced.state.tick, 1);
      assert.deepEqual(raced.state.entities, at(1));

      const [late, early] = await Promise.all([
        advanceSimulation(result, { tick: 3, delta: 1, inputs: DRIVES }),
        advanceSimulation(result, { tick: 2, delta: 1, inputs: DRIVES }),
      ]);
      assert.equal(late.ok, false);
      if (late.ok) return;
      assert.equal(late.reason, "Tick must be the next integer.");
      assert.equal(early.ok, true, early.ok ? "" : early.reason);
      const [third, fourth] = await Promise.all([
        advanceSimulation(result, { tick: 3, delta: 1, inputs: DRIVES }),
        advanceSimulation(result, { tick: 4, delta: 1, inputs: DRIVES }),
      ]);
      assert.equal(third.ok, true, third.ok ? "" : third.reason);
      assert.equal(fourth.ok, true, fourth.ok ? "" : fourth.reason);
      const ordered = await captureSave(result);
      assert.deepEqual(slice(ordered.document, "org.cgp.sim-ledger"), { tick: 4, entities: at(4) });
      assert.deepEqual(slice(ordered.document, "org.cgp.sim-witness"), { heard: [1, 2, 3, 4] });

      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let mark = () => {};
      const entered = new Promise<void>((resolve) => {
        mark = resolve;
      });
      const stalled = await open([...packagesFor([...SIM_IDS]), stalling(mark, gate)], wasm, "sim-open");
      await plant(stalled, { id: "e1", x: 0, y: 0 }, { id: "e2", x: 10, y: 0 });
      const pending = advanceSimulation(stalled, { tick: 1, delta: 1, inputs: DRIVES });
      await entered;
      const conflict = await callService(stalled, "sim.seed", { id: "e3", x: 4, y: 4 });
      assert.equal(conflict.ok, false);
      assert.match(conflict.message ?? "", /conflicts with an open step/);
      const bad = await callService(stalled, "sim.commit", {
        tick: 1,
        entities: [
          { id: "e1", x: -1, y: 0 },
          { id: "e2", x: 10, y: 0 },
        ],
      });
      assert.equal(bad.ok, false);
      assert.match(bad.message ?? "", /outside 0 through 1000/);
      const mid = await readSimulation(stalled);
      if (!mid.ok) assert.fail(mid.reason);
      assert.equal(mid.state.tick, 0);
      assert.equal(mid.state.entities.length, 2);
      const snap = await captureSave(stalled);
      const hostile = structuredClone(snap.document);
      const witness = hostile.slices.find((item) => item.moduleId === "org.cgp.sim-witness");
      assert.ok(witness);
      witness.payload = { heard: [99] };
      const denied = await restoreSave(stalled, hostile);
      assert.equal(denied.ok, false);
      assert.deepEqual(denied.applied, []);
      assert.match(denied.notices.map((item) => item.message).join("\n"), /conflicts with an open step/);
      const during = await captureSave(stalled);
      assert.deepEqual(slice(during.document, "org.cgp.sim-ledger"), slice(snap.document, "org.cgp.sim-ledger"));
      assert.deepEqual(slice(during.document, "org.cgp.sim-witness"), { heard: [] });
      const secondOpen = await callService(stalled, "sim.commit", { phase: "open", tick: 1 });
      assert.equal(secondOpen.ok, false);
      assert.match(secondOpen.message ?? "", /already open/);
      let seedFinished = false;
      const seeding = seedSimulation(stalled, { id: "e3", x: 3, y: 3 }).then((report) => {
        seedFinished = true;
        return report;
      });
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
      assert.equal(seedFinished, false);
      release();
      const step = await pending;
      assert.equal(step.ok, true, step.ok ? "" : step.reason);
      const seeded = await seeding;
      assert.equal(seedFinished, true);
      assert.equal(seeded.ok, false);
      if (seeded.ok) return;
      assert.match(seeded.reason, /closed/);
      const done = await captureSave(stalled);
      assert.deepEqual(slice(done.document, "org.cgp.sim-ledger"), { tick: 1, entities: at(1) });
      assert.deepEqual(slice(done.document, "org.cgp.sim-witness"), { heard: [1] });

      await result.shutdown();
      await stalled.shutdown();
      assert.equal(wasm.openSessions(), 0);
      assert.equal(wasm.resourceUsage().guests, 0);
      assert.equal(wasm.resourceUsage().memoryBytes, 0);
      assert.equal(wasm.resourceUsage().binaryBytes, 0);
    } finally {
      await wasm.dispose();
    }
  });

  it("lets a direct commit take the open step and does not publish that step twice", async () => {
    const wasm = createWasmBackend();
    try {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let mark = () => {};
      const entered = new Promise<void>((resolve) => {
        mark = resolve;
      });
      const result = await open([...packagesFor([...SIM_IDS]), stalling(mark, gate)], wasm, "sim-steal");
      await plant(result, { id: "e1", x: 0, y: 0 }, { id: "e2", x: 10, y: 0 });
      const pending = advanceSimulation(result, { tick: 1, delta: 1, inputs: DRIVES });
      await entered;
      const current = await readSimulation(result);
      if (!current.ok) assert.fail(current.reason);
      const taken = await callService(result, "sim.commit", { tick: 1, entities: current.state.entities });
      assert.equal(taken.ok, true, taken.message ?? taken.reason ?? "");
      release();
      const step = await pending;
      assert.equal(step.ok, false);
      if (step.ok) return;
      assert.match(step.reason, /not an open step/);
      const saved = await captureSave(result);
      assert.deepEqual(slice(saved.document, "org.cgp.sim-ledger"), {
        tick: 1,
        entities: [
          { id: "e1", x: 0, y: 0 },
          { id: "e2", x: 10, y: 0 },
        ],
      });
      assert.deepEqual(slice(saved.document, "org.cgp.sim-witness"), { heard: [] });

      await result.shutdown();
      assert.equal(wasm.openSessions(), 0);
      assert.equal(wasm.resourceUsage().guests, 0);
    } finally {
      await wasm.dispose();
    }
  });

  it("does not keep a rejected step in authoritative state or on the completion slot", async () => {
    const wasm = createWasmBackend();
    try {
      const scratch = { n: 0 };
      const noted: number[] = [];
      const halted = await open([...packagesFor([...SIM_IDS]), noting(scratch, noted), haltingAlways()], wasm, "sim-scratch");
      await plant(halted, { id: "e1", x: 0, y: 0 }, { id: "e2", x: 10, y: 0 });
      const blocked = await advanceSimulation(halted, { tick: 1, delta: 1, inputs: DRIVES });
      assert.equal(blocked.ok, false);
      if (blocked.ok) return;
      assert.equal(blocked.reason, "halted the step");
      assert.equal(scratch.n, 1);
      assert.deepEqual(noted, []);
      const held = await captureSave(halted);
      assert.deepEqual(slice(held.document, "org.cgp.sim-ledger"), {
        tick: 0,
        entities: [
          { id: "e1", x: 0, y: 0 },
          { id: "e2", x: 10, y: 0 },
        ],
      });
      assert.deepEqual(slice(held.document, "org.cgp.sim-witness"), { heard: [] });

      const scratchOnly = { n: 0 };
      const notedOnly: number[] = [];
      const clean = await open([...packagesFor([...SIM_IDS]), noting(scratchOnly, notedOnly)], wasm, "sim-note");
      await plant(clean, { id: "e1", x: 0, y: 0 }, { id: "e2", x: 10, y: 0 });
      const step = await advanceSimulation(clean, { tick: 1, delta: 1, inputs: DRIVES });
      assert.equal(step.ok, true, step.ok ? "" : step.reason);
      assert.equal(scratchOnly.n, 1);
      assert.deepEqual(notedOnly, [1]);
      const saved = await captureSave(clean);
      assert.deepEqual(slice(saved.document, "org.cgp.sim-witness"), { heard: [1] });
      assert.deepEqual(slice(saved.document, "org.cgp.sim-ledger"), { tick: 1, entities: at(1) });

      await halted.shutdown();
      await clean.shutdown();
      assert.equal(wasm.openSessions(), 0);
      assert.equal(wasm.resourceUsage().guests, 0);
      assert.equal(wasm.resourceUsage().memoryBytes, 0);
      assert.equal(wasm.resourceUsage().binaryBytes, 0);
    } finally {
      await wasm.dispose();
    }
  });

  it("reports a completion subscriber failure without rolling the commit back", async () => {
    const wasm = createWasmBackend();
    try {
      const noted: number[] = [];
      const result = await open(
        [...packagesFor([...SIM_IDS]), noting({ n: 0 }, noted), breakingSubscriber()],
        wasm,
        "sim-subscriber",
      );
      await plant(result, { id: "e1", x: 0, y: 0 }, { id: "e2", x: 10, y: 0 });
      const step = await advanceSimulation(result, { tick: 1, delta: 1, inputs: DRIVES });
      assert.equal(step.ok, true, step.ok ? "" : step.reason);
      if (!step.ok) return;
      assert.deepEqual(step.failures, [{ moduleId: "org.example.sim-break", id: "break", message: "subscriber broke" }]);
      assert.deepEqual(noted, [1]);
      const saved = await captureSave(result);
      assert.deepEqual(slice(saved.document, "org.cgp.sim-ledger"), { tick: 1, entities: at(1) });
      assert.deepEqual(slice(saved.document, "org.cgp.sim-witness"), { heard: [1] });
      const repeated = await advanceSimulation(result, { tick: 1, delta: 1, inputs: DRIVES });
      assert.equal(repeated.ok, false);
      if (repeated.ok) return;
      assert.equal(repeated.reason, "Tick must be the next integer.");
      const held = await readSimulation(result);
      if (!held.ok) assert.fail(held.reason);
      assert.equal(held.state.tick, 1);

      await result.shutdown();
      assert.equal(wasm.openSessions(), 0);
      assert.equal(wasm.resourceUsage().guests, 0);
      assert.equal(wasm.resourceUsage().memoryBytes, 0);
      assert.equal(wasm.resourceUsage().binaryBytes, 0);
    } finally {
      await wasm.dispose();
    }
  });

  it("releases the isolate when shutdown arrives during an open step", async () => {
    const wasm = createWasmBackend();
    try {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let mark = () => {};
      const entered = new Promise<void>((resolve) => {
        mark = resolve;
      });
      const result = await open([...packagesFor([...SIM_IDS]), stalling(mark, gate)], wasm, "sim-stop");
      await plant(result, { id: "e1", x: 0, y: 0 }, { id: "e2", x: 10, y: 0 });
      const pending = advanceSimulation(result, { tick: 1, delta: 1, inputs: DRIVES });
      await entered;
      assert.equal(wasm.resourceUsage().guests > 0, true);
      const before = await captureSave(result);
      assert.deepEqual(slice(before.document, "org.cgp.sim-ledger"), {
        tick: 0,
        entities: [
          { id: "e1", x: 0, y: 0 },
          { id: "e2", x: 10, y: 0 },
        ],
      });
      assert.deepEqual(slice(before.document, "org.cgp.sim-witness"), { heard: [] });
      const second = advanceSimulation(result, { tick: 2, delta: 1, inputs: DRIVES });
      const stopping = result.shutdown();
      release();
      const [step, followed] = await Promise.all([pending, second, stopping]);
      assert.equal(step.ok, false);
      if (step.ok) return;
      assert.match(step.reason, /shut down|released/);
      assert.equal(followed.ok, false);
      if (followed.ok) return;
      assert.match(followed.reason, /shut down/);
      assert.equal(wasm.openSessions(), 0);
      assert.equal(wasm.resourceUsage().guests, 0);
      assert.equal(wasm.resourceUsage().memoryBytes, 0);
      assert.equal(wasm.resourceUsage().binaryBytes, 0);
    } finally {
      await wasm.dispose();
    }
  });

  it("matches the mixed proof in Chromium, including after save and restore", { timeout: 90_000 }, async () => {
    const report = await runBrowserSimulationCheck();
    const heard = Array.from({ length: 80 }, (_, index) => index + 1);
    assert.equal(report.mixed, true);
    assert.deepEqual(report.continuous, { tick: 80, entities: at(80) });
    assert.deepEqual(report.resumed, { tick: 80, entities: at(80) });
    assert.deepEqual(report.heardContinuous, { heard });
    assert.deepEqual(report.heardResumed, { heard });
    assert.equal(report.sameTick, 1);
    assert.deepEqual(report.race, { tick: 3, entities: at(3) });
    assert.deepEqual(report.raceHeard, { heard: [1, 2, 3] });
    assert.equal(report.blocked, false);
    assert.deepEqual(report.blockedLedger, {
      tick: 0,
      entities: [
        { id: "e1", x: 0, y: 0 },
        { id: "e2", x: 10, y: 0 },
      ],
    });
    assert.deepEqual(report.blockedWitness, { heard: [] });
    assert.equal(report.sessions, 0);
    assert.equal(report.guests, 0);
    assert.equal(report.memoryBytes, 0);
    assert.equal(report.binaryBytes, 0);
  });
});

function stalling(mark: () => void, gate: Promise<void>): ModulePackage {
  return {
    manifest: manifest("org.example.sim-stall", {
      requires: [{ capability: "sim.core", version: "^1.0.0" }],
      connectsTo: [{ slot: "sim.systems", contract: "sim.systems/1" }],
    }),
    implementation: {
      register(ctx) {
        ctx.contribute("sim.systems", {
          id: "stall",
          order: 25,
          payload(input: unknown) {
            mark();
            return gate.then(() => input);
          },
        });
      },
    },
  };
}

function noting(scratch: { n: number }, noted: number[]): ModulePackage {
  return {
    manifest: manifest("org.example.sim-side", {
      requires: [{ capability: "sim.core", version: "^1.0.0" }],
      connectsTo: [
        { slot: "sim.systems", contract: "sim.systems/1" },
        { slot: "sim.completed", contract: "sim.completed/1" },
      ],
    }),
    implementation: {
      register(ctx) {
        ctx.contribute("sim.systems", {
          id: "scratch",
          order: 12,
          payload(input: unknown) {
            scratch.n += 1;
            return input;
          },
        });
        ctx.contribute("sim.completed", {
          id: "note",
          payload(event: unknown) {
            const tick = event && typeof event === "object" && "tick" in event ? (event as { tick?: unknown }).tick : undefined;
            if (typeof tick !== "number" || !Number.isSafeInteger(tick)) throw new Error("Simulation event has no tick.");
            noted.push(tick);
          },
        });
      },
    },
  };
}

function haltingAlways(): ModulePackage {
  return {
    manifest: manifest("org.example.sim-halt", {
      requires: [{ capability: "sim.core", version: "^1.0.0" }],
      connectsTo: [{ slot: "sim.systems", contract: "sim.systems/1" }],
    }),
    implementation: {
      register(ctx) {
        ctx.contribute("sim.systems", {
          id: "halt",
          order: 15,
          payload() {
            throw new Error("halted the step");
          },
        });
      },
    },
  };
}

function breakingSubscriber(): ModulePackage {
  return {
    manifest: manifest("org.example.sim-break", {
      requires: [{ capability: "sim.core", version: "^1.0.0" }],
      connectsTo: [{ slot: "sim.completed", contract: "sim.completed/1" }],
    }),
    implementation: {
      register(ctx) {
        ctx.contribute("sim.completed", {
          id: "break",
          order: -1,
          payload() {
            throw new Error("subscriber broke");
          },
        });
      },
    },
  };
}
