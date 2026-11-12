import type { ModuleImplementation } from "../../foundations/host.ts";

export const implementation: ModuleImplementation = {
  register(ctx) {
    ctx.contribute("platform.systems", {
      id: "lighting",
      payload: { systemId: "lighting", label: "Lighting" },
    });
  },
};
