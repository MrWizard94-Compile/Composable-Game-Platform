import type { ModuleImplementation } from "../../foundations/host.ts";

type Entity = { id: string; record: unknown };
type State = { next: number; entities: Entity[] };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function jsonRecord(value: unknown): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Entity record is not JSON.");
  return JSON.parse(encoded) as unknown;
}

export const implementation: ModuleImplementation = {
  register(ctx) {
    const state: State = { next: 1, entities: [] };
    ctx.keep(state);
    ctx.contribute("world.spawn", {
      id: "spawn",
      payload(input: unknown) {
        const record = jsonRecord(input);
        if (!asRecord(record)) throw new Error("Entity record must be a JSON object.");
        const id = `e${state.next}`;
        state.next += 1;
        state.entities.push({ id, record });
        return { id };
      },
    });
    ctx.contribute("world.remove", {
      id: "remove",
      payload(input: unknown) {
        const id = typeof input === "string" ? input : asRecord(input)?.id;
        if (typeof id !== "string" || !id) throw new Error("Remove needs an entity id.");
        const before = state.entities.length;
        state.entities = state.entities.filter((item) => item.id !== id);
        return { id, removed: state.entities.length !== before };
      },
    });
    ctx.contribute("world.list", {
      id: "list",
      payload() {
        return { entities: state.entities.map((item) => ({ id: item.id, record: item.record })) };
      },
    });
  },
  exportState(ctx) {
    const state = ctx.kept() as State | undefined;
    return { next: state?.next ?? 1, entities: state?.entities ?? [] };
  },
  importState(ctx, saved) {
    const state = ctx.kept() as State | undefined;
    if (!state) return;
    const row = asRecord(saved);
    const next = row?.next;
    const entities = row?.entities;
    if (typeof next !== "number" || !Array.isArray(entities)) throw new Error("World save is not an entity table.");
    state.next = next;
    state.entities = entities.map((item) => {
      const entity = asRecord(item);
      if (!entity || typeof entity.id !== "string") throw new Error("World save has an entity without an id.");
      return { id: entity.id, record: entity.record };
    });
  },
};
