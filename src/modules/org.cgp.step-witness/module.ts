import type { ModuleImplementation } from "../../foundations/host.ts";

type State = { heard: number[] };

export const implementation: ModuleImplementation = {
  register(ctx) {
    const state: State = { heard: [] };
    ctx.keep(state);
    ctx.contribute("step.hear", {
      id: "witness",
      payload(event: unknown) {
        const count =
          event && typeof event === "object" && "count" in event ? (event as { count?: unknown }).count : undefined;
        if (typeof count !== "number") throw new Error("Step event has no count.");
        state.heard.push(count);
      },
    });
  },
  exportState(ctx) {
    const state = ctx.kept() as State | undefined;
    return { heard: state?.heard ?? [] };
  },
  importState(ctx, saved) {
    const state = ctx.kept() as State | undefined;
    if (!state) return;
    const heard = saved && typeof saved === "object" && "heard" in saved ? (saved as { heard?: unknown }).heard : undefined;
    if (!Array.isArray(heard) || heard.some((item) => typeof item !== "number")) {
      throw new Error("Witness save is not a list of counts.");
    }
    state.heard = [...heard];
  },
};
