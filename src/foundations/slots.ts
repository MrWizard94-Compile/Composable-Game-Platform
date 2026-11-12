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
 * Subscriber and pipeline slots store contributions in order. They run only when
 * a caller uses publish() or runPipeline(). There is still no frame loop.
 */
export const SLOT_KIND_SUMMARY: Record<SlotKind, string> = {
  singleton: "Exactly one provider. Two or more is a conflict. The host does not choose.",
  policy: "A replaceable rule set. Same cardinality as a singleton: one provider, or it is refused.",
  registry: "Any number of contributions. Order is (order, module id, contribution id).",
  pipeline:
    "Every contribution is kept, in (order, module id, contribution id). runPipeline folds a value through each handle and stops at the first failure.",
  subscriber:
    "Every contribution is kept, in the same order. publish fans one event out to each handle. A throw does not stop the rest. Nothing runs until a caller asks.",
  service:
    "Zero or one provider. More than one is ambiguous and refused. callService invokes the one provider and returns its value, including undefined.",
};

export function isSlotKind(value: unknown): value is SlotKind {
  return typeof value === "string" && (SLOT_KINDS as readonly string[]).includes(value);
}

const CALLABLE: ReadonlySet<SlotKind> = new Set(["subscriber", "pipeline", "service"]);
const EXCLUSIVE: ReadonlySet<SlotKind> = new Set(["singleton", "policy", "service"]);

export function slotRequiresCallable(kind: SlotKind): boolean {
  return CALLABLE.has(kind);
}

/** A dispatch payload is a function, or an object whose `handle` is a function. */
export function isCallablePayload(payload: unknown): boolean {
  if (typeof payload === "function") return true;
  if (payload && typeof payload === "object" && "handle" in payload) {
    return typeof (payload as { handle?: unknown }).handle === "function";
  }
  return false;
}

export function isExclusiveSlot(kind: SlotKind): boolean {
  return EXCLUSIVE.has(kind);
}
