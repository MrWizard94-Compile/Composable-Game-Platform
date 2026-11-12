import type { ModuleImplementation } from "../../foundations/host.ts";

type Species = {
  id: string;
  commonName: string;
  biome: string;
  growthRate: number;
  maxStage: number;
};

function species(value: Species): Species {
  return value;
}

export const implementation: ModuleImplementation = {
  register(ctx) {
    const slot = "flora.plant-species";
    const rows: Species[] = [
      species({ id: "oak", commonName: "Oak", biome: "Temperate", growthRate: 0.35, maxStage: 8 }),
      species({ id: "pine", commonName: "Pine", biome: "Boreal", growthRate: 0.22, maxStage: 10 }),
      species({ id: "fern", commonName: "Fern", biome: "Understory", growthRate: 0.8, maxStage: 3 }),
    ];
    for (const row of rows) ctx.contribute(slot, { id: row.id, payload: row });
  },
};
