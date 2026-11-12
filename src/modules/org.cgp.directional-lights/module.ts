import type { ModuleImplementation } from "../../foundations/host.ts";

export const implementation: ModuleImplementation = {
  register(ctx) {
    ctx.contribute("lighting.sources", {
      id: "sun",
      payload: { id: "sun", label: "Sun", kind: "directional", intensity: 5 },
    });
    ctx.contribute("lighting.sources", {
      id: "moon",
      payload: { id: "moon", label: "Moon", kind: "directional", intensity: 1 },
    });
  },
};
