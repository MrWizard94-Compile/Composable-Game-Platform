import type { ModuleImplementation } from "../../foundations/host.ts";

export const implementation: ModuleImplementation = {
  register(ctx) {
    ctx.contribute("signals.pipe", {
      id: "fault",
      order: 20,
      payload: {
        label: "Fault",
        handle() {
          throw new Error("Stage refused the value.");
        },
      },
    });
  },
};
