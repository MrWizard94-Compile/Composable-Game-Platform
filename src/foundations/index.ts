export {
  FOUNDATIONS_API,
  MAX_SLOT_DEPTH,
  PLATFORM_OWNER,
  PLATFORM_SLOTS,
  compose,
  contributionsFor,
  moduleStatus,
} from "./host.ts";
export type {
  ComposeOptions,
  CompositionResult,
  ContributionRecord,
  LifecycleContext,
  ModuleImplementation,
  ModulePackage,
  ModuleStatus,
  RegisterContext,
  ResolvedModule,
  ResolvedSlot,
  ShutdownReport,
  SlotStatus,
} from "./host.ts";
export { validateManifest } from "./manifest.ts";
export type { ModuleManifest } from "./manifest.ts";
export { SLOT_KIND_SUMMARY, SLOT_KINDS } from "./slots.ts";
export type { SlotKind } from "./slots.ts";
export { satisfies, parseSemVer, isValidRange } from "./semver.ts";
export type { Diagnostic, PhaseName, PhaseRecord } from "./diagnostics.ts";
