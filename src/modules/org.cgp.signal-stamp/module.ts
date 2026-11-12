import type { ModuleImplementation } from "../../foundations/host.ts";

function heardOf(event: unknown): string[] | undefined {
  if (!event || typeof event !== "object" || !("heard" in event)) return undefined;
  const heard = (event as { heard?: unknown }).heard;
  return Array.isArray(heard) ? (heard as string[]) : undefined;
}

export const implementation: ModuleImplementation = {
  register(ctx) {
    ctx.contribute("signals.listeners", {
      id: "stamp",
      order: 10,
      payload: {
        label: "Stamp",
        handle(event: unknown) {
          heardOf(event)?.push("stamp");
        },
      },
    });
  },
};
