import type { CompositionResult } from "../foundations/host.ts";
import { callService, publish, runPipeline, type PipelineStage, type ServiceReport } from "../foundations/dispatch.ts";

/**
 * Caller-driven simulation runner. It lives outside the Foundations.
 * Nothing here waits on a clock. One call advances one integer step, or it
 * leaves the ledger untouched.
 *
 * Systems on `sim.systems` receive a proposal and return the next proposal.
 * They do not write the ledger. The runner commits only after the pipeline
 * returns one in-range move for every entity. `runPipeline` stops on the
 * first failure, so a later system does not see a rejected step.
 */

export const SIM_MIN = 0;
export const SIM_MAX = 1000;

const MAX_DELTA = 10000;
const MAX_ROWS = 32;
const I32 = 2147483647;
const ID_RE = /^[a-z][a-z0-9]{0,15}$/;

export type SimEntity = { id: string; x: number; y: number };
export type SimDrive = { id: string; vx: number; vy: number };
export type SimCommand = { op: "move"; id: string; x: number; y: number };

export type SimStepRequest = {
  tick: number;
  delta: number;
  inputs: readonly SimDrive[];
};

export type SimStage = { moduleId: string; id: string; ok: boolean };

export type SimState = { tick: number; entities: SimEntity[] };

export type SimStep =
  | {
      ok: true;
      tick: number;
      delta: number;
      entities: SimEntity[];
      commands: SimCommand[];
      deliveries: number;
      stages: SimStage[];
    }
  | { ok: false; reason: string; stages: SimStage[] };

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function fits(value: number): boolean {
  return value >= -I32 && value <= I32;
}

function inGate(value: number): boolean {
  return value >= SIM_MIN && value <= SIM_MAX;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function refused(reason: string, stages: SimStage[] = []): SimStep {
  return { ok: false, reason, stages };
}

function stagesOf(stages: readonly PipelineStage[]): SimStage[] {
  return stages.map((stage) => ({ moduleId: stage.moduleId, id: stage.contributionId, ok: stage.ok }));
}

function serviceReason(report: ServiceReport): string {
  return report.message ?? report.reason ?? "Simulation service failed.";
}

function readState(value: unknown): SimState | undefined {
  const row = asRecord(value);
  const tick = row?.tick;
  const listed = row?.entities;
  if (!isInt(tick) || tick < 0 || !Array.isArray(listed)) return undefined;
  const entities: SimEntity[] = [];
  for (const item of listed) {
    const entity = asRecord(item);
    if (!entity || typeof entity.id !== "string" || !isInt(entity.x) || !isInt(entity.y)) return undefined;
    entities.push({ id: entity.id, x: entity.x, y: entity.y });
  }
  return { tick, entities };
}

function sameRows(left: readonly { id: string }[], right: unknown, fields: readonly string[]): boolean {
  if (!Array.isArray(right) || right.length !== left.length) return false;
  return left.every((item, index) => {
    const row = asRecord(right[index]);
    if (!row) return false;
    return fields.every((field) => row[field] === (item as Record<string, unknown>)[field]);
  });
}

function commandsFor(value: unknown, entities: readonly SimEntity[]): SimCommand[] | undefined {
  if (!Array.isArray(value) || value.length !== entities.length) return undefined;
  const commands: SimCommand[] = [];
  for (let index = 0; index < entities.length; index += 1) {
    const row = asRecord(value[index]);
    const entity = entities[index];
    if (!row || !entity || row.op !== "move" || row.id !== entity.id) return undefined;
    if (!isInt(row.x) || !isInt(row.y) || !inGate(row.x) || !inGate(row.y)) return undefined;
    commands.push({ op: "move", id: entity.id, x: row.x, y: row.y });
  }
  return commands;
}

export async function seedSimulation(
  result: CompositionResult,
  entity: SimEntity,
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const seeded = await callService(result, "sim.seed", entity);
  if (!seeded.ok) return { ok: false, reason: serviceReason(seeded) };
  const id = asRecord(seeded.output)?.id;
  if (typeof id !== "string") return { ok: false, reason: "Simulation seed did not return an id." };
  return { ok: true, id };
}

export async function readSimulation(
  result: CompositionResult,
): Promise<{ ok: true; state: SimState } | { ok: false; reason: string }> {
  const read = await callService(result, "sim.read", null);
  if (!read.ok) return { ok: false, reason: serviceReason(read) };
  const state = readState(read.output);
  if (!state) return { ok: false, reason: "Simulation ledger is not integer state." };
  return { ok: true, state };
}

export async function advanceSimulation(result: CompositionResult, request: SimStepRequest): Promise<SimStep> {
  if (result.quiesced) return refused("Runtime has shut down.");
  if (!result.runtimeActive) return refused("Runtime is not active.");
  const read = await readSimulation(result);
  if (!read.ok) return refused(read.reason);
  const state = read.state;
  if (!isInt(request.tick) || request.tick !== state.tick + 1) return refused("Tick must be the next integer.");
  if (!isInt(request.delta) || request.delta < 1 || request.delta > MAX_DELTA) return refused("Delta must be a positive integer.");
  if (!Array.isArray(request.inputs) || request.inputs.length > MAX_ROWS) return refused("Simulation input is not an integer drive.");

  const known = new Set(state.entities.map((item) => item.id));
  const seen = new Set<string>();
  const inputs: SimDrive[] = [];
  for (const item of request.inputs) {
    const drive = asRecord(item);
    if (!drive || typeof drive.id !== "string" || !ID_RE.test(drive.id) || !isInt(drive.vx) || !isInt(drive.vy) || !fits(drive.vx) || !fits(drive.vy)) {
      return refused("Simulation input is not an integer drive.");
    }
    if (!known.has(drive.id)) return refused("Simulation input names an entity that is not in the state.");
    if (seen.has(drive.id)) return refused("Simulation input repeats an entity.");
    seen.add(drive.id);
    inputs.push({ id: drive.id, vx: drive.vx, vy: drive.vy });
  }

  const sentInputs = clone(inputs);
  const sentEntities = clone(state.entities);
  const proposal = {
    tick: request.tick,
    delta: request.delta,
    inputs: clone(sentInputs),
    entities: clone(sentEntities),
    commands: [] as SimCommand[],
  };
  const folded = await runPipeline(result, "sim.systems", proposal);
  const stages = stagesOf(folded.stages);
  if (!folded.ok) {
    const failed = [...folded.stages].reverse().find((stage) => !stage.ok);
    return refused(failed?.message ?? folded.reason ?? "A simulation system failed.", stages);
  }

  const output = asRecord(folded.output);
  if (!output || output.tick !== request.tick || output.delta !== request.delta) {
    return refused("Simulation proposal is not a complete step.", stages);
  }
  if (!sameRows(sentInputs, output.inputs, ["id", "vx", "vy"])) {
    return refused("Simulation proposal is not a complete step.", stages);
  }
  if (!sameRows(sentEntities, output.entities, ["id", "x", "y"])) {
    return refused("Simulation proposal is not a complete step.", stages);
  }
  const commands = commandsFor(output.commands, sentEntities);
  if (!commands) return refused("Simulation proposal is not a complete step.", stages);

  const entities = commands.map((command) => ({ id: command.id, x: command.x, y: command.y }));
  const committed = await callService(result, "sim.commit", { tick: request.tick, entities });
  if (!committed.ok) return refused(serviceReason(committed), stages);

  const fan = await publish(result, "sim.completed", {
    tick: request.tick,
    delta: request.delta,
    entities,
    commands,
  });
  return {
    ok: true,
    tick: request.tick,
    delta: request.delta,
    entities,
    commands,
    deliveries: fan.deliveries.length,
    stages,
  };
}
