import type { ModuleImplementation, ModulePackage } from "../foundations/host.ts";
import floraCoreManifest from "./org.cgp.flora-core/manifest.json" with { type: "json" };
import { implementation as floraCore } from "./org.cgp.flora-core/module.ts";
import forestManifest from "./org.cgp.forest-plants/manifest.json" with { type: "json" };
import { implementation as forestPlants } from "./org.cgp.forest-plants/module.ts";
import desertManifest from "./org.cgp.desert-plants/manifest.json" with { type: "json" };
import { implementation as desertPlants } from "./org.cgp.desert-plants/module.ts";
import seasonalManifest from "./org.cgp.seasonal-growth/manifest.json" with { type: "json" };
import { implementation as seasonalGrowth } from "./org.cgp.seasonal-growth/module.ts";
import acceleratedManifest from "./org.cgp.accelerated-growth/manifest.json" with { type: "json" };
import { implementation as acceleratedGrowth } from "./org.cgp.accelerated-growth/module.ts";
import duneManifest from "./org.cgp.dune-growth/manifest.json" with { type: "json" };
import { duneWasmBytes } from "./org.cgp.dune-growth/bytes.ts";
import lightingManifest from "./org.cgp.lighting-core/manifest.json" with { type: "json" };
import { implementation as lightingCore } from "./org.cgp.lighting-core/module.ts";
import pointManifest from "./org.cgp.point-lights/manifest.json" with { type: "json" };
import { implementation as pointLights } from "./org.cgp.point-lights/module.ts";
import directionalManifest from "./org.cgp.directional-lights/manifest.json" with { type: "json" };
import { implementation as directionalLights } from "./org.cgp.directional-lights/module.ts";
import cycleAlphaManifest from "./org.cgp.cycle-alpha/manifest.json" with { type: "json" };
import cycleBetaManifest from "./org.cgp.cycle-beta/manifest.json" with { type: "json" };
import initFaultManifest from "./org.cgp.init-fault/manifest.json" with { type: "json" };
import { implementation as initFault } from "./org.cgp.init-fault/module.ts";
import mismatchManifest from "./org.cgp.contract-mismatch/manifest.json" with { type: "json" };
import { implementation as contractMismatch } from "./org.cgp.contract-mismatch/module.ts";
import badManifest from "./org.cgp.bad-manifest/manifest.json" with { type: "json" };
import markerLeftManifest from "./org.cgp.marker-left/manifest.json" with { type: "json" };
import markerRightManifest from "./org.cgp.marker-right/manifest.json" with { type: "json" };
import markerUseManifest from "./org.cgp.marker-use/manifest.json" with { type: "json" };
import signalsManifest from "./org.cgp.signals-core/manifest.json" with { type: "json" };
import { implementation as signalsCore } from "./org.cgp.signals-core/module.ts";
import stampManifest from "./org.cgp.signal-stamp/manifest.json" with { type: "json" };
import { implementation as signalStamp } from "./org.cgp.signal-stamp/module.ts";
import lateManifest from "./org.cgp.signal-late/manifest.json" with { type: "json" };
import { implementation as signalLate } from "./org.cgp.signal-late/module.ts";
import signalFaultManifest from "./org.cgp.signal-fault/manifest.json" with { type: "json" };
import { implementation as signalFault } from "./org.cgp.signal-fault/module.ts";
import pipeDoubleManifest from "./org.cgp.pipe-double/manifest.json" with { type: "json" };
import { implementation as pipeDouble } from "./org.cgp.pipe-double/module.ts";
import pipeOffsetManifest from "./org.cgp.pipe-offset/manifest.json" with { type: "json" };
import { implementation as pipeOffset } from "./org.cgp.pipe-offset/module.ts";
import pipeFaultManifest from "./org.cgp.pipe-fault/manifest.json" with { type: "json" };
import { implementation as pipeFault } from "./org.cgp.pipe-fault/module.ts";
import queryCoreManifest from "./org.cgp.query-core/manifest.json" with { type: "json" };
import { implementation as queryCore } from "./org.cgp.query-core/module.ts";
import nameIndexManifest from "./org.cgp.name-index/manifest.json" with { type: "json" };
import { implementation as nameIndex } from "./org.cgp.name-index/module.ts";
import aliasIndexManifest from "./org.cgp.alias-index/manifest.json" with { type: "json" };
import { implementation as aliasIndex } from "./org.cgp.alias-index/module.ts";
import pulseCountManifest from "./org.cgp.pulse-count/manifest.json" with { type: "json" };
import { implementation as pulseCount } from "./org.cgp.pulse-count/module.ts";
import worldCoreManifest from "./org.cgp.world-core/manifest.json" with { type: "json" };
import { implementation as worldCore } from "./org.cgp.world-core/module.ts";
import worldStoreManifest from "./org.cgp.world-store/manifest.json" with { type: "json" };
import { implementation as worldStore } from "./org.cgp.world-store/module.ts";
import stepCoreManifest from "./org.cgp.step-core/manifest.json" with { type: "json" };
import { implementation as stepCore } from "./org.cgp.step-core/module.ts";
import stepClockManifest from "./org.cgp.step-clock/manifest.json" with { type: "json" };
import { implementation as stepClock } from "./org.cgp.step-clock/module.ts";
import stepWitnessManifest from "./org.cgp.step-witness/manifest.json" with { type: "json" };
import { implementation as stepWitness } from "./org.cgp.step-witness/module.ts";
import simCoreManifest from "./org.cgp.sim-core/manifest.json" with { type: "json" };
import { implementation as simCore } from "./org.cgp.sim-core/module.ts";
import simLedgerManifest from "./org.cgp.sim-ledger/manifest.json" with { type: "json" };
import { implementation as simLedger } from "./org.cgp.sim-ledger/module.ts";
import simMoveManifest from "./org.cgp.sim-move/manifest.json" with { type: "json" };
import { implementation as simMove } from "./org.cgp.sim-move/module.ts";
import simBoundManifest from "./org.cgp.sim-bound/manifest.json" with { type: "json" };
import { boundWasmBytes } from "./org.cgp.sim-bound/bytes.ts";
import simWitnessManifest from "./org.cgp.sim-witness/manifest.json" with { type: "json" };
import { implementation as simWitness } from "./org.cgp.sim-witness/module.ts";

export type ModuleGroup = "Flora" | "Lighting" | "Signals" | "Queries" | "World" | "Simulation" | "Faults";

export type CatalogEntry = {
  group: ModuleGroup;
  defaultOn: boolean;
  manifest: unknown;
  implementation?: ModuleImplementation;
};

function entry(
  group: ModuleGroup,
  defaultOn: boolean,
  manifest: unknown,
  implementation?: ModuleImplementation,
): CatalogEntry {
  return { group, defaultOn, manifest, implementation };
}

/** Bundled packages. Filesystem discovery of the same folders is the headless path. */
export const CATALOG: readonly CatalogEntry[] = [
  entry("Flora", true, floraCoreManifest, floraCore),
  entry("Flora", true, forestManifest, forestPlants),
  entry("Flora", false, desertManifest, desertPlants),
  entry("Flora", true, seasonalManifest, seasonalGrowth),
  entry("Flora", false, acceleratedManifest, acceleratedGrowth),
  entry("Flora", false, duneManifest, { wasm: duneWasmBytes }),
  entry("Lighting", true, lightingManifest, lightingCore),
  entry("Lighting", true, pointManifest, pointLights),
  entry("Lighting", true, directionalManifest, directionalLights),
  entry("Signals", false, signalsManifest, signalsCore),
  entry("Signals", false, stampManifest, signalStamp),
  entry("Signals", false, lateManifest, signalLate),
  entry("Signals", false, pipeDoubleManifest, pipeDouble),
  entry("Signals", false, pipeOffsetManifest, pipeOffset),
  entry("Signals", false, pulseCountManifest, pulseCount),
  entry("Signals", false, signalFaultManifest, signalFault),
  entry("Signals", false, pipeFaultManifest, pipeFault),
  entry("Queries", false, queryCoreManifest, queryCore),
  entry("Queries", false, nameIndexManifest, nameIndex),
  entry("Queries", false, aliasIndexManifest, aliasIndex),
  entry("World", false, worldCoreManifest, worldCore),
  entry("World", false, worldStoreManifest, worldStore),
  entry("World", false, stepCoreManifest, stepCore),
  entry("World", false, stepClockManifest, stepClock),
  entry("World", false, stepWitnessManifest, stepWitness),
  entry("Simulation", false, simCoreManifest, simCore),
  entry("Simulation", false, simLedgerManifest, simLedger),
  entry("Simulation", false, simMoveManifest, simMove),
  entry("Simulation", false, simBoundManifest, { wasm: boundWasmBytes }),
  entry("Simulation", false, simWitnessManifest, simWitness),
  entry("Faults", false, cycleAlphaManifest),
  entry("Faults", false, cycleBetaManifest),
  entry("Faults", false, initFaultManifest, initFault),
  entry("Faults", false, mismatchManifest, contractMismatch),
  entry("Faults", false, badManifest),
  entry("Faults", false, markerLeftManifest),
  entry("Faults", false, markerRightManifest),
  entry("Faults", false, markerUseManifest),
];

export function moduleIdOf(manifest: unknown): string {
  if (manifest && typeof manifest === "object" && "moduleId" in manifest) {
    const id = (manifest as { moduleId?: unknown }).moduleId;
    if (typeof id === "string") return id;
  }
  return "";
}

export function toPackage(entry: CatalogEntry): ModulePackage {
  return { manifest: entry.manifest, implementation: entry.implementation };
}

export function packagesFor(ids: readonly string[]): ModulePackage[] {
  const wanted = new Set(ids);
  return CATALOG.filter((item) => wanted.has(moduleIdOf(item.manifest))).map(toPackage);
}

export const PROOF_IDS = CATALOG.filter((item) => item.defaultOn).map((item) => moduleIdOf(item.manifest));

/** Signals packages that demonstrate subscriber fan-out and a pipeline fold. Faults stay out. */
export const DISPATCH_IDS = [
  "org.cgp.signals-core",
  "org.cgp.signal-stamp",
  "org.cgp.signal-late",
  "org.cgp.pipe-double",
  "org.cgp.pipe-offset",
  "org.cgp.pulse-count",
] as const;

/** One service owner and its single provider. A second provider is a separate fault. */
export const SERVICE_IDS = ["org.cgp.query-core", "org.cgp.name-index"] as const;

/** Caller-driven simulation. Off in the default proof. The boundary guest is WebAssembly. */
export const SIM_IDS = [
  "org.cgp.sim-core",
  "org.cgp.sim-ledger",
  "org.cgp.sim-move",
  "org.cgp.sim-bound",
  "org.cgp.sim-witness",
] as const;
