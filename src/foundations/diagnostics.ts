export const PHASES = [
  "discover",
  "validate",
  "resolve",
  "prepare",
  "register",
  "initialize",
  "run",
  "quiesce",
  "shutdown",
] as const;

export type PhaseName = (typeof PHASES)[number];

export type Diagnostic = {
  severity: "error" | "warning";
  code: string;
  message: string;
  phase: PhaseName;
  moduleId?: string;
  /** Every module this diagnostic indicts. */
  moduleIds?: string[];
  slotId?: string;
  path?: string;
};

export type PhaseRecord = {
  phase: PhaseName;
  status: "completed" | "failed" | "skipped";
  detail: string;
};

export function indicted(diagnostic: Diagnostic): string[] {
  const ids = new Set<string>();
  if (diagnostic.moduleId) ids.add(diagnostic.moduleId);
  for (const id of diagnostic.moduleIds ?? []) ids.add(id);
  return [...ids];
}
