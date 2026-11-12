import type { ModuleImplementation } from "../../foundations/host.ts";

export const implementation: ModuleImplementation = {
  register(ctx) {
    ctx.contribute("signals.pipe", {
      id: "offset",
      order: 30,
      payload: {
        label: "Offset +3",
        handle(value: unknown) {
          return typeof value === "number" ? value + 3 : value;
        },
      },
    });
  },
};
