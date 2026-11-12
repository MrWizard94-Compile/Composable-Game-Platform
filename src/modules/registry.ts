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

export type ModuleGroup = "Flora" | "Lighting" | "Faults";

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
  entry("Lighting", true, lightingManifest, lightingCore),
  entry("Lighting", true, pointManifest, pointLights),
  entry("Lighting", true, directionalManifest, directionalLights),
  entry("Faults", false, cycleAlphaManifest),
  entry("Faults", false, cycleBetaManifest),
  entry("Faults", false, initFaultManifest, initFault),
  entry("Faults", false, mismatchManifest, contractMismatch),
  entry("Faults", false, badManifest),
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
