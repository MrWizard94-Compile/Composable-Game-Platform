import type { ModuleImplementation } from "../../foundations/host.ts";

export const implementation: ModuleImplementation = {
  register(ctx) {
    ctx.contribute("signals.listeners", {
      id: "fault",
      order: 20,
      payload: {
        label: "Fault",
        handle() {
          throw new Error("Listener refused the pulse.");
        },
      },
    });
  },
};
