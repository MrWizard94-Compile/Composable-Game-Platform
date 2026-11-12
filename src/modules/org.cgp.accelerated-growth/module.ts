import type { ModuleImplementation } from "../../foundations/host.ts";

type SpeciesShape = { growthRate: number; maxStage: number };
type SeasonName = "spring" | "summer" | "autumn" | "winter";

export const implementation: ModuleImplementation = {
  register(ctx) {
    ctx.contribute("flora.growth-model", {
      id: "accelerated",
      payload: {
        strategyId: "accelerated",
        label: "Accelerated growth",
        summary: "Ignores the season and advances at 2.4 times the species rate.",
        advance(species: SpeciesShape, _season: SeasonName, stage: number) {
          const next = stage + species.growthRate * 2.4;
          return Math.round(Math.min(species.maxStage, next) * 100) / 100;
        },
      },
    });
  },
};
