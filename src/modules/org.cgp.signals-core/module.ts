import type { ModuleImplementation } from "../../foundations/host.ts";

export const implementation: ModuleImplementation = {
  register(ctx) {
    ctx.contribute("platform.systems", {
      id: "signals",
      payload: { systemId: "signals", label: "Signals" },
    });
  },
};
