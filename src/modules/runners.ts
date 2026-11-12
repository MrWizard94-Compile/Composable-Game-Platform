import { contributionsFor, type CompositionResult } from "../foundations/host.ts";
import { publish, runPipeline, callService, type PipelineReport, type PublishReport, type ServiceReport } from "../foundations/dispatch.ts";

export const SEASONS = ["spring", "summer", "autumn", "winter"] as const;
export type Season = (typeof SEASONS)[number];

export type SpeciesView = {
  id: string;
  commonName: string;
  biome: string;
  growthRate: number;
  maxStage: number;
};

export type GrowthRow = SpeciesView & {
  stage: number;
  note: string;
};

type StrategyPayload = {
  strategyId?: unknown;
  label?: unknown;
  summary?: unknown;
  advance?: unknown;
};

function isSpecies(value: unknown): value is SpeciesView {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.commonName === "string" &&
    typeof row.biome === "string" &&
    typeof row.growthRate === "number" &&
    typeof row.maxStage === "number"
  );
}

export type FloraStep =
  | {
      ok: true;
      strategy: string;
      summary: string;
      rows: GrowthRow[];
    }
  | { ok: false; reason: string };

/**
 * Demo runner. It lives outside the Foundations and understands Flora payloads.
 * The host only hands back the contributions it was given.
 */
export function advanceFlora(
  result: CompositionResult,
  stages: Readonly<Record<string, number>>,
  season: Season,
): FloraStep {
  if (!result.runtimeActive) {
    return { ok: false, reason: "Runtime is not active. Fix the composition before stepping growth." };
  }
  const speciesSlot = result.slots.find((slot) => slot.slotId === "flora.plant-species");
  if (!speciesSlot) {
    return { ok: false, reason: "Flora Core is not in this composition, so there is no species slot." };
  }
  const strategies = contributionsFor(result, "flora.growth-model");
  const strategy = strategies[0]?.payload as StrategyPayload | undefined;
  const advance =
    strategy && typeof strategy.advance === "function"
      ? (strategy.advance as (species: SpeciesView, season: Season, stage: number) => number)
      : undefined;
  const rows: GrowthRow[] = [];
  for (const contribution of contributionsFor(result, "flora.plant-species")) {
    if (!isSpecies(contribution.payload)) {
      return {
        ok: false,
        reason: `Contribution "${contribution.id}" from ${contribution.moduleId} is not a species record.`,
      };
    }
    const current = stages[contribution.payload.id] ?? 0;
    if (!advance || !strategy) {
      rows.push({
        ...contribution.payload,
        stage: current,
        note: "No growth model connected.",
      });
      continue;
    }
    const next = advance(contribution.payload, season, current);
    if (typeof next !== "number" || Number.isNaN(next)) {
      return { ok: false, reason: `Growth model returned a non-numeric stage for ${contribution.payload.id}.` };
    }
    rows.push({
      ...contribution.payload,
      stage: next,
      note: next >= contribution.payload.maxStage ? "At canopy." : `+${Math.round((next - current) * 100) / 100}`,
    });
  }
  return {
    ok: true,
    strategy: typeof strategy?.label === "string" ? strategy.label : "No growth model",
    summary: typeof strategy?.summary === "string" ? strategy.summary : "Species stay where they are.",
    rows,
  };
}

export type LightSource = {
  id: string;
  label: string;
  kind: string;
  intensity: number;
  moduleId: string;
};

export type LightingRead =
  | { ok: true; sources: LightSource[]; total: number }
  | { ok: false; reason: string };

export function readLighting(result: CompositionResult): LightingRead {
  if (!result.runtimeActive) {
    return { ok: false, reason: "Runtime is not active." };
  }
  if (!result.slots.some((slot) => slot.slotId === "lighting.sources")) {
    return { ok: false, reason: "Lighting Core is not in this composition." };
  }
  const sources: LightSource[] = [];
  for (const contribution of contributionsFor(result, "lighting.sources")) {
    const payload = contribution.payload;
    if (!payload || typeof payload !== "object") {
      return { ok: false, reason: `Light contribution "${contribution.id}" has no payload.` };
    }
    const row = payload as Record<string, unknown>;
    if (typeof row.label !== "string" || typeof row.kind !== "string" || typeof row.intensity !== "number") {
      return { ok: false, reason: `Light contribution "${contribution.id}" does not match the source contract.` };
    }
    sources.push({
      id: contribution.id,
      label: row.label,
      kind: row.kind,
      intensity: row.intensity,
      moduleId: contribution.moduleId,
    });
  }
  const total = sources.reduce((sum, source) => sum + source.intensity, 0);
  return { ok: true, sources, total };
}

export type PulseView = {
  heard: string[];
  report: PublishReport;
};

/** Demo runner. The host fans the event out; this only builds the pulse object. */
export function dispatchPulse(result: CompositionResult): PulseView {
  const heard: string[] = [];
  const report = publish(result, "signals.listeners", { heard });
  return { heard: [...heard], report };
}

export type PipeView = PipelineReport & { input: number };

/** Demo runner. The host folds the number; this only chooses the slot. */
export function foldPipe(result: CompositionResult, input: number): PipeView {
  return { input, ...runPipeline(result, "signals.pipe", input) };
}

export type QueryView = { question: string; report: ServiceReport };

/** Demo runner. The host calls the one service provider; this only chooses the slot. */
export function askQuery(result: CompositionResult, question: string): QueryView {
  return { question, report: callService(result, "queries.ask", question) };
}

export type StepView = {
  ok: boolean;
  count: number | null;
  reason?: string;
  deliveries: number;
};

/** Demo runner. One call advances the clock and publishes that step. Nothing loops. */
export function advanceStep(result: CompositionResult): StepView {
  const advanced = callService(result, "step.advance", null);
  if (!advanced.ok) {
    return { ok: false, count: null, reason: advanced.message ?? advanced.reason, deliveries: 0 };
  }
  const count =
    advanced.output && typeof advanced.output === "object" && "count" in advanced.output
      ? (advanced.output as { count?: unknown }).count
      : undefined;
  const fan = publish(result, "step.hear", advanced.output);
  return {
    ok: fan.ok && typeof count === "number",
    count: typeof count === "number" ? count : null,
    deliveries: fan.deliveries.length,
    reason: fan.ok ? undefined : "A step listener failed.",
  };
}

export type EntityView = { id: string; record: unknown };

/** Demo runner. The world module stores the record. This only calls the service. */
export function spawnEntity(result: CompositionResult, record: unknown): ServiceReport {
  return callService(result, "world.spawn", record);
}

export function removeEntity(result: CompositionResult, id: string): ServiceReport {
  return callService(result, "world.remove", id);
}

export function listEntities(result: CompositionResult): EntityView[] {
  const report = callService(result, "world.list", null);
  if (!report.ok || !report.output || typeof report.output !== "object" || !("entities" in report.output)) return [];
  const entities = (report.output as { entities?: unknown }).entities;
  if (!Array.isArray(entities)) return [];
  return entities.filter((item): item is EntityView => {
    return !!item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string";
  });
}
