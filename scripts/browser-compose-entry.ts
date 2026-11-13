import { createBrowserWasmBackend } from "../src/foundations/wasm-browser.ts";
import { compose, type CompositionResult } from "../src/foundations/host.ts";
import { isAbiHandle } from "../src/foundations/abi.ts";
import { captureSave, restoreSave, type SaveDocument } from "../src/foundations/save.ts";
import { callService } from "../src/foundations/dispatch.ts";
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
  race: unknown;
  raceHeard: unknown;
  sameTick: number;
  blockedLedger: unknown;
  blockedWitness: unknown;
  blocked: boolean;
  orderedLedger: unknown;
  orderedHeard: unknown;
  pairedEarly: unknown;
  pairedLate: unknown;
  subscriberLedger: unknown;
  subscriberWitness: unknown;
  subscriberLate: unknown;
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
  let raced: CompositionResult | undefined;
  let blockedRun: CompositionResult | undefined;
  let ordered: CompositionResult | undefined;
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

    raced = await open("sim-browser-race");
    await plant(raced);
    const [first, second] = await Promise.all([
      advanceSimulation(raced, { tick: 1, delta: 1, inputs: PROOF_DRIVES }),
      advanceSimulation(raced, { tick: 1, delta: 1, inputs: PROOF_DRIVES }),
    ]);
    const sameTick = Number(first.ok) + Number(second.ok);
    const [third, fourth] = await Promise.all([
      advanceSimulation(raced, { tick: 2, delta: 1, inputs: PROOF_DRIVES }),
      advanceSimulation(raced, { tick: 3, delta: 1, inputs: PROOF_DRIVES }),
    ]);
    if (!third.ok) throw new Error(third.reason);
    if (!fourth.ok) throw new Error(fourth.reason);
    const racedSave = await captureSave(raced);
    if (!racedSave.ok) throw new Error(racedSave.notices.map((item) => item.message).join("\n"));

    blockedRun = await open("sim-browser-block");
    await plant(blockedRun);
    const snap = await captureSave(blockedRun);
    if (!snap.ok) throw new Error(snap.notices.map((item) => item.message).join("\n"));
    const hostile = JSON.parse(JSON.stringify(snap.document)) as SaveDocument;
    const witnessSlice = hostile.slices.find((item) => item.moduleId === "org.cgp.sim-witness");
    if (!witnessSlice) throw new Error("Browser simulation has no witness slice.");
    witnessSlice.payload = { heard: [99] };
    const opened = await callService(blockedRun, "sim.commit", { phase: "open", tick: 1 });
    if (!opened.ok) throw new Error(opened.message ?? opened.reason ?? "open failed");
    const denied = await restoreSave(blockedRun, hostile);
    const during = await captureSave(blockedRun);
    if (!during.ok) throw new Error(during.notices.map((item) => item.message).join("\n"));
    const aborted = await callService(blockedRun, "sim.commit", { phase: "abort" });
    if (!aborted.ok) throw new Error(aborted.message ?? aborted.reason ?? "abort failed");

    let releaseHold = () => {};
    const holdGate = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let markHold = () => {};
    const holdEntered = new Promise<void>((resolve) => {
      markHold = resolve;
    });
    ordered = await compose([...packages, browserGate(markHold, holdGate)], {
      backend: createCrossBackend(backend),
      policy: CROSS_POLICY,
      profileName: "sim-browser-order",
    });
    if (!ordered.runtimeActive) throw new Error(ordered.diagnostics.map((item) => item.message).join("\n"));
    await plant(ordered);
    const orderedSnap = await captureSave(ordered);
    if (!orderedSnap.ok) throw new Error(orderedSnap.notices.map((item) => item.message).join("\n"));
    const restoring = restoreSave(ordered, orderedSnap.document);
    await holdEntered;
    let stepDone = false;
    const stepping = advanceSimulation(ordered, { tick: 1, delta: 1, inputs: PROOF_DRIVES }).then((step) => {
      stepDone = true;
      return step;
    });
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    if (stepDone) throw new Error("A step finished while a restore was still running.");
    releaseHold();
    const restored = await restoring;
    if (!restored.ok) throw new Error(restored.notices.map((item) => item.message).join("\n"));
    const stepped = await stepping;
    if (!stepped.ok) throw new Error(stepped.reason);
    const orderedSave = await captureSave(ordered);
    if (!orderedSave.ok) throw new Error(orderedSave.notices.map((item) => item.message).join("\n"));

    const paired = await browserPairedRestore(backend);
    const subscriber = await browserSubscriberSnapshot(backend, packages);

    await finish(continuous);
    await finish(next);
    await finish(raced);
    await finish(blockedRun);
    await finish(ordered);
    continuous = undefined;
    next = undefined;
    raced = undefined;
    blockedRun = undefined;
    ordered = undefined;
    const usage = backend.resourceUsage();
    return {
      mixed,
      continuous: continuousLedger,
      resumed: resumedLedger,
      heardContinuous,
      heardResumed,
      race: sliceOf(racedSave.document, "org.cgp.sim-ledger"),
      raceHeard: sliceOf(racedSave.document, "org.cgp.sim-witness"),
      sameTick,
      blocked: denied.ok,
      blockedLedger: sliceOf(during.document, "org.cgp.sim-ledger"),
      blockedWitness: sliceOf(during.document, "org.cgp.sim-witness"),
      orderedLedger: sliceOf(orderedSave.document, "org.cgp.sim-ledger"),
      orderedHeard: sliceOf(orderedSave.document, "org.cgp.sim-witness"),
      pairedEarly: paired.early,
      pairedLate: paired.late,
      subscriberLedger: subscriber.ledger,
      subscriberWitness: subscriber.witness,
      subscriberLate: subscriber.late,
      sessions: backend.openSessions(),
      guests: usage.guests,
      memoryBytes: usage.memoryBytes,
      binaryBytes: usage.binaryBytes,
    };
  } finally {
    await finish(continuous);
    await finish(resumed);
    await finish(next);
    await finish(raced);
    await finish(blockedRun);
    await finish(ordered);
  }
}

function browserGate(mark: () => void, gate: Promise<void>) {
  return {
    manifest: {
      moduleId: "org.example.sim-gate",
      name: "gate",
      version: "1.0.0",
      moduleApi: ">=1.0.0 <2.0.0",
      save: { version: "1.0.0" },
    },
    implementation: {
      register(ctx: { keep: (value: unknown) => void }) {
        ctx.keep({ n: 0 });
      },
      exportState(ctx: { kept: () => unknown }) {
        const state = ctx.kept() as { n?: unknown } | undefined;
        return { n: typeof state?.n === "number" ? state.n : 0 };
      },
      importState(_ctx: { kept: () => unknown }, _saved: unknown) {
        mark();
        return gate.then(() => undefined);
      },
    },
  };
}

async function browserPairedRestore(backend: Parameters<typeof createCrossBackend>[0]) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let mark = () => {};
  const entered = new Promise<void>((resolve) => {
    mark = resolve;
  });
  const count = (id: string, block: boolean) => ({
    manifest: {
      moduleId: id,
      name: id.split(".").at(-1) ?? id,
      version: "1.0.0",
      moduleApi: ">=1.0.0 <2.0.0",
      save: { version: "1.0.0" },
    },
    implementation: {
      register(ctx: { keep: (value: unknown) => void }) {
        ctx.keep({ n: 0 });
      },
      exportState(ctx: { kept: () => unknown }) {
        const state = ctx.kept() as { n?: unknown } | undefined;
        return { n: typeof state?.n === "number" ? state.n : 0 };
      },
      importState(ctx: { kept: () => unknown }, saved: unknown) {
        const state = ctx.kept() as { n: number } | undefined;
        const n = saved && typeof saved === "object" && "n" in saved ? (saved as { n?: unknown }).n : undefined;
        if (!block) {
          if (state && typeof n === "number") state.n = n;
          return;
        }
        mark();
        return gate.then(() => {
          if (state && typeof n === "number") state.n = n;
        });
      },
    },
  });
  const result = await compose([count("org.example.early", false), count("org.example.late", true)], {
    backend: createCrossBackend(backend),
    policy: CROSS_POLICY,
    profileName: "sim-browser-pair",
  });
  if (!result.runtimeActive) throw new Error(result.diagnostics.map((item) => item.message).join("\n"));
  try {
    const restoring = restoreSave(result, {
      foundationsApi: "1.0.0",
      profileName: result.profileName,
      fingerprint: result.fingerprint,
      slices: [
        { moduleId: "org.example.early", version: "1.0.0", payload: { n: 6 } },
        { moduleId: "org.example.late", version: "1.0.0", payload: { n: 6 } },
      ],
    });
    await entered;
    let captureDone = false;
    const shot = captureSave(result).then((report) => {
      captureDone = true;
      return report;
    });
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    if (captureDone) throw new Error("Capture returned during a partial restore.");
    release();
    const restored = await restoring;
    if (!restored.ok) throw new Error(restored.notices.map((item) => item.message).join("\n"));
    const captured = await shot;
    if (!captured.ok) throw new Error(captured.notices.map((item) => item.message).join("\n"));
    return {
      early: sliceOf(captured.document, "org.example.early"),
      late: sliceOf(captured.document, "org.example.late"),
    };
  } finally {
    if (result.runtimeActive && !result.quiesced) await result.shutdown();
  }
}

async function browserSubscriberSnapshot(
  backend: Parameters<typeof createCrossBackend>[0],
  packages: ReturnType<typeof packagesFor>,
) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let mark = () => {};
  const entered = new Promise<void>((resolve) => {
    mark = resolve;
  });
  const heard: number[] = [];
  let live: CompositionResult | undefined;
  const late = {
    manifest: {
      moduleId: "org.example.sim-late",
      name: "late",
      version: "1.0.0",
      moduleApi: ">=1.0.0 <2.0.0",
      save: { version: "1.0.0" },
      requires: [{ capability: "sim.core", version: "^1.0.0" }],
      connectsTo: [{ slot: "sim.completed", contract: "sim.completed/1" }],
    },
    implementation: {
      register(ctx: { keep: (value: unknown) => void; contribute: (slotId: string, contribution: { id: string; order: number; payload: (event: unknown) => unknown }) => void }) {
        ctx.keep({ heard });
        ctx.contribute("sim.completed", {
          id: "late",
          order: -1,
          payload(event: unknown) {
            const tick = event && typeof event === "object" && "tick" in event ? (event as { tick?: unknown }).tick : undefined;
            const host = live;
            if (!host) throw new Error("missing composition");
            mark();
            return gate.then(() =>
              captureSave(host).then((report) => {
                if (report.notices[0]?.code !== "save.reentrant") throw new Error("Subscriber capture was not refused.");
                if (typeof tick === "number") heard.push(tick);
              }),
            );
          },
        });
      },
      exportState() {
        return { heard: [...heard] };
      },
    },
  };
  const result = await compose([...packages, late], {
    backend: createCrossBackend(backend),
    policy: CROSS_POLICY,
    profileName: "sim-browser-subscriber",
  });
  if (!result.runtimeActive) throw new Error(result.diagnostics.map((item) => item.message).join("\n"));
  live = result;
  try {
    const first = await seedSimulation(result, { id: "e1", x: 0, y: 0 });
    if (!first.ok) throw new Error(first.reason);
    const second = await seedSimulation(result, { id: "e2", x: 10, y: 0 });
    if (!second.ok) throw new Error(second.reason);
    const pending = advanceSimulation(result, { tick: 1, delta: 1, inputs: PROOF_DRIVES });
    await entered;
    let captureDone = false;
    const shot = captureSave(result).then((report) => {
      captureDone = true;
      return report;
    });
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    if (captureDone) throw new Error("Capture returned before the subscriber finished.");
    release();
    const step = await pending;
    if (!step.ok) throw new Error(step.reason);
    const captured = await shot;
    if (!captured.ok) throw new Error(captured.notices.map((item) => item.message).join("\n"));
    return {
      ledger: sliceOf(captured.document, "org.cgp.sim-ledger"),
      witness: sliceOf(captured.document, "org.cgp.sim-witness"),
      late: sliceOf(captured.document, "org.example.sim-late"),
    };
  } finally {
    if (result.runtimeActive && !result.quiesced) await result.shutdown();
  }
}
