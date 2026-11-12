export const SLOT_KINDS = [
  "singleton",
  "registry",
  "pipeline",
  "subscriber",
  "service",
  "policy",
] as const;

export type SlotKind = (typeof SLOT_KINDS)[number];

/**
 * Resolution rules are part of the slot type. None of them pick a winner silently.
 * Subscriber and pipeline contributions are stored and ordered; this milestone
 * does not dispatch an event bus or run a frame loop.
 */
export const SLOT_KIND_SUMMARY: Record<SlotKind, string> = {
  singleton: "Exactly one provider. Two or more is a conflict. The host does not choose.",
  policy: "A replaceable rule set. Same cardinality as a singleton: one provider, or it is refused.",
  registry: "Any number of contributions. Order is (order, module id, contribution id).",
  pipeline: "Every contribution is kept. Order is (order, module id, contribution id). Equal order is a tie-break, not a conflict.",
  subscriber: "Every contribution is kept, in registry order. No event fan-out is executed in this milestone.",
  service: "Zero or one provider. More than one is ambiguous and refused. There is no default pick.",
};

export function isSlotKind(value: unknown): value is SlotKind {
  return typeof value === "string" && (SLOT_KINDS as readonly string[]).includes(value);
}

const EXCLUSIVE: ReadonlySet<SlotKind> = new Set(["singleton", "policy", "service"]);

export function isExclusiveSlot(kind: SlotKind): boolean {
  return EXCLUSIVE.has(kind);
}
