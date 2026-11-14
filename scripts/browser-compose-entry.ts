import { createBrowserWasmBackend } from "../src/foundations/wasm-browser.ts";
import { compose, runExclusive, type CompositionResult } from "../src/foundations/host.ts";
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
  context: {
    importOwn: string;
    foreignOk: boolean;
    exportOwn: string;
    exportRestore: string;
    pairHeld: boolean;
    pairA: unknown;
    pairB: unknown;
    authority: BrowserServiceAuthority;
    subscriberOwn: string;
    subscriberLedger: unknown;
    subscriberLate: unknown;
  };
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
    const context = await browserContextProof(backend);
    const asyncSubscriber = await browserAsyncSubscriber(backend, packages);

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
      context: {
        importOwn: context.importOwn,
        foreignOk: context.foreignOk,
        exportOwn: context.exportOwn,
        exportRestore: context.exportRestore,
        pairHeld: context.pairHeld,
        pairA: context.pairA,
        pairB: context.pairB,
        authority: context.authority,
        subscriberOwn: asyncSubscriber.own,
        subscriberLedger: asyncSubscriber.ledger,
        subscriberLate: asyncSubscriber.late,
      },
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

async function browserAsyncSubscriber(
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
  let own = "";
  let live: CompositionResult | undefined;
  const late = {
    manifest: {
      moduleId: "org.example.sim-async",
      name: "async",
      version: "1.0.0",
      moduleApi: ">=1.0.0 <2.0.0",
      save: { version: "1.0.0" },
      requires: [{ capability: "sim.core", version: "^1.0.0" }],
      connectsTo: [{ slot: "sim.completed", contract: "sim.completed/1" }],
    },
    implementation: {
      register(ctx: { keep: (value: unknown) => void; contribute: (slotId: string, contribution: { id: string; order: number; payload: (event: unknown) => Promise<void> }) => void }) {
        ctx.keep({ heard });
        ctx.contribute("sim.completed", {
          id: "late",
          order: -1,
          async payload(event: unknown) {
            const tick = event && typeof event === "object" && "tick" in event ? (event as { tick?: unknown }).tick : undefined;
            const host = live;
            if (!host) throw new Error("missing composition");
            mark();
            await gate;
            const report = await captureSave(host);
            own = report.notices[0]?.code ?? "";
            if (typeof tick === "number") heard.push(tick);
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
    profileName: "sim-browser-async",
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
    if (captureDone) throw new Error("Capture returned before the async subscriber finished.");
    release();
    const step = await pending;
    if (!step.ok) throw new Error(step.reason);
    const captured = await shot;
    if (!captured.ok) throw new Error(captured.notices.map((item) => item.message).join("\n"));
    return {
      own,
      ledger: sliceOf(captured.document, "org.cgp.sim-ledger"),
      late: sliceOf(captured.document, "org.example.sim-async"),
    };
  } finally {
    if (result.runtimeActive && !result.quiesced) await result.shutdown();
  }
}

function savedModule(id: string, hooks: Record<string, unknown>) {
  return {
    manifest: {
      moduleId: id,
      name: id.split(".").at(-1) ?? id,
      version: "1.0.0",
      moduleApi: ">=1.0.0 <2.0.0",
      save: { version: "1.0.0" },
    },
    implementation: hooks,
  };
}

async function browserContextProof(backend: Parameters<typeof createCrossBackend>[0]) {
  const openJs = async (packages: readonly unknown[], profileName: string) => {
    const result = await compose(packages as never, {
      backend: createCrossBackend(backend),
      policy: CROSS_POLICY,
      profileName,
    });
    if (!result.runtimeActive) throw new Error(result.diagnostics.map((item) => item.message).join("\n"));
    return result;
  };
  let releaseImport = () => {};
  const importGate = new Promise<void>((resolve) => {
    releaseImport = resolve;
  });
  let markImport = () => {};
  const importEntered = new Promise<void>((resolve) => {
    markImport = resolve;
  });
  let importLive: CompositionResult | undefined;
  let idleLive: CompositionResult | undefined;
  let importOwn = "";
  let foreignOk = false;
  const importing = savedModule("org.example.early", {
    register(ctx: { keep: (value: unknown) => void }) {
      ctx.keep({ n: 0 });
    },
    exportState(ctx: { kept: () => unknown }) {
      const state = ctx.kept() as { n?: unknown } | undefined;
      return { n: typeof state?.n === "number" ? state.n : 0 };
    },
    async importState(ctx: { kept: () => unknown }, saved: unknown) {
      const state = ctx.kept() as { n: number } | undefined;
      const n = saved && typeof saved === "object" && "n" in saved ? (saved as { n?: unknown }).n : undefined;
      markImport();
      await importGate;
      const host = importLive;
      const other = idleLive;
      if (!host || !other) throw new Error("missing composition");
      const refused = await captureSave(host);
      const foreign = await captureSave(other);
      importOwn = refused.notices[0]?.code ?? "";
      foreignOk = foreign.ok && foreign.notices.every((item) => item.code !== "save.reentrant");
      if (state && typeof n === "number") state.n = n;
    },
  });
  const idleModule = savedModule("org.example.idle", {
    register(ctx: { keep: (value: unknown) => void }) {
      ctx.keep({ n: 0 });
    },
    exportState() {
      return { n: 0 };
    },
  });
  const imported = await openJs([importing], "sim-browser-import");
  const idle = await openJs([idleModule], "sim-browser-idle");
  importLive = imported;
  idleLive = idle;
  const restoring = restoreSave(imported, {
    foundationsApi: "1.0.0",
    profileName: imported.profileName,
    fingerprint: imported.fingerprint,
    slices: [{ moduleId: "org.example.early", version: "1.0.0", payload: { n: 4 } }],
  });
  await importEntered;
  const idleShot = await captureSave(idle);
  if (!idleShot.ok || idleShot.document.slices[0]?.payload && (idleShot.document.slices[0].payload as { n: number }).n !== 0) {
    throw new Error("An outside capture was contaminated by another composition.");
  }
  releaseImport();
  const restored = await restoring;
  if (!restored.ok) throw new Error(restored.notices.map((item) => item.message).join("\n"));
  await imported.shutdown();
  await idle.shutdown();

  let exportLive: CompositionResult | undefined;
  let exportOwn = "";
  let exportRestore = "";
  const box = savedModule("org.example.box", {
    register(ctx: { keep: (value: unknown) => void }) {
      ctx.keep({ n: 3 });
    },
    async exportState(ctx: { kept: () => unknown }) {
      const state = ctx.kept() as { n?: unknown } | undefined;
      const n = typeof state?.n === "number" ? state.n : 0;
      await Promise.resolve();
      const host = exportLive;
      if (!host) throw new Error("missing composition");
      const refused = await captureSave(host);
      const nested = await restoreSave(host, {
        foundationsApi: "1.0.0",
        profileName: host.profileName,
        fingerprint: host.fingerprint,
        slices: [{ moduleId: "org.example.box", version: "1.0.0", payload: { n: 1 } }],
      });
      exportOwn = refused.notices[0]?.code ?? "";
      exportRestore = nested.notices[0]?.code ?? "";
      return { n };
    },
  });
  const exporting = await openJs([box], "sim-browser-export");
  exportLive = exporting;
  const exported = await captureSave(exporting);
  if (!exported.ok) throw new Error(exported.notices.map((item) => item.message).join("\n"));
  await exporting.shutdown();

  let releaseA = () => {};
  let releaseB = () => {};
  const gateA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  const gateB = new Promise<void>((resolve) => {
    releaseB = resolve;
  });
  let markA = () => {};
  let markB = () => {};
  const enteredA = new Promise<void>((resolve) => {
    markA = resolve;
  });
  const enteredB = new Promise<void>((resolve) => {
    markB = resolve;
  });
  let liveA: CompositionResult | undefined;
  let liveB: CompositionResult | undefined;
  const held = (mark: () => void, gate: Promise<void>, self: () => CompositionResult | undefined) =>
    savedModule("org.example.held", {
      register(ctx: { keep: (value: unknown) => void }) {
        ctx.keep({ n: 0 });
      },
      exportState(ctx: { kept: () => unknown }) {
        const state = ctx.kept() as { n?: unknown } | undefined;
        return { n: typeof state?.n === "number" ? state.n : 0 };
      },
      async importState(ctx: { kept: () => unknown }, saved: unknown) {
        const state = ctx.kept() as { n: number } | undefined;
        const n = saved && typeof saved === "object" && "n" in saved ? (saved as { n?: unknown }).n : undefined;
        mark();
        await gate;
        const host = self();
        if (!host) throw new Error("missing composition");
        const refused = await captureSave(host);
        if (refused.notices[0]?.code !== "save.reentrant") throw new Error("Held import was not refused.");
        if (state && typeof n === "number") state.n = n;
      },
    });
  const first = await openJs([held(markA, gateA, () => liveA)], "sim-browser-a");
  const second = await openJs([held(markB, gateB, () => liveB)], "sim-browser-b");
  liveA = first;
  liveB = second;
  const doc = (result: CompositionResult, n: number) => ({
    foundationsApi: "1.0.0",
    profileName: result.profileName,
    fingerprint: result.fingerprint,
    slices: [{ moduleId: "org.example.held", version: "1.0.0", payload: { n } }],
  });
  const restoringA = restoreSave(first, doc(first, 2));
  const restoringB = restoreSave(second, doc(second, 8));
  await enteredA;
  await enteredB;
  let doneB = false;
  const shotB = captureSave(second).then((report) => {
    doneB = true;
    return report;
  });
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  if (doneB) throw new Error("Capture of B finished during B's restore.");
  releaseA();
  const restoredA = await restoringA;
  if (!restoredA.ok) throw new Error(restoredA.notices.map((item) => item.message).join("\n"));
  const shotA = await captureSave(first);
  if (doneB) throw new Error("Finishing A released B's capture.");
  releaseB();
  const restoredB = await restoringB;
  const capturedB = await shotB;
  if (!restoredB.ok || !shotA.ok || !capturedB.ok) throw new Error("Pair restore did not finish.");
  await first.shutdown();
  await second.shutdown();

  const authority = await browserServiceAuthority(backend, openJs);

  return {
    importOwn,
    foreignOk,
    exportOwn,
    exportRestore,
    pairHeld: true,
    pairA: sliceOf(shotA.document, "org.example.held"),
    pairB: sliceOf(capturedB.document, "org.example.held"),
    authority,
  };
}

export type BrowserServiceAuthority = {
  beforeEarly: unknown;
  beforeLate: unknown;
  duringHeld: boolean;
  duringEarly: unknown;
  duringLate: unknown;
  readDuring: unknown;
  afterEarly: unknown;
  afterLate: unknown;
  nestedEarly: unknown;
  nestedLate: unknown;
  calls: number[];
  concurrentFirstCount: unknown;
  concurrentFirstOther: unknown;
  concurrentSecondCount: unknown;
  concurrentSecondOther: unknown;
  nestedCall: unknown;
  stepHeld: boolean;
  stepReadTick: number;
  stepLedger: unknown;
  stepBump: unknown;
};

async function browserServiceAuthority(
  backend: Parameters<typeof createCrossBackend>[0],
  openJs: (packages: readonly unknown[], profileName: string) => Promise<CompositionResult>,
): Promise<BrowserServiceAuthority> {
  const finish = async (result: CompositionResult | undefined) => {
    if (result && result.runtimeActive && !result.quiesced) await result.shutdown();
  };
  const ordered = await browserOrderedServices(openJs, finish);
  const concurrent = await browserConcurrentServices(openJs, finish);
  const nested = await browserNestedExportService(openJs, finish);
  const nestedCall = await browserNestedDirectCall(openJs, finish);
  const step = await browserStepService(backend, finish);
  return {
    beforeEarly: ordered.beforeEarly,
    beforeLate: ordered.beforeLate,
    duringHeld: ordered.duringHeld,
    duringEarly: ordered.duringEarly,
    duringLate: ordered.duringLate,
    readDuring: ordered.readDuring,
    afterEarly: ordered.afterEarly,
    afterLate: ordered.afterLate,
    nestedEarly: nested.early,
    nestedLate: nested.late,
    calls: concurrent.calls,
    concurrentFirstCount: concurrent.firstCount,
    concurrentFirstOther: concurrent.firstOther,
    concurrentSecondCount: concurrent.secondCount,
    concurrentSecondOther: concurrent.secondOther,
    nestedCall: nestedCall.payload,
    stepHeld: step.held,
    stepReadTick: step.readTick,
    stepLedger: step.ledger,
    stepBump: step.bump,
  };
}

function serviceDesk(slots: ReadonlyArray<{ slotId: string; contract: string; mutates?: false }>) {
  return {
    manifest: {
      moduleId: "org.example.desk",
      name: "desk",
      version: "1.0.0",
      moduleApi: ">=1.0.0 <2.0.0",
      exposesSlots: slots.map((slot) => ({
        slotId: slot.slotId,
        contract: slot.contract,
        contractVersion: "1.0.0",
        kind: "service" as const,
        required: false,
        ...(slot.mutates === undefined ? {} : { mutates: slot.mutates }),
      })),
    },
    implementation: {},
  };
}

function connectSaved<T extends { manifest: object }>(
  module: T,
  slots: ReadonlyArray<{ slot: string; contract: string }>,
) {
  return {
    ...module,
    manifest: {
      ...(module.manifest as Record<string, unknown>),
      connectsTo: [...slots],
    },
  };
}

const LISTENER_SLOT = [{ slot: "example.listeners", contract: "example.listener/1" }];

async function browserOrderedServices(
  openJs: (packages: readonly unknown[], profileName: string) => Promise<CompositionResult>,
  finish: (result: CompositionResult | undefined) => Promise<void>,
) {
  const state = { early: 0, late: 0 };
  let releaseExport = () => {};
  const exportGate = new Promise<void>((resolve) => {
    releaseExport = resolve;
  });
  let markExport = () => {};
  const exportEntered = new Promise<void>((resolve) => {
    markExport = resolve;
  });
  let releaseService = () => {};
  const serviceGate = new Promise<void>((resolve) => {
    releaseService = resolve;
  });
  let markService = () => {};
  const serviceEntered = new Promise<void>((resolve) => {
    markService = resolve;
  });
  let holdExport = false;
  const early = savedModule("org.example.early", {
    register(ctx: { keep: (value: unknown) => void; contribute: (slotId: string, contribution: { id: string; payload: () => void }) => void }) {
      ctx.keep(state);
      ctx.contribute("example.listeners", { id: "early", payload() {} });
    },
    async exportState() {
      const snapshot = { early: state.early, late: state.late };
      if (holdExport) {
        markExport();
        await exportGate;
      }
      return snapshot;
    },
  });
  const late = savedModule("org.example.late", {
    register(ctx: { contribute: (slotId: string, contribution: { id: string; payload: () => void }) => void }) {
      ctx.contribute("example.listeners", { id: "late", payload() {} });
    },
    exportState() {
      return { early: state.early, late: state.late };
    },
  });
  const listeners = {
    manifest: {
      moduleId: "org.example.owner",
      name: "owner",
      version: "1.0.0",
      moduleApi: ">=1.0.0 <2.0.0",
      exposesSlots: [
        {
          slotId: "example.listeners",
          contract: "example.listener",
          contractVersion: "1.0.0",
          kind: "subscriber",
          required: false,
        },
      ],
    },
    implementation: {},
  };
  const ask = serviceDesk([
    { slotId: "example.ask", contract: "example.answer" },
    { slotId: "example.look", contract: "example.look", mutates: false },
  ]);
  const bump = {
    manifest: {
      moduleId: "org.example.bump",
      name: "bump",
      version: "1.0.0",
      moduleApi: ">=1.0.0 <2.0.0",
      connectsTo: [
        { slot: "example.ask", contract: "example.answer/1" },
        { slot: "example.look", contract: "example.look/1" },
      ],
    },
    implementation: {
      register(ctx: { contribute: (slotId: string, contribution: { id: string; payload: () => unknown }) => void }) {
        ctx.contribute("example.ask", {
          id: "bump",
          async payload() {
            markService();
            await serviceGate;
            state.early += 1;
            state.late += 1;
          },
        });
        ctx.contribute("example.look", {
          id: "look",
          payload() {
            return state.early;
          },
        });
      },
    },
  };
  let first: CompositionResult | undefined;
  let second: CompositionResult | undefined;
  try {
    first = await openJs([listeners, ask, bump, connectSaved(early, LISTENER_SLOT), connectSaved(late, LISTENER_SLOT)], "sim-browser-service-before");
    const before = callService(first, "example.ask", undefined);
    await serviceEntered;
    let beforeDone = false;
    const beforeCapture = captureSave(first).then((report) => {
      beforeDone = true;
      return report;
    });
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    if (beforeDone) throw new Error("A capture finished while a service ahead of it was still running.");
    releaseService();
    const beforeReport = await before;
    if (!beforeReport.ok) throw new Error(beforeReport.reason ?? "before service failed");
    const beforeSaved = await beforeCapture;
    if (!beforeSaved.ok) throw new Error(beforeSaved.notices.map((item) => item.message).join("\n"));

    let releaseDuring = () => {};
    const duringGate = new Promise<void>((resolve) => {
      releaseDuring = resolve;
    });
    let markDuring = () => {};
    const duringEntered = new Promise<void>((resolve) => {
      markDuring = resolve;
    });
    holdExport = true;
    const duringBump = {
      manifest: bump.manifest,
      implementation: {
        register(ctx: { contribute: (slotId: string, contribution: { id: string; payload: () => unknown }) => void }) {
          ctx.contribute("example.ask", {
            id: "bump",
            async payload() {
              markDuring();
              await duringGate;
              state.early += 1;
              state.late += 1;
            },
          });
          ctx.contribute("example.look", {
            id: "look",
            payload() {
              return state.early;
            },
          });
        },
      },
    };
    second = await openJs(
      [listeners, ask, duringBump, connectSaved(early, LISTENER_SLOT), connectSaved(late, LISTENER_SLOT)],
      "sim-browser-service-during",
    );
    const walking = captureSave(second);
    await exportEntered;
    const seen = await callService(second, "example.look", undefined);
    if (!seen.ok) throw new Error(seen.reason ?? "read failed");
    let duringDone = false;
    const during = callService(second, "example.ask", undefined).then((report) => {
      duringDone = true;
      return report;
    });
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    if (duringDone || state.early !== 1 || state.late !== 1) {
      throw new Error("A mutating service ran while a capture was still exporting.");
    }
    releaseExport();
    const walked = await walking;
    await duringEntered;
    if (!walked.ok) throw new Error(walked.notices.map((item) => item.message).join("\n"));
    if (duringDone) throw new Error("The service finished before the capture released it.");
    releaseDuring();
    const duringReport = await during;
    if (!duringReport.ok) throw new Error(duringReport.reason ?? "during service failed");
    const after = await captureSave(second);
    if (!after.ok) throw new Error(after.notices.map((item) => item.message).join("\n"));
    return {
      beforeEarly: sliceOf(beforeSaved.document, "org.example.early"),
      beforeLate: sliceOf(beforeSaved.document, "org.example.late"),
      duringHeld: true,
      duringEarly: sliceOf(walked.document, "org.example.early"),
      duringLate: sliceOf(walked.document, "org.example.late"),
      readDuring: seen.output,
      afterEarly: sliceOf(after.document, "org.example.early"),
      afterLate: sliceOf(after.document, "org.example.late"),
    };
  } finally {
    await finish(first);
    await finish(second);
  }
}

async function browserConcurrentServices(
  openJs: (packages: readonly unknown[], profileName: string) => Promise<CompositionResult>,
  finish: (result: CompositionResult | undefined) => Promise<void>,
) {
  const state = { n: 0 };
  let releaseFirst = () => {};
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let markFirst = () => {};
  const firstEntered = new Promise<void>((resolve) => {
    markFirst = resolve;
  });
  const calls: number[] = [];
  const counterModule = savedModule("org.example.count", {
    register(ctx: { keep: (value: unknown) => void; contribute: (slotId: string, contribution: { id: string; payload: () => void }) => void }) {
      ctx.keep(state);
      ctx.contribute("example.listeners", { id: "count", payload() {} });
    },
    exportState() {
      return { n: state.n };
    },
  });
  const other = savedModule("org.example.other", {
    register(ctx: { contribute: (slotId: string, contribution: { id: string; payload: () => void }) => void }) {
      ctx.contribute("example.listeners", { id: "other", payload() {} });
    },
    exportState() {
      return { n: state.n };
    },
  });
  const listeners = {
    manifest: {
      moduleId: "org.example.owner",
      name: "owner",
      version: "1.0.0",
      moduleApi: ">=1.0.0 <2.0.0",
      exposesSlots: [
        {
          slotId: "example.listeners",
          contract: "example.listener",
          contractVersion: "1.0.0",
          kind: "subscriber",
          required: false,
        },
      ],
    },
    implementation: {},
  };
  const desk = serviceDesk([{ slotId: "example.ask", contract: "example.answer" }]);
  const bump = {
    manifest: {
      moduleId: "org.example.bump",
      name: "bump",
      version: "1.0.0",
      moduleApi: ">=1.0.0 <2.0.0",
      connectsTo: [{ slot: "example.ask", contract: "example.answer/1" }],
    },
    implementation: {
      register(ctx: { contribute: (slotId: string, contribution: { id: string; payload: (input: unknown) => Promise<void> }) => void }) {
        ctx.contribute("example.ask", {
          id: "bump",
          async payload(input: unknown) {
            const amount = typeof input === "number" ? input : 0;
            if (amount === 1) {
              markFirst();
              await firstGate;
            }
            state.n = amount;
            calls.push(amount);
          },
        });
      },
    },
  };
  let result: CompositionResult | undefined;
  try {
    result = await openJs(
      [listeners, desk, bump, connectSaved(counterModule, LISTENER_SLOT), connectSaved(other, LISTENER_SLOT)],
      "sim-browser-service-concurrent",
    );
    const firstService = callService(result, "example.ask", 1);
    await firstEntered;
    let firstCaptureDone = false;
    let secondServiceDone = false;
    let secondCaptureDone = false;
    const firstCapture = captureSave(result).then((report) => {
      firstCaptureDone = true;
      return report;
    });
    const secondService = callService(result, "example.ask", 2).then((report) => {
      secondServiceDone = true;
      return report;
    });
    const secondCapture = captureSave(result).then((report) => {
      secondCaptureDone = true;
      return report;
    });
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    if (firstCaptureDone || secondServiceDone || secondCaptureDone) {
      throw new Error("A later service or capture ran before the first service.");
    }
    releaseFirst();
    const savedFirst = await firstCapture;
    const savedSecond = await secondCapture;
    const firstReport = await firstService;
    const secondReport = await secondService;
    if (!firstReport.ok || !secondReport.ok || !savedFirst.ok || !savedSecond.ok) {
      throw new Error("Concurrent services and captures did not finish.");
    }
    return {
      calls,
      firstCount: sliceOf(savedFirst.document, "org.example.count"),
      firstOther: sliceOf(savedFirst.document, "org.example.other"),
      secondCount: sliceOf(savedSecond.document, "org.example.count"),
      secondOther: sliceOf(savedSecond.document, "org.example.other"),
    };
  } finally {
    await finish(result);
  }
}

async function browserNestedExportService(
  openJs: (packages: readonly unknown[], profileName: string) => Promise<CompositionResult>,
  finish: (result: CompositionResult | undefined) => Promise<void>,
) {
  const state = { early: 1, late: 0 };
  let live: CompositionResult | undefined;
  const early = savedModule("org.example.early", {
    register(ctx: { keep: (value: unknown) => void; contribute: (slotId: string, contribution: { id: string; payload: () => void }) => void }) {
      ctx.keep(state);
      ctx.contribute("example.listeners", { id: "early", payload() {} });
    },
    async exportState() {
      const host = live;
      if (!host) throw new Error("missing composition");
      const bumped = await callService(host, "example.ask", undefined);
      if (!bumped.ok) throw new Error(bumped.reason ?? "bump failed");
      return { early: 1, late: 0 };
    },
  });
  const late = savedModule("org.example.late", {
    register(ctx: { contribute: (slotId: string, contribution: { id: string; payload: () => void }) => void }) {
      ctx.contribute("example.listeners", { id: "late", payload() {} });
    },
    exportState() {
      return { early: state.early, late: state.late };
    },
  });
  const listeners = {
    manifest: {
      moduleId: "org.example.owner",
      name: "owner",
      version: "1.0.0",
      moduleApi: ">=1.0.0 <2.0.0",
      exposesSlots: [
        {
          slotId: "example.listeners",
          contract: "example.listener",
          contractVersion: "1.0.0",
          kind: "subscriber",
          required: false,
        },
      ],
    },
    implementation: {},
  };
  const desk = serviceDesk([{ slotId: "example.ask", contract: "example.answer" }]);
  const bump = {
    manifest: {
      moduleId: "org.example.bump",
      name: "bump",
      version: "1.0.0",
      moduleApi: ">=1.0.0 <2.0.0",
      connectsTo: [{ slot: "example.ask", contract: "example.answer/1" }],
    },
    implementation: {
      register(ctx: { contribute: (slotId: string, contribution: { id: string; payload: () => void }) => void }) {
        ctx.contribute("example.ask", {
          id: "bump",
          payload() {
            state.late = 7;
          },
        });
      },
    },
  };
  let result: CompositionResult | undefined;
  try {
    result = await openJs(
      [listeners, desk, bump, connectSaved(early, LISTENER_SLOT), connectSaved(late, LISTENER_SLOT)],
      "sim-browser-service-nested",
    );
    live = result;
    const captured = await captureSave(result);
    if (!captured.ok) throw new Error(captured.notices.map((item) => item.message).join("\n"));
    return {
      early: sliceOf(captured.document, "org.example.early"),
      late: sliceOf(captured.document, "org.example.late"),
    };
  } finally {
    await finish(result);
  }
}

async function browserNestedDirectCall(
  openJs: (packages: readonly unknown[], profileName: string) => Promise<CompositionResult>,
  finish: (result: CompositionResult | undefined) => Promise<void>,
) {
  const state = { n: 0 };
  let releaseStep = () => {};
  const stepGate = new Promise<void>((resolve) => {
    releaseStep = resolve;
  });
  let markStep = () => {};
  const stepEntered = new Promise<void>((resolve) => {
    markStep = resolve;
  });
  let releaseOuter = () => {};
  const outerGate = new Promise<void>((resolve) => {
    releaseOuter = resolve;
  });
  let markOuter = () => {};
  const outerEntered = new Promise<void>((resolve) => {
    markOuter = resolve;
  });
  let live: CompositionResult | undefined;
  const desk = serviceDesk([
    { slotId: "example.ask", contract: "example.ask" },
    { slotId: "example.more", contract: "example.more" },
  ]);
  const box = savedModule("org.example.box", {
    register(ctx: { keep: (value: unknown) => void; contribute: (slotId: string, contribution: { id: string; payload: () => unknown }) => void }) {
      ctx.keep(state);
      ctx.contribute("example.ask", {
        id: "ask",
        async payload() {
          markOuter();
          await outerGate;
          const host = live;
          if (!host) throw new Error("missing composition");
          const inner = await callService(host, "example.more", undefined);
          if (!inner.ok) throw new Error(inner.reason ?? "inner failed");
        },
      });
      ctx.contribute("example.more", {
        id: "more",
        payload() {
          state.n = 5;
        },
      });
    },
    exportState() {
      return { n: state.n };
    },
  });
  const withSave = {
    ...box,
    manifest: { ...(box.manifest as Record<string, unknown>), save: { version: "1.0.0" }, connectsTo: [
      { slot: "example.ask", contract: "example.ask/1" },
      { slot: "example.more", contract: "example.more/1" },
    ] },
  };
  let result: CompositionResult | undefined;
  try {
    result = await openJs([desk, withSave], "sim-browser-service-direct");
    live = result;
    const stepping = runExclusive(
      result,
      async () => {
        markStep();
        await stepGate;
      },
      "step",
    );
    await stepEntered;
    const outer = callService(result, "example.ask", undefined);
    await outerEntered;
    let captureDone = false;
    const shot = captureSave(result).then((report) => {
      captureDone = true;
      return report;
    });
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    if (captureDone) throw new Error("Capture ran during the step and its service.");
    releaseStep();
    await stepping;
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    if (captureDone || state.n !== 0) throw new Error("Capture did not wait for the step-time service.");
    releaseOuter();
    const outerReport = await outer;
    if (!outerReport.ok) throw new Error(outerReport.reason ?? "outer service failed");
    const saved = await shot;
    if (!saved.ok) throw new Error(saved.notices.map((item) => item.message).join("\n"));
    return { payload: sliceOf(saved.document, "org.example.box") };
  } finally {
    await finish(result);
  }
}

async function browserStepService(
  backend: Parameters<typeof createCrossBackend>[0],
  finish: (result: CompositionResult | undefined) => Promise<void>,
) {
  const state = { n: 0 };
  let releaseStall = () => {};
  const stallGate = new Promise<void>((resolve) => {
    releaseStall = resolve;
  });
  let markStall = () => {};
  const stallEntered = new Promise<void>((resolve) => {
    markStall = resolve;
  });
  let releaseBump = () => {};
  const bumpGate = new Promise<void>((resolve) => {
    releaseBump = resolve;
  });
  let markBump = () => {};
  const bumpEntered = new Promise<void>((resolve) => {
    markBump = resolve;
  });
  const stall = {
    manifest: {
      moduleId: "org.example.sim-stall",
      name: "stall",
      version: "1.0.0",
      moduleApi: ">=1.0.0 <2.0.0",
      requires: [{ capability: "sim.core", version: "^1.0.0" }],
      connectsTo: [{ slot: "sim.systems", contract: "sim.systems/1" }],
    },
    implementation: {
      register(ctx: { contribute: (slotId: string, contribution: { id: string; order?: number; payload: (input: unknown) => unknown }) => void }) {
        ctx.contribute("sim.systems", {
          id: "stall",
          order: 25,
          payload(input: unknown) {
            markStall();
            return stallGate.then(() => input);
          },
        });
      },
    },
  };
  const desk = {
    manifest: {
      moduleId: "org.example.bump-desk",
      name: "bump-desk",
      version: "1.0.0",
      moduleApi: ">=1.0.0 <2.0.0",
      exposesSlots: [
        {
          slotId: "example.bump",
          contract: "example.bump",
          contractVersion: "1.0.0",
          kind: "service",
          required: false,
        },
      ],
    },
    implementation: {},
  };
  const bump = {
    manifest: {
      moduleId: "org.example.sim-bump",
      name: "bump",
      version: "1.0.0",
      moduleApi: ">=1.0.0 <2.0.0",
      save: { version: "1.0.0" },
      connectsTo: [{ slot: "example.bump", contract: "example.bump/1" }],
    },
    implementation: {
      register(ctx: { keep: (value: unknown) => void; contribute: (slotId: string, contribution: { id: string; payload: () => Promise<void> }) => void }) {
        ctx.keep(state);
        ctx.contribute("example.bump", {
          id: "bump",
          async payload() {
            markBump();
            await bumpGate;
            state.n += 1;
          },
        });
      },
      exportState() {
        return { n: state.n };
      },
    },
  };
  let result: CompositionResult | undefined;
  try {
    result = await compose([...packagesFor([...SIM_IDS]), stall, desk, bump], {
      backend: createCrossBackend(backend),
      policy: CROSS_POLICY,
      profileName: "sim-browser-direct",
    });
    if (!result.runtimeActive) throw new Error(result.diagnostics.map((item) => item.message).join("\n"));
    const planted = await seedSimulation(result, { id: "e1", x: 0, y: 0 });
    if (!planted.ok) throw new Error(planted.reason);
    const plantedNext = await seedSimulation(result, { id: "e2", x: 10, y: 0 });
    if (!plantedNext.ok) throw new Error(plantedNext.reason);
    const pending = advanceSimulation(result, { tick: 1, delta: 1, inputs: PROOF_DRIVES });
    await stallEntered;
    const bumping = callService(result, "example.bump", undefined);
    await bumpEntered;
    const reading = await callService(result, "sim.read", null);
    if (!reading.ok) throw new Error(reading.reason ?? "read failed");
    const readTick = reading.output && typeof reading.output === "object" && "tick" in reading.output
      ? (reading.output as { tick?: unknown }).tick
      : undefined;
    if (typeof readTick !== "number") throw new Error("Simulation read did not return a tick.");
    let captureDone = false;
    const shot = captureSave(result).then((report) => {
      captureDone = true;
      return report;
    });
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    if (captureDone) throw new Error("Capture ran during the open step.");
    releaseStall();
    const step = await pending;
    if (!step.ok) throw new Error(step.reason);
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    if (captureDone || state.n !== 0) throw new Error("Capture did not wait for the service that started during the step.");
    releaseBump();
    const bumped = await bumping;
    if (!bumped.ok) throw new Error(bumped.reason ?? bumped.message ?? "bump failed");
    const saved = await shot;
    if (!saved.ok) throw new Error(saved.notices.map((item) => item.message).join("\n"));
    return {
      held: true,
      readTick,
      ledger: sliceOf(saved.document, "org.cgp.sim-ledger"),
      bump: sliceOf(saved.document, "org.example.sim-bump"),
    };
  } finally {
    await finish(result);
  }
}
