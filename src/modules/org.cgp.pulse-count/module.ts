import type { ModuleImplementation } from "../../foundations/host.ts";

type Count = { heard: number };

export const implementation: ModuleImplementation = {
  register(ctx) {
    const state: Count = { heard: 0 };
    ctx.keep(state);
    ctx.contribute("signals.listeners", {
      id: "count",
      order: 40,
      payload: {
        label: "Count",
        handle() {
          state.heard += 1;
        },
      },
    });
  },
  exportState(ctx) {
    const state = ctx.kept() as Count | undefined;
    return { heard: typeof state?.heard === "number" ? state.heard : 0 };
  },
  importState(ctx, saved) {
    const state = ctx.kept() as Count | undefined;
    if (!state) return;
    const heard =
      saved && typeof saved === "object" && "heard" in saved ? (saved as { heard?: unknown }).heard : undefined;
    if (typeof heard !== "number" || !Number.isInteger(heard) || heard < 0) {
      throw new Error("Pulse count save is not a non-negative integer.");
    }
    state.heard = heard;
  },
};
