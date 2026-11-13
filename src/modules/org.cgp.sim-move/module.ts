import type { ModuleImplementation } from "../../foundations/host.ts";

const I32 = 2147483647;

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

export const implementation: ModuleImplementation = {
  register(ctx) {
    ctx.contribute("sim.systems", {
      id: "move",
      order: 10,
      payload(input: unknown) {
        const row = asRecord(input);
        const tick = row?.tick;
        const delta = row?.delta;
        const inputs = row?.inputs;
        const entities = row?.entities;
        const prior = row?.commands;
        if (!isInt(tick) || !isInt(delta) || delta < 1 || !Array.isArray(inputs) || !Array.isArray(entities) || !Array.isArray(prior)) {
          throw new Error("Simulation step is not a proposal.");
        }
        const drives = new Map<string, { vx: number; vy: number }>();
        for (const item of inputs) {
          const drive = asRecord(item);
          if (!drive || typeof drive.id !== "string" || !isInt(drive.vx) || !isInt(drive.vy) || !fits(drive.vx) || !fits(drive.vy)) {
            throw new Error("Simulation step is not a proposal.");
          }
          drives.set(drive.id, { vx: drive.vx, vy: drive.vy });
        }
        const commands = prior.map((item) => item);
        for (const item of entities) {
          const entity = asRecord(item);
          if (!entity || typeof entity.id !== "string" || !isInt(entity.x) || !isInt(entity.y) || !fits(entity.x) || !fits(entity.y)) {
            throw new Error("Simulation step is not a proposal.");
          }
          const drive = drives.get(entity.id) ?? { vx: 0, vy: 0 };
          const x = entity.x + drive.vx * delta;
          const y = entity.y + drive.vy * delta;
          if (!fits(x) || !fits(y)) throw new Error("Movement produced a position outside 32-bit range.");
          commands.push({ op: "move", id: entity.id, x, y });
        }
        return {
          tick,
          delta,
          inputs,
          entities,
          commands,
        };
      },
    });
  },
};
