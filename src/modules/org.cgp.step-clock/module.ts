import type { ModuleImplementation } from "../../foundations/host.ts";

type State = { count: number };

export const implementation: ModuleImplementation = {
  register(ctx) {
    const state: State = { count: 0 };
    ctx.keep(state);
    ctx.contribute("step.advance", {
      id: "clock",
      payload() {
        state.count += 1;
        return { count: state.count };
      },
    });
  },
  exportState(ctx) {
    const state = ctx.kept() as State | undefined;
    return { count: state?.count ?? 0 };
  },
  importState(ctx, saved) {
    const state = ctx.kept() as State | undefined;
    if (!state) return;
    const count = saved && typeof saved === "object" && "count" in saved ? (saved as { count?: unknown }).count : undefined;
    if (typeof count !== "number") throw new Error("Step save is not a count.");
    state.count = count;
  },
};
