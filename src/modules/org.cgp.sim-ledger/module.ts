import type { ModuleImplementation } from "../../foundations/host.ts";

type Entity = { id: string; x: number; y: number };
type State = { tick: number; entities: Entity[] };

const ID_RE = /^[a-z][a-z0-9]{0,15}$/;
const I32 = 2147483647;
const MAX_ENTITIES = 32;

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

function entityOf(value: unknown): Entity | undefined {
  const row = asRecord(value);
  if (!row || typeof row.id !== "string" || !ID_RE.test(row.id)) return undefined;
  if (!isInt(row.x) || !isInt(row.y) || !fits(row.x) || !fits(row.y)) return undefined;
  return { id: row.id, x: row.x, y: row.y };
}

function copyEntities(entities: readonly Entity[]): Entity[] {
  return entities.map((item) => ({ id: item.id, x: item.x, y: item.y }));
}

function sorted(entities: readonly Entity[]): Entity[] {
  return copyEntities(entities).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export const implementation: ModuleImplementation = {
  register(ctx) {
    const state: State = { tick: 0, entities: [] };
    ctx.keep(state);
    ctx.contribute("sim.seed", {
      id: "seed",
      payload(input: unknown) {
        if (state.tick !== 0) throw new Error("Simulation seed is closed after the first step.");
        if (state.entities.length >= MAX_ENTITIES) throw new Error("Simulation ledger is full.");
        const entity = entityOf(input);
        if (!entity) throw new Error("Simulation seed is not an integer entity.");
        if (state.entities.some((item) => item.id === entity.id)) throw new Error("Simulation seed repeats an entity.");
        state.entities = sorted([...state.entities, entity]);
        return { id: entity.id };
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
        const tick = row?.tick;
        const listed = row?.entities;
        if (!isInt(tick) || !Array.isArray(listed)) throw new Error("Simulation commit is not a ledger.");
        if (tick !== state.tick + 1) throw new Error("Simulation commit is not the next tick.");
        if (listed.length !== state.entities.length) throw new Error("Simulation commit changed the entity set.");
        const next: Entity[] = [];
        for (let index = 0; index < listed.length; index += 1) {
          const entity = entityOf(listed[index]);
          const current = state.entities[index];
          if (!entity || !current || entity.id !== current.id) throw new Error("Simulation commit changed the entity set.");
          next.push(entity);
        }
        state.tick = tick;
        state.entities = next;
        return { tick };
      },
    });
  },
  exportState(ctx) {
    const state = ctx.kept() as State | undefined;
    return { tick: state?.tick ?? 0, entities: copyEntities(state?.entities ?? []) };
  },
  importState(ctx, saved) {
    const state = ctx.kept() as State | undefined;
    if (!state) return;
    const row = asRecord(saved);
    const tick = row?.tick;
    const listed = row?.entities;
    if (!isInt(tick) || tick < 0 || !Array.isArray(listed)) throw new Error("Simulation save is not a ledger.");
    if (listed.length > MAX_ENTITIES) throw new Error("Simulation save has too many entities.");
    const entities: Entity[] = [];
    for (const item of listed) {
      const entity = entityOf(item);
      if (!entity) throw new Error("Simulation save has an entity that is not an integer position.");
      if (entities.some((have) => have.id === entity.id)) throw new Error("Simulation save repeats an entity.");
      entities.push(entity);
    }
    state.tick = tick;
    state.entities = sorted(entities);
  },
};
