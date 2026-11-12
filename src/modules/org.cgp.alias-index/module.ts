import type { ModuleImplementation } from "../../foundations/host.ts";

export const implementation: ModuleImplementation = {
  register(ctx) {
    ctx.contribute("queries.ask", {
      id: "aliases",
      payload: {
        label: "Alias index",
        handle(input: unknown) {
          return { alias: input };
        },
      },
    });
  },
};
