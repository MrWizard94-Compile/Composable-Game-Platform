import type { Diagnostic } from "./diagnostics.ts";
import { parseContractRef, parseSemVer, isValidRange } from "./semver.ts";
import { isSlotKind, type SlotKind } from "./slots.ts";

const MODULE_ID_RE = /^[a-z][a-z0-9]*(?:\.[a-z0-9][a-z0-9-]*)+$/;
const NAME_RE = /^[\w][\w .,'’()/-]{0,80}$/u;

export function isModuleId(value: string): boolean {
  return MODULE_ID_RE.test(value);
}

export function isDisplayName(value: string): boolean {
  return NAME_RE.test(value);
}

export type CapabilityRequire = {
  capability: string;
  version: string;
  optional: boolean;
  moduleId?: string;
};

export type CapabilityProvide = {
  capability: string;
  version: string;
};

export type SlotConnectionDecl = {
  slot: string;
  contract: string;
};

export type SlotExposeDecl = {
  slotId: string;
  contract: string;
  contractVersion: string;
  kind: SlotKind;
  description?: string;
  required: boolean;
};

export type SaveDecl = {
  version: string;
};

export type ModuleManifest = {
  moduleId: string;
  name: string;
  description?: string;
  version: string;
  moduleApi: string;
  requires: CapabilityRequire[];
  provides: CapabilityProvide[];
  connectsTo: SlotConnectionDecl[];
  exposesSlots: SlotExposeDecl[];
  permissions: string[];
  /** Present only when this module owns a save slice. */
  save?: SaveDecl;
  author?: string;
  license?: string;
};

const MANIFEST_KEYS = new Set([
  "moduleId",
  "name",
  "description",
  "version",
  "moduleApi",
  "requires",
  "provides",
  "connectsTo",
  "exposesSlots",
  "permissions",
  "save",
  "author",
  "license",
]);

export type ManifestValidation =
  | { ok: true; manifest: ModuleManifest }
  | { ok: false; errors: Diagnostic[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldError(path: string, message: string, moduleId?: string): Diagnostic {
  return {
    severity: "error",
    code: "manifest.field",
    message,
    phase: "validate",
    path,
    moduleId,
  };
}

export function validateManifest(input: unknown): ManifestValidation {
  const errors: Diagnostic[] = [];
  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [
        {
          severity: "error",
          code: "manifest.not-object",
          message: "Manifest must be a JSON object.",
          phase: "validate",
        },
      ],
    };
  }

  const hintedId = typeof input.moduleId === "string" ? input.moduleId : undefined;

  for (const key of Object.keys(input)) {
    if (!MANIFEST_KEYS.has(key)) {
      errors.push(fieldError(key, `Unknown manifest field "${key}".`, hintedId));
    }
  }

  const moduleId = readModuleId(input.moduleId, errors);
  const name = readName(input.name, errors, moduleId);
  const version = readExactVersion(input.version, "version", errors, moduleId);
  const moduleApi = readRange(input.moduleApi, "moduleApi", errors, moduleId);
  const description = readOptionalString(input.description, "description", errors, moduleId);
  const author = readOptionalString(input.author, "author", errors, moduleId);
  const license = readOptionalString(input.license, "license", errors, moduleId);
  const requires = readRequires(input.requires, errors, moduleId);
  const provides = readProvides(input.provides, errors, moduleId);
  const connectsTo = readConnections(input.connectsTo, errors, moduleId);
  const exposesSlots = readSlots(input.exposesSlots, errors, moduleId);
  const permissions = readPermissions(input.permissions, errors, moduleId);
  const save = readSave(input.save, errors, moduleId);

  if (
    errors.length > 0 ||
    !moduleId ||
    !name ||
    !version ||
    !moduleApi ||
    !requires ||
    !provides ||
    !connectsTo ||
    !exposesSlots ||
    !permissions
  ) {
    return { ok: false, errors };
  }

  const seenProvides = new Set<string>();
  for (const cap of provides) {
    if (seenProvides.has(cap.capability)) {
      errors.push(
        fieldError(
          "provides",
          `Capability "${cap.capability}" is provided more than once.`,
          moduleId,
        ),
      );
    }
    seenProvides.add(cap.capability);
  }

  const seenSlots = new Set<string>();
  for (const slot of exposesSlots) {
    if (seenSlots.has(slot.slotId)) {
      errors.push(fieldError("exposesSlots", `Slot "${slot.slotId}" is exposed more than once.`, moduleId));
    }
    seenSlots.add(slot.slotId);
  }

  const seenConnections = new Set<string>();
  for (const connection of connectsTo) {
    if (seenConnections.has(connection.slot)) {
      errors.push(
        fieldError("connectsTo", `Slot "${connection.slot}" is connected more than once.`, moduleId),
      );
    }
    seenConnections.add(connection.slot);
    if (seenSlots.has(connection.slot)) {
      errors.push({
        severity: "error",
        code: "slot.self-connection",
        message: `Module "${moduleId}" cannot connect to slot "${connection.slot}" that it owns.`,
        phase: "validate",
        moduleId,
        slotId: connection.slot,
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    manifest: {
      moduleId,
      name,
      description,
      version,
      moduleApi,
      requires,
      provides,
      connectsTo,
      exposesSlots,
      permissions,
      save,
      author,
      license,
    },
  };
}

function readModuleId(value: unknown, errors: Diagnostic[]): string | undefined {
  if (typeof value !== "string" || !MODULE_ID_RE.test(value)) {
    errors.push(
      fieldError(
        "moduleId",
        "moduleId must look like org.example.module-name (lowercase, at least two segments).",
        typeof value === "string" ? value : undefined,
      ),
    );
    return undefined;
  }
  return value;
}

function readName(value: unknown, errors: Diagnostic[], moduleId?: string): string | undefined {
  if (typeof value !== "string" || !NAME_RE.test(value)) {
    errors.push(fieldError("name", "name must be a short human-readable string.", moduleId));
    return undefined;
  }
  return value;
}

function readExactVersion(
  value: unknown,
  path: string,
  errors: Diagnostic[],
  moduleId?: string,
): string | undefined {
  if (typeof value !== "string" || !parseSemVer(value)) {
    errors.push(
      fieldError(path, `${path} must be an exact semantic version such as 1.2.0.`, moduleId),
    );
    return undefined;
  }
  return value;
}

function readRange(
  value: unknown,
  path: string,
  errors: Diagnostic[],
  moduleId?: string,
): string | undefined {
  if (typeof value !== "string" || !isValidRange(value)) {
    errors.push(
      fieldError(
        path,
        `${path} must be a version range such as ">=1.0.0 <2.0.0", ^1.0.0, or 1.0.0.`,
        moduleId,
      ),
    );
    return undefined;
  }
  return value;
}

function readSave(value: unknown, errors: Diagnostic[], moduleId?: string): SaveDecl | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    errors.push(fieldError("save", "save must be an object with an exact version.", moduleId));
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (key !== "version") errors.push(fieldError(`save.${key}`, `Unknown save field "${key}".`, moduleId));
  }
  const version = readExactVersion(value.version, "save.version", errors, moduleId);
  if (!version) return undefined;
  return { version };
}

function readOptionalString(
  value: unknown,
  path: string,
  errors: Diagnostic[],
  moduleId?: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "" || value.length > 400) {
    errors.push(fieldError(path, `${path} must be a non-empty string under 400 characters.`, moduleId));
    return undefined;
  }
  return value;
}

function readRequires(
  value: unknown,
  errors: Diagnostic[],
  moduleId?: string,
): CapabilityRequire[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(fieldError("requires", "requires must be an array.", moduleId));
    return undefined;
  }
  const out: CapabilityRequire[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    const path = `requires[${i}]`;
    if (!isRecord(item)) {
      errors.push(fieldError(path, "A requirement must be an object.", moduleId));
      continue;
    }
    for (const key of Object.keys(item)) {
      if (!["capability", "version", "optional", "moduleId"].includes(key)) {
        errors.push(fieldError(`${path}.${key}`, `Unknown requirement field "${key}".`, moduleId));
      }
    }
    const capability = readId(item.capability, `${path}.capability`, errors, moduleId);
    const version = readRange(item.version, `${path}.version`, errors, moduleId);
    let optional = false;
    if (item.optional !== undefined) {
      if (typeof item.optional !== "boolean") {
        errors.push(fieldError(`${path}.optional`, "optional must be a boolean.", moduleId));
      } else {
        optional = item.optional;
      }
    }
    let requiredModule: string | undefined;
    if (item.moduleId !== undefined) {
      requiredModule = readId(item.moduleId, `${path}.moduleId`, errors, moduleId);
    }
    if (capability && version) {
      out.push({ capability, version, optional, moduleId: requiredModule });
    }
  }
  return out;
}

function readProvides(
  value: unknown,
  errors: Diagnostic[],
  moduleId?: string,
): CapabilityProvide[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(fieldError("provides", "provides must be an array.", moduleId));
    return undefined;
  }
  const out: CapabilityProvide[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    const path = `provides[${i}]`;
    if (!isRecord(item)) {
      errors.push(fieldError(path, "A provided capability must be an object.", moduleId));
      continue;
    }
    for (const key of Object.keys(item)) {
      if (!["capability", "version"].includes(key)) {
        errors.push(fieldError(`${path}.${key}`, `Unknown provides field "${key}".`, moduleId));
      }
    }
    const capability = readId(item.capability, `${path}.capability`, errors, moduleId);
    const version = readExactVersion(item.version, `${path}.version`, errors, moduleId);
    if (capability && version) out.push({ capability, version });
  }
  return out;
}

function readConnections(
  value: unknown,
  errors: Diagnostic[],
  moduleId?: string,
): SlotConnectionDecl[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(fieldError("connectsTo", "connectsTo must be an array.", moduleId));
    return undefined;
  }
  const out: SlotConnectionDecl[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    const path = `connectsTo[${i}]`;
    if (!isRecord(item)) {
      errors.push(fieldError(path, "A slot connection must be an object.", moduleId));
      continue;
    }
    for (const key of Object.keys(item)) {
      if (!["slot", "contract"].includes(key)) {
        errors.push(fieldError(`${path}.${key}`, `Unknown connection field "${key}".`, moduleId));
      }
    }
    const slot = readId(item.slot, `${path}.slot`, errors, moduleId);
    if (typeof item.contract !== "string" || !parseContractRef(item.contract)) {
      errors.push(
        fieldError(
          `${path}.contract`,
          'contract must look like "some.contract/1" or "some.contract/1.0.0".',
          moduleId,
        ),
      );
    } else if (slot) {
      out.push({ slot, contract: item.contract });
    }
  }
  return out;
}

function readSlots(
  value: unknown,
  errors: Diagnostic[],
  moduleId?: string,
): SlotExposeDecl[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(fieldError("exposesSlots", "exposesSlots must be an array.", moduleId));
    return undefined;
  }
  const out: SlotExposeDecl[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    const path = `exposesSlots[${i}]`;
    if (!isRecord(item)) {
      errors.push(fieldError(path, "A slot declaration must be an object.", moduleId));
      continue;
    }
    for (const key of Object.keys(item)) {
      if (!["slotId", "contract", "contractVersion", "kind", "description", "required"].includes(key)) {
        errors.push(fieldError(`${path}.${key}`, `Unknown slot field "${key}".`, moduleId));
      }
    }
    const slotId = readId(item.slotId, `${path}.slotId`, errors, moduleId);
    const contract = readId(item.contract, `${path}.contract`, errors, moduleId);
    const contractVersion = readExactVersion(
      item.contractVersion,
      `${path}.contractVersion`,
      errors,
      moduleId,
    );
    if (!isSlotKind(item.kind)) {
      errors.push(
        fieldError(
          `${path}.kind`,
          "kind must be singleton, registry, pipeline, subscriber, service, or policy.",
          moduleId,
        ),
      );
    }
    const description = readOptionalString(item.description, `${path}.description`, errors, moduleId);
    let required = false;
    if (item.required !== undefined) {
      if (typeof item.required !== "boolean") {
        errors.push(fieldError(`${path}.required`, "required must be a boolean.", moduleId));
      } else {
        required = item.required;
      }
    }
    if (slotId && contract && contractVersion && isSlotKind(item.kind)) {
      out.push({
        slotId,
        contract,
        contractVersion,
        kind: item.kind,
        description,
        required,
      });
    }
  }
  return out;
}

function readPermissions(
  value: unknown,
  errors: Diagnostic[],
  moduleId?: string,
): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(fieldError("permissions", "permissions must be an array of identifiers.", moduleId));
    return undefined;
  }
  const out: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const id = readId(value[i], `permissions[${i}]`, errors, moduleId);
    if (id) out.push(id);
  }
  return out;
}

function readId(value: unknown, path: string, errors: Diagnostic[], moduleId?: string): string | undefined {
  if (typeof value !== "string" || !MODULE_ID_RE.test(value)) {
    errors.push(
      fieldError(path, `${path} must be a dotted identifier such as example.core.`, moduleId),
    );
    return undefined;
  }
  return value;
}
