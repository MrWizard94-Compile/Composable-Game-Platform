import { createBrowserWasmBackend } from "../src/foundations/wasm-browser.ts";
import { compose, type CompositionResult } from "../src/foundations/host.ts";
import { isAbiHandle } from "../src/foundations/abi.ts";
import { captureSave, restoreSave, type SaveDocument } from "../src/foundations/save.ts";
import { templateGuest, wasiGuest, withCustomPadding } from "../src/foundations/wasm-build.ts";
import { CROSS_POLICY, createCrossBackend } from "../src/foundations/cross-backend.ts";
import { SIM_IDS, packagesFor } from "../src/modules/registry.ts";
import { advanceSimulation, seedSimulation } from "../src/modules/sim.ts";

function manifest(moduleId: string) {
  return {
    moduleId,
    name: moduleId.split(".").at(-1) ?? moduleId,
    version: "1.0.0",
    moduleApi: ">=1.0.0 <2.0.0",
    connectsTo: [{ slot: "platform.systems", contract: "platform.system/1" }],
  };
}

/**
 * One composition on the real browser isolate. The page must not inject a fake worker.
 */
export async function runBrowserComposition(): Promise<{
  active: boolean;
  contributionId: string;
  wasi: string;
  padded: boolean;
  paddedDetail: string;
  sessions: number;
  detail: string;
}> {
  const backend = createBrowserWasmBackend();
  const policy = { allowGrants: [], maxHookMs: 1000, maxMemoryBytes: 65536, maxBinaryBytes: 65536 } as const;
  const result = await compose([{ manifest: manifest("org.example.starter"), implementation: { wasm: templateGuest() } }], {
    backend,
    policy,
  });
  const wasi = await compose([{ manifest: manifest("org.example.wasi"), implementation: { wasm: wasiGuest() } }], {
    backend,
    policy,
  });
  if (result.runtimeActive) await result.shutdown();
  const paddedBytes = withCustomPadding(templateGuest(), 70_000);
  const padded = await compose([{ manifest: manifest("org.example.padded"), implementation: { wasm: paddedBytes } }], {
    backend,
    policy: { allowGrants: [], maxHookMs: 1000, maxMemoryBytes: 65536, maxBinaryBytes: paddedBytes.byteLength },
  });
  if (padded.runtimeActive) await padded.shutdown();
  return {
    active: result.runtimeActive,
    contributionId: result.contributions.find((item) => item.slotId === "platform.systems")?.id ?? "",
    detail: result.diagnostics.map((item) => item.message).join("\n"),
    wasi: wasi.diagnostics.map((item) => item.message).join("\n"),
    padded: padded.runtimeActive,
    paddedDetail: padded.diagnostics.map((item) => item.message).join("\n"),
    sessions: backend.openSessions(),
  };
}

const PROOF_DRIVES = [
  { id: "e1", vx: 1, vy: 2 },
  { id: "e2", vx: -1, vy: 0 },
];

function sliceOf(document: SaveDocument, moduleId: string): unknown {
  return document.slices.find((item) => item.moduleId === moduleId)?.payload;
}

/**
 * The mixed simulation proof on the real browser isolate.
 * Movement is JavaScript. The boundary guest is WebAssembly.
 * Half the steps run, the save is restored on a new composition, and both ledgers finish together.
 */
export async function runBrowserSimulation(): Promise<{
  mixed: boolean;
  continuous: unknown;
  resumed: unknown;
  heardContinuous: unknown;
  heardResumed: unknown;
  sessions: number;
  guests: number;
  memoryBytes: number;
  binaryBytes: number;
}> {
  const backend = createBrowserWasmBackend();
  const packages = packagesFor([...SIM_IDS]);
  const half = 40;
  const open = async (profileName: string) => {
    const result = await compose(packages, { backend: createCrossBackend(backend), policy: CROSS_POLICY, profileName });
    if (!result.runtimeActive) throw new Error(result.diagnostics.map((item) => item.message).join("\n"));
    return result;
  };
  const plant = async (result: CompositionResult) => {
    const first = await seedSimulation(result, { id: "e1", x: 0, y: 0 });
    if (!first.ok) throw new Error(first.reason);
    const second = await seedSimulation(result, { id: "e2", x: 10, y: 0 });
    if (!second.ok) throw new Error(second.reason);
  };
  const run = async (result: CompositionResult, from: number, count: number) => {
    for (let offset = 0; offset < count; offset += 1) {
      const step = await advanceSimulation(result, { tick: from + offset, delta: 1, inputs: PROOF_DRIVES });
      if (!step.ok) throw new Error(step.reason);
    }
  };
  const finish = async (result: CompositionResult | undefined) => {
    if (result && result.runtimeActive && !result.quiesced) await result.shutdown();
  };
  let continuous: CompositionResult | undefined;
  let resumed: CompositionResult | undefined;
  let next: CompositionResult | undefined;
  try {
    continuous = await open("sim-browser");
    resumed = await open("sim-browser-resume");
    const move = continuous.contributions.find((item) => item.id === "move")?.payload;
    const bound = continuous.contributions.find((item) => item.id === "bound")?.payload;
    const mixed = typeof move === "function" && isAbiHandle(bound);
    await plant(continuous);
    await plant(resumed);
    await run(continuous, 1, half);
    await run(resumed, 1, half);
    const saved = await captureSave(resumed);
    if (!saved.ok) throw new Error(saved.notices.map((item) => item.message).join("\n"));
    await resumed.shutdown();
    next = await open("sim-browser-next");
    const applied = await restoreSave(next, saved.document);
    if (!applied.ok) throw new Error(applied.notices.map((item) => item.message).join("\n"));
    await run(continuous, half + 1, half);
    await run(next, half + 1, half);
    const left = await captureSave(continuous);
    const right = await captureSave(next);
    if (!left.ok || !right.ok) throw new Error("Browser simulation could not save.");
    const continuousLedger = sliceOf(left.document, "org.cgp.sim-ledger");
    const resumedLedger = sliceOf(right.document, "org.cgp.sim-ledger");
    const heardContinuous = sliceOf(left.document, "org.cgp.sim-witness");
    const heardResumed = sliceOf(right.document, "org.cgp.sim-witness");
    await finish(continuous);
    await finish(next);
    continuous = undefined;
    next = undefined;
    const usage = backend.resourceUsage();
    return {
      mixed,
      continuous: continuousLedger,
      resumed: resumedLedger,
      heardContinuous,
      heardResumed,
      sessions: backend.openSessions(),
      guests: usage.guests,
      memoryBytes: usage.memoryBytes,
      binaryBytes: usage.binaryBytes,
    };
  } finally {
    await finish(continuous);
    await finish(resumed);
    await finish(next);
  }
}
