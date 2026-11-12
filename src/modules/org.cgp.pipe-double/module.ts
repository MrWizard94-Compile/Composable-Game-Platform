import type { ModuleImplementation } from "../../foundations/host.ts";

export const implementation: ModuleImplementation = {
  register(ctx) {
    ctx.contribute("signals.pipe", {
      id: "double",
      order: 10,
      payload: {
        label: "Double",
        handle(value: unknown) {
          return typeof value === "number" ? value * 2 : value;
        },
      },
    });
  },
};
