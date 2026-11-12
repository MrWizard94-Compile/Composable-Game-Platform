import type { ModuleImplementation } from "../../src/foundations/index.ts";

export const implementation: ModuleImplementation = {
  register(ctx) {
    ctx.contribute("platform.systems", {
      id: "starter",
      payload: { systemId: "starter", label: "Starter" },
    });
  },
};
