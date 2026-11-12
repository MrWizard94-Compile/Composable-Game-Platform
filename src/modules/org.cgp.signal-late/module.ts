import type { ModuleImplementation } from "../../foundations/host.ts";

function heardOf(event: unknown): string[] | undefined {
  if (!event || typeof event !== "object" || !("heard" in event)) return undefined;
  const heard = (event as { heard?: unknown }).heard;
  return Array.isArray(heard) ? (heard as string[]) : undefined;
}

export const implementation: ModuleImplementation = {
  register(ctx) {
    ctx.contribute("signals.listeners", {
      id: "late",
      order: 30,
      payload: {
        label: "Late",
        handle(event: unknown) {
          heardOf(event)?.push("late");
        },
      },
    });
  },
};
