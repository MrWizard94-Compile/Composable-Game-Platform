import type { Diagnostic } from "./diagnostics.ts";
import { FOUNDATIONS_API, type CompositionResult, type ModulePackage } from "./host.ts";
import { isDisplayName, isModuleId, validateManifest } from "./manifest.ts";
import { formatSemVer, parseSemVer } from "./semver.ts";

/**
 * A profile pins module ids and exact versions. It does not load code.
 * resolveProfile picks those packages from a catalog and refuses the set
 * if any pin is missing or the packaged version differs. It does not upgrade.
 */

export type ProfileModule = {
  moduleId: string;
  version: string;
};

export type CompositionProfile = {
  profileId: string;
  name: string;
  description?: string;
  modules: ProfileModule[];
};

export type ProfileValidation =
  | { ok: true; profile: CompositionProfile }
  | { ok: false; errors: Diagnostic[] };

export type ProfileResolve =
  | { ok: true; packages: ModulePackage[] }
  | { ok: false; errors: Diagnostic[] };

const PROFILE_KEYS = new Set(["profileId", "name", "description", "modules"]);
const MODULE_KEYS = new Set(["moduleId", "version"]);

function error(code: string, message: string, path?: string, moduleId?: string): Diagnostic {
  return { severity: "error", code, message, phase: "validate", path, moduleId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactVersion(value: string): boolean {
  const parsed = parseSemVer(value);
  return parsed !== null && formatSemVer(parsed) === value;
}

export function validateProfile(input: unknown): ProfileValidation {
  if (!isRecord(input)) {
    return { ok: false, errors: [error("profile.not-object", "Profile must be a JSON object.")] };
  }
  const errors: Diagnostic[] = [];
  for (const key of Object.keys(input)) {
    if (!PROFILE_KEYS.has(key)) errors.push(error("profile.field", `Unknown profile field "${key}".`, key));
  }

  const profileId = input.profileId;
  if (typeof profileId !== "string" || !isModuleId(profileId)) {
    errors.push(error("profile.field", "profileId must be a dotted lowercase id.", "profileId"));
  }
  const name = input.name;
  if (typeof name !== "string" || !isDisplayName(name)) {
    errors.push(error("profile.field", "name must be a short display name.", "name"));
  }
  if (input.description !== undefined && (typeof input.description !== "string" || !isDisplayName(input.description))) {
    errors.push(error("profile.field", "description must be a short display name.", "description"));
  }
  if (!Array.isArray(input.modules)) {
    errors.push(error("profile.field", "modules must be an array.", "modules"));
    return { ok: false, errors };
  }

  const modules: ProfileModule[] = [];
  const seen = new Set<string>();
  input.modules.forEach((item, index) => {
    const path = `modules[${index}]`;
    if (!isRecord(item)) {
      errors.push(error("profile.field", "A profile module must be an object.", path));
      return;
    }
    for (const key of Object.keys(item)) {
      if (!MODULE_KEYS.has(key)) errors.push(error("profile.field", `Unknown profile module field "${key}".`, `${path}.${key}`));
    }
    const moduleId = item.moduleId;
    const version = item.version;
    if (typeof moduleId !== "string" || !isModuleId(moduleId)) {
      errors.push(error("profile.field", "moduleId must be a dotted lowercase id.", `${path}.moduleId`));
      return;
    }
    if (seen.has(moduleId)) {
      errors.push(error("profile.duplicate", `Module "${moduleId}" is listed more than once.`, path, moduleId));
    }
    seen.add(moduleId);
    if (typeof version !== "string" || !exactVersion(version)) {
      errors.push(
        error("profile.field", `Version for "${moduleId}" must be an exact major.minor.patch.`, `${path}.version`, moduleId),
      );
      return;
    }
    modules.push({ moduleId, version });
  });

  if (errors.length > 0 || typeof profileId !== "string" || typeof name !== "string") {
    return { ok: false, errors };
  }
  const profile: CompositionProfile = { profileId, name, modules };
  if (typeof input.description === "string") profile.description = input.description;
  return { ok: true, profile };
}

function declaredId(manifest: unknown): string | undefined {
  if (!isRecord(manifest)) return undefined;
  return typeof manifest.moduleId === "string" ? manifest.moduleId : undefined;
}

export function resolveProfile(profile: CompositionProfile, available: readonly ModulePackage[]): ProfileResolve {
  const groups = new Map<string, ModulePackage[]>();
  for (const pkg of available) {
    const id = declaredId(pkg.manifest);
    if (!id) continue;
    const list = groups.get(id) ?? [];
    list.push(pkg);
    groups.set(id, list);
  }

  const errors: Diagnostic[] = [];
  const packages: ModulePackage[] = [];
  for (const pin of profile.modules) {
    const found = groups.get(pin.moduleId) ?? [];
    if (found.length === 0) {
      errors.push(error("profile.missing", `Profile "${profile.profileId}" asks for "${pin.moduleId}", which is not available.`, undefined, pin.moduleId));
      continue;
    }
    if (found.length > 1) {
      errors.push(
        error(
          "profile.duplicate-package",
          `More than one package is named "${pin.moduleId}". The profile will not pick one.`,
          undefined,
          pin.moduleId,
        ),
      );
      continue;
    }
    const pkg = found[0];
    if (!pkg) continue;
    const checked = validateManifest(pkg.manifest);
    if (!checked.ok) {
      errors.push(
        error("profile.invalid-package", `Package "${pin.moduleId}" does not have a valid manifest.`, undefined, pin.moduleId),
      );
      continue;
    }
    if (checked.manifest.version !== pin.version) {
      errors.push(
        error(
          "profile.version",
          `Profile "${profile.profileId}" pins "${pin.moduleId}" at ${pin.version}. The package is ${checked.manifest.version}.`,
          undefined,
          pin.moduleId,
        ),
      );
      continue;
    }
    packages.push(pkg);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, packages };
}

/** A refused profile. Nothing is registered, and an empty compose is not used as a stand-in. */
export function unresolvedProfile(profileName: string, errors: readonly Diagnostic[]): CompositionResult {
  return {
    profileName,
    foundationsApi: FOUNDATIONS_API,
    trust: "trusted-in-process",
    ok: false,
    runtimeActive: false,
    quiesced: false,
    phases: [
      {
        phase: "validate",
        status: "failed",
        detail: errors[0]?.message ?? "Profile did not resolve.",
      },
    ],
    diagnostics: [...errors],
    modules: [],
    slots: [],
    order: [],
    dependencies: [],
    fingerprint: "unresolved",
    contributions: [],
    trace: [],
    shutdown: () => ({ already: true, order: [], diagnostics: [] }),
  };
}
