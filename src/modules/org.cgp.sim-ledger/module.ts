import type { ModuleImplementation } from "../../foundations/host.ts";

type Entity = { id: string; x: number; y: number };
type State = { tick: number; entities: Entity[]; open: number };

const ID_RE = /^[a-z][a-z0-9]{0,15}$/;
const I32 = 2147483647;
const MAX_ENTITIES = 32;
const SIM_MIN = 0;
const SIM_MAX = 1000;
const OUTSIDE = "Simulation position is outside 0 through 1000.";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function fits(value: number): boolean {
  return value >= -I32 && value <= I32;
}

function classify(value: unknown): { ok: true; entity: Entity } | { ok: false; code: "shape" | "range" } {
  const row = asRecord(value);
  if (!row || typeof row.id !== "string" || !ID_RE.test(row.id)) return { ok: false, code: "shape" };
  if (!isInt(row.x) || !isInt(row.y) || !fits(row.x) || !fits(row.y)) return { ok: false, code: "shape" };
  if (row.x < SIM_MIN || row.x > SIM_MAX || row.y < SIM_MIN || row.y > SIM_MAX) return { ok: false, code: "range" };
  return { ok: true, entity: { id: row.id, x: row.x, y: row.y } };
}

function copyEntities(entities: readonly Entity[]): Entity[] {
  return entities.map((item) => ({ id: item.id, x: item.x, y: item.y }));
}

function sorted(entities: readonly Entity[]): Entity[] {
  return copyEntities(entities).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function commitEntities(state: State, tick: unknown, listed: unknown): { tick: number } {
  if (state.open === 0) throw new Error("Simulation commit is not an open step.");
  if (!isInt(tick) || !Array.isArray(listed)) throw new Error("Simulation commit is not a ledger.");
  if (tick !== state.tick + 1) throw new Error("Simulation commit is not the next tick.");
  if (tick !== state.open) throw new Error("Simulation commit does not match the open step.");
  if (listed.length !== state.entities.length) throw new Error("Simulation commit changed the entity set.");
  const next: Entity[] = [];
  for (let index = 0; index < listed.length; index += 1) {
    const current = state.entities[index];
    const row = asRecord(listed[index]);
    if (!current || !row || row.id !== current.id) throw new Error("Simulation commit changed the entity set.");
    const parsed = classify(listed[index]);
    if (!parsed.ok && parsed.code === "range") throw new Error(OUTSIDE);
    if (!parsed.ok) throw new Error("Simulation commit is not a ledger.");
    next.push(parsed.entity);
  }
  state.tick = tick;
  state.entities = next;
  state.open = 0;
  return { tick };
}

export const implementation: ModuleImplementation = {
  register(ctx) {
    const state: State = { tick: 0, entities: [], open: 0 };
    ctx.keep(state);
    ctx.contribute("sim.seed", {
      id: "seed",
      payload(input: unknown) {
        if (state.open !== 0) throw new Error("Simulation seed conflicts with an open step.");
        if (state.tick !== 0) throw new Error("Simulation seed is closed after the first step.");
        if (state.entities.length >= MAX_ENTITIES) throw new Error("Simulation ledger is full.");
        const parsed = classify(input);
        if (!parsed.ok && parsed.code === "range") throw new Error(OUTSIDE);
        if (!parsed.ok) throw new Error("Simulation seed is not an integer entity.");
        if (state.entities.some((item) => item.id === parsed.entity.id)) throw new Error("Simulation seed repeats an entity.");
        state.entities = sorted([...state.entities, parsed.entity]);
        return { id: parsed.entity.id };
      },
    });
    ctx.contribute("sim.read", {
      id: "read",
      payload() {
        return { tick: state.tick, entities: copyEntities(state.entities) };
      },
    });
    ctx.contribute("sim.commit", {
      id: "commit",
      payload(input: unknown) {
        const row = asRecord(input);
        if (!row) throw new Error("Simulation commit is not a ledger.");
        if (row.phase === "open") {
          if (!isInt(row.tick)) throw new Error("Simulation commit is not a ledger.");
          if (state.open !== 0) throw new Error("Simulation step is already open.");
          if (row.tick !== state.tick + 1) throw new Error("Simulation commit is not the next tick.");
          state.open = row.tick;
          return { tick: state.open };
        }
        if (row.phase === "abort") {
          state.open = 0;
          return { tick: state.tick };
        }
        if (row.phase !== undefined) throw new Error("Simulation commit is not a ledger.");
        return commitEntities(state, row.tick, row.entities);
      },
    });
  },
  shutdown(ctx) {
    const state = ctx.kept() as State | undefined;
    if (!state) return;
    state.open = 0;
  },
  exportState(ctx) {
    const state = ctx.kept() as State | undefined;
    return { tick: state?.tick ?? 0, entities: copyEntities(state?.entities ?? []) };
  },
  importState(ctx, saved) {
    const state = ctx.kept() as State | undefined;
    if (!state) return;
    if (state.open !== 0) throw new Error("Simulation save conflicts with an open step.");
    const row = asRecord(saved);
    const tick = row?.tick;
    const listed = row?.entities;
    if (!isInt(tick) || tick < 0 || !Array.isArray(listed)) throw new Error("Simulation save is not a ledger.");
    if (listed.length > MAX_ENTITIES) throw new Error("Simulation save has too many entities.");
    const entities: Entity[] = [];
    for (const item of listed) {
      const parsed = classify(item);
      if (!parsed.ok && parsed.code === "range") throw new Error(OUTSIDE);
      if (!parsed.ok) throw new Error("Simulation save has an entity that is not an integer position.");
      if (entities.some((have) => have.id === parsed.entity.id)) throw new Error("Simulation save repeats an entity.");
      entities.push(parsed.entity);
    }
    state.tick = tick;
    state.entities = sorted(entities);
    state.open = 0;
  },
};
