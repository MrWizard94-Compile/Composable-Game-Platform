import type { ModuleImplementation } from "../../foundations/host.ts";

export const implementation: ModuleImplementation = {
  register(ctx) {
    ctx.contribute("flora.plant-species", {
      id: "weed",
      payload: { id: "weed", commonName: "Weed", biome: "Anywhere", growthRate: 1, maxStage: 2 },
    });
  },
};
