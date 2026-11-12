import type { CompositionResult, LifecycleContext } from "./host.ts";
import { FOUNDATIONS_API, moduleImplementation, moduleMemory } from "./host.ts";
import { parseSemVer } from "./semver.ts";

/**
 * A save document is a list of JSON slices. Each slice belongs to one module.
 * The host does not read the payload. It only checks that the Foundations API
 * major matches, and that the slice major matches the version the module declares.
 */

export type SaveSlice = {
  moduleId: string;
  version: string;
  payload: unknown;
};

export type SaveDocument = {
  foundationsApi: string;
  profileName: string;
  fingerprint: string;
  slices: SaveSlice[];
};

export type SaveNotice = {
  severity: "error" | "warning";
  code: string;
  message: string;
  moduleId?: string;
};

export type CaptureReport = {
  ok: boolean;
  document: SaveDocument;
  notices: SaveNotice[];
};

export type RestoreReport = {
  ok: boolean;
  applied: string[];
  notices: SaveNotice[];
};

const DOCUMENT_KEYS = new Set(["foundationsApi", "profileName", "fingerprint", "slices"]);
const SLICE_KEYS = new Set(["moduleId", "version", "payload"]);

function notice(severity: SaveNotice["severity"], code: string, message: string, moduleId?: string): SaveNotice {
  return { severity, code, message, moduleId };
}

function emptyDocument(result: CompositionResult): SaveDocument {
  return {
    foundationsApi: result.foundationsApi,
    profileName: result.profileName,
    fingerprint: result.fingerprint,
    slices: [],
  };
}

function blocked(result: CompositionResult): string | undefined {
  if (result.quiesced) return "Runtime has shut down.";
  if (!result.runtimeActive) return "Runtime is not active.";
  return undefined;
}

function life(result: CompositionResult, moduleId: string): LifecycleContext {
  return {
    moduleId,
    ownedSlot(slotId) {
      const slot = result.slots.find((item) => item.slotId === slotId);
      if (!slot || slot.ownerId !== moduleId) return undefined;
      return result.contributions.filter((item) => item.slotId === slotId);
    },
    kept: () => moduleMemory(result, moduleId),
  };
}

function jsonClone(value: unknown): { ok: true; value: unknown } | { ok: false } {
  if (value === undefined) return { ok: false };
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return { ok: false };
    return { ok: true, value: JSON.parse(encoded) as unknown };
  } catch {
    return { ok: false };
  }
}

function sameMajor(left: string, right: string): boolean {
  const a = parseSemVer(left);
  const b = parseSemVer(right);
  return a !== null && b !== null && a.major === b.major;
}

export function captureSave(result: CompositionResult): CaptureReport {
  const reason = blocked(result);
  const document = emptyDocument(result);
  if (reason) return { ok: false, document, notices: [notice("error", "save.inactive", reason)] };

  const notices: SaveNotice[] = [];
  for (const moduleId of result.order) {
    const module = result.modules.find((item) => item.moduleId === moduleId);
    const version = module?.save?.version;
    if (!module || module.status !== "active" || !version) continue;
    const implementation = moduleImplementation(result, moduleId);
    if (!implementation?.exportState) {
      notices.push(
        notice(
          "error",
          "save.no-export",
          `Module "${moduleId}" declares save ${version} but has no exportState.`,
          moduleId,
        ),
      );
      continue;
    }
    let payload: unknown;
    try {
      payload = implementation.exportState(life(result, moduleId));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "exportState threw a non-error value.";
      notices.push(notice("error", "save.threw", message, moduleId));
      continue;
    }
    const cloned = jsonClone(payload);
    if (!cloned.ok) {
      notices.push(
        notice("error", "save.not-json", `Module "${moduleId}" returned a value that is not JSON.`, moduleId),
      );
      continue;
    }
    document.slices.push({ moduleId, version, payload: cloned.value });
  }
  return { ok: notices.every((item) => item.severity !== "error"), document, notices };
}

export function restoreSave(result: CompositionResult, document: unknown): RestoreReport {
  const reason = blocked(result);
  if (reason) return { ok: false, applied: [], notices: [notice("error", "save.inactive", reason)] };
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return { ok: false, applied: [], notices: [notice("error", "save.document", "Save document is not an object.")] };
  }
  const record = document as Record<string, unknown>;
  const notices: SaveNotice[] = [];
  for (const key of Object.keys(record)) {
    if (!DOCUMENT_KEYS.has(key)) {
      notices.push(notice("error", "save.document", `Unknown save document field "${key}".`));
    }
  }
  if (notices.some((item) => item.severity === "error")) return { ok: false, applied: [], notices };

  const api = typeof record.foundationsApi === "string" ? record.foundationsApi : "";
  if (!sameMajor(api, FOUNDATIONS_API)) {
    return {
      ok: false,
      applied: [],
      notices: [
        notice(
          "error",
          "save.api",
          `Foundations API ${api || "missing"} cannot be restored onto host ${FOUNDATIONS_API}.`,
        ),
      ],
    };
  }
  if (typeof record.profileName === "string" && record.profileName !== result.profileName) {
    notices.push(
      notice(
        "warning",
        "save.profile",
        `Document was captured from profile "${record.profileName}". This runtime is "${result.profileName}".`,
      ),
    );
  }
  if (typeof record.fingerprint === "string" && record.fingerprint !== result.fingerprint) {
    notices.push(
      notice(
        "warning",
        "save.fingerprint",
        "Document fingerprint does not match this composition. Slices are still matched by module id.",
      ),
    );
  }
  if (!Array.isArray(record.slices)) {
    return { ok: false, applied: [], notices: [notice("error", "save.document", "Save document slices must be an array.")] };
  }

  const slices: SaveSlice[] = [];
  for (const item of record.slices) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      notices.push(notice("error", "save.document", "A save slice is not an object."));
      continue;
    }
    const row = item as Record<string, unknown>;
    const unknown = Object.keys(row).filter((key) => !SLICE_KEYS.has(key));
    if (unknown.length > 0) {
      notices.push(notice("error", "save.document", `Unknown save slice field "${unknown[0]}".`));
      continue;
    }
    if (typeof row.moduleId !== "string" || typeof row.version !== "string" || !("payload" in row)) {
      notices.push(notice("error", "save.document", "A save slice needs moduleId, version, and payload."));
      continue;
    }
    slices.push({ moduleId: row.moduleId, version: row.version, payload: row.payload });
  }

  const counts = new Map<string, number>();
  for (const slice of slices) counts.set(slice.moduleId, (counts.get(slice.moduleId) ?? 0) + 1);
  const byId = new Map<string, SaveSlice>();
  for (const slice of slices) {
    if ((counts.get(slice.moduleId) ?? 0) === 1) byId.set(slice.moduleId, slice);
  }
  const applied: string[] = [];
  for (const moduleId of result.order) {
    const module = result.modules.find((item) => item.moduleId === moduleId);
    if (!module || module.status !== "active" || !module.save) continue;
    if ((counts.get(moduleId) ?? 0) > 1) {
      notices.push(
        notice(
          "error",
          "save.duplicate",
          `Save document has more than one slice for "${moduleId}". The host will not pick one.`,
          moduleId,
        ),
      );
      continue;
    }
    const slice = byId.get(moduleId);
    if (!slice) {
      notices.push(
        notice(
          "warning",
          "save.absent",
          `Module "${moduleId}" has no saved slice. Its current state was left in place.`,
          moduleId,
        ),
      );
      continue;
    }
    if (!sameMajor(slice.version, module.save.version)) {
      notices.push(
        notice(
          "error",
          "save.incompatible",
          `Slice for "${moduleId}" is save version ${slice.version}, which is not the same major as ${module.save.version}.`,
          moduleId,
        ),
      );
      continue;
    }
    const implementation = moduleImplementation(result, moduleId);
    if (!implementation?.importState) {
      notices.push(
        notice("error", "save.no-import", `Module "${moduleId}" declares a save but has no importState.`, moduleId),
      );
      continue;
    }
    try {
      implementation.importState(life(result, moduleId), slice.payload);
      applied.push(moduleId);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "importState threw a non-error value.";
      notices.push(notice("error", "save.threw", message, moduleId));
    }
  }

  for (const slice of slices) {
    const module = result.modules.find((item) => item.moduleId === slice.moduleId);
    if (!module || module.status !== "active") {
      notices.push(
        notice(
          "warning",
          "save.orphan",
          `Slice for "${slice.moduleId}" names a module that is not active. It was left unread.`,
          slice.moduleId,
        ),
      );
    }
  }

  return { ok: notices.every((item) => item.severity !== "error"), applied, notices };
}
