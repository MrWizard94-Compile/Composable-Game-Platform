import type { ModuleImplementation } from "../../foundations/host.ts";

export const implementation: ModuleImplementation = {
  register(ctx) {
    ctx.contribute("lighting.sources", {
      id: "torch",
      payload: { id: "torch", label: "Torch", kind: "point", intensity: 4 },
    });
    ctx.contribute("lighting.sources", {
      id: "lamp",
      payload: { id: "lamp", label: "Lamp", kind: "point", intensity: 2 },
    });
  },
};
