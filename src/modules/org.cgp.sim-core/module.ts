import type { ModuleImplementation } from "../../foundations/host.ts";

export const implementation: ModuleImplementation = {
  register(ctx) {
    ctx.contribute("platform.systems", {
      id: "sim",
      payload: { systemId: "sim", label: "Simulation" },
    });
  },
};
