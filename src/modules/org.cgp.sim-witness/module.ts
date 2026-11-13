import type { ModuleImplementation } from "../../foundations/host.ts";

type State = { heard: number[] };

export const implementation: ModuleImplementation = {
  register(ctx) {
    const state: State = { heard: [] };
    ctx.keep(state);
    ctx.contribute("sim.completed", {
      id: "witness",
      payload(event: unknown) {
        const tick =
          event && typeof event === "object" && "tick" in event ? (event as { tick?: unknown }).tick : undefined;
        if (typeof tick !== "number" || !Number.isSafeInteger(tick)) throw new Error("Simulation event has no tick.");
        state.heard.push(tick);
      },
    });
  },
  exportState(ctx) {
    const state = ctx.kept() as State | undefined;
    return { heard: [...(state?.heard ?? [])] };
  },
  importState(ctx, saved) {
    const state = ctx.kept() as State | undefined;
    if (!state) return;
    const heard = saved && typeof saved === "object" && "heard" in saved ? (saved as { heard?: unknown }).heard : undefined;
    if (!Array.isArray(heard) || heard.some((item) => typeof item !== "number" || !Number.isSafeInteger(item))) {
      throw new Error("Witness save is not a list of ticks.");
    }
    state.heard = [...heard];
  },
};
