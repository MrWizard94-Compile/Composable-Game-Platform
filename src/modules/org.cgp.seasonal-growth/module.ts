import type { ModuleImplementation } from "../../foundations/host.ts";

type SpeciesShape = { growthRate: number; maxStage: number };
type SeasonName = "spring" | "summer" | "autumn" | "winter";

const FACTOR: Record<SeasonName, number> = {
  spring: 1.15,
  summer: 1,
  autumn: 0.45,
  winter: 0.12,
};

export const implementation: ModuleImplementation = {
  register(ctx) {
    ctx.contribute("flora.growth-model", {
      id: "seasonal",
      payload: {
        strategyId: "seasonal",
        label: "Seasonal growth",
        summary: "Spring multiplies growth by 1.15. Winter multiplies it by 0.12.",
        advance(species: SpeciesShape, season: SeasonName, stage: number) {
          const next = stage + species.growthRate * FACTOR[season];
          return Math.round(Math.min(species.maxStage, next) * 100) / 100;
        },
      },
    });
  },
};
