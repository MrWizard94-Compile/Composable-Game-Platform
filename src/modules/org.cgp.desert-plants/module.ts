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
      species({ id: "cactus", commonName: "Cactus", biome: "Desert", growthRate: 0.15, maxStage: 6 }),
      species({ id: "sage", commonName: "Sagebrush", biome: "Scrub", growthRate: 0.4, maxStage: 4 }),
    ];
    for (const row of rows) ctx.contribute(slot, { id: row.id, payload: row });
  },
};
