import type { ModuleImplementation } from "../../foundations/host.ts";

export const implementation: ModuleImplementation = {
  register(ctx) {
    ctx.contribute("platform.systems", {
      id: "fault",
      payload: { systemId: "fault", label: "Fault" },
    });
  },
  initialize() {
    throw new Error("init-fault refused to start");
  },
};
