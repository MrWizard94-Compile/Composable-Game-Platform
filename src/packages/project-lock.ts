import { createHash } from "node:crypto";
import { isModuleId, type ModuleManifest } from "../foundations/manifest.ts";
import { formatSemVer, parseSemVer } from "../foundations/semver.ts";
import { validateProfile, type CompositionProfile } from "../foundations/profile.ts";
import {
  validatePackagePaths,
  type PackageFile,
} from "./package-format.ts";
import {
  snapshotReleasePackageDirectory,
  snapshotWasmReleasePackageDirectory,
} from "./package-directory.ts";
import {
  localPackageObjectDirectory,
  readLocalCatalog,
  withLocalStoreReadLock,
  resolveLocalPackage,
  setProjectRetentionPin,
  removeProjectRetentionPin,
  type LocalCatalogEntry,
} from "./local-store.ts";

export type ProjectLock = {
  schema: "cgp.project-lock/1";
  profileId: string;
  profileDigest: string;
  /** Kept in profile order because composition input order is meaningful. */
  modules: LocalCatalogEntry[];
};

export type ResolvedProjectModule = {
  entry: LocalCatalogEntry;
  objectDirectory: string;
};

export type ResolvedProjectLock = {
  lock: ProjectLock;
  modules: ResolvedProjectModule[];
};

export type ProjectLockValidation =
  | { ok: true; lock: ProjectLock }
  | { ok: false; errors: string[] };

const LOCK_SCHEMA = "cgp.project-lock/1";
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const LOCK_KEYS = ["modules", "profileDigest", "profileId", "schema"];
const ENTRY_KEYS = [
  "artifactDigest",
  "files",
  "moduleId",
  "packageTreeDigest",
  "packageTreeProfile",
  "runtime",
  "version",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (isRecord(value)) {
    return "{" + Object.keys(value).sort().map((key) =>
      JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

/**
 * The project identity covers only the profile id and ordered exact module pins.
 * Display name and description can change without invalidating package resolution.
 */
export function computeProjectProfileDigest(profile: CompositionProfile): string {
  const identity = {
    profileId: profile.profileId,
    modules: profile.modules.map(({ moduleId, version }) => ({ moduleId, version })),
  };
  return "sha256:" + createHash("sha256")
    .update("CGP-PROJECT-PROFILE\0v1", "utf8")
    .update(canonicalJson(identity), "utf8")
    .digest("hex");
}

function checkedProfile(input: unknown): CompositionProfile {
  const checked = validateProfile(input);
  if (!checked.ok) {
    throw new Error("Project profile validation failed: " +
      checked.errors.map((item) => item.message).join("; "));
  }
  return checked.profile;
}

function copyEntry(entry: LocalCatalogEntry): LocalCatalogEntry {
  return {
    moduleId: entry.moduleId,
    version: entry.version,
    packageTreeProfile: entry.packageTreeProfile,
    packageTreeDigest: entry.packageTreeDigest,
    artifactDigest: entry.artifactDigest,
    runtime: entry.runtime,
    files: [...entry.files],
  };
}

function sameEntry(a: LocalCatalogEntry, b: LocalCatalogEntry): boolean {
  return a.moduleId === b.moduleId &&
    a.version === b.version &&
    a.packageTreeProfile === b.packageTreeProfile &&
    a.packageTreeDigest === b.packageTreeDigest &&
    a.artifactDigest === b.artifactDigest &&
    a.runtime === b.runtime &&
    a.files.length === b.files.length &&
    a.files.every((path, index) => path === b.files[index]);
}

/** Validates the closed cgp.project-lock/1 schema without consulting a store. */
export function validateProjectLock(input: unknown): ProjectLockValidation {
  const errors: string[] = [];
  if (!isRecord(input) || !hasExactKeys(input, LOCK_KEYS) ||
      input.schema !== LOCK_SCHEMA || typeof input.profileId !== "string" ||
      !isModuleId(input.profileId) || typeof input.profileDigest !== "string" ||
      !DIGEST_RE.test(input.profileDigest) || !Array.isArray(input.modules)) {
    return {
      ok: false,
      errors: ["Lockfile must use the closed cgp.project-lock/1 schema."],
    };
  }

  const modules: LocalCatalogEntry[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < input.modules.length; index += 1) {
    const raw = input.modules[index];
    const label = "modules[" + index + "]";
    if (!isRecord(raw) || !hasExactKeys(raw, ENTRY_KEYS)) {
      errors.push(label + " has unknown or missing fields.");
      continue;
    }
    const parsedVersion = typeof raw.version === "string" ? parseSemVer(raw.version) : null;
    if (typeof raw.moduleId !== "string" || !isModuleId(raw.moduleId) ||
        !parsedVersion || formatSemVer(parsedVersion) !== raw.version ||
        raw.packageTreeProfile !== "cgp.package-tree/1" ||
        typeof raw.packageTreeDigest !== "string" || !DIGEST_RE.test(raw.packageTreeDigest) ||
        typeof raw.artifactDigest !== "string" || !DIGEST_RE.test(raw.artifactDigest) ||
        (raw.runtime !== "wasm-core" && raw.runtime !== "javascript-esm") ||
        !Array.isArray(raw.files) || raw.files.some((path) => typeof path !== "string")) {
      errors.push(label + " contains an invalid release identity.");
      continue;
    }
    const files = raw.files as string[];
    if (files.length === 0 || validatePackagePaths(files).length > 0 ||
        files.some((path, fileIndex) => fileIndex > 0 && files[fileIndex - 1]! >= path)) {
      errors.push(label + ".files must be non-empty, valid, unique, and ordinally sorted.");
      continue;
    }
    if (seen.has(raw.moduleId)) {
      errors.push("Lockfile contains more than one version of module " + raw.moduleId + ".");
      continue;
    }
    seen.add(raw.moduleId);
    modules.push({
      moduleId: raw.moduleId,
      version: raw.version as string,
      packageTreeProfile: "cgp.package-tree/1",
      packageTreeDigest: raw.packageTreeDigest as string,
      artifactDigest: raw.artifactDigest as string,
      runtime: raw.runtime,
      files: [...files],
    });
  }

  if (errors.length > 0 || modules.length !== input.modules.length) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    lock: {
      schema: LOCK_SCHEMA,
      profileId: input.profileId,
      profileDigest: input.profileDigest,
      modules,
    },
  };
}

/**
 * Creates a reproducible lock from exact profile pins and verified local objects.
 * This function never chooses a version or searches for a capability provider.
 */
export async function createProjectLock(
  storeDirectory: string,
  profileInput: unknown,
): Promise<ProjectLock> {
  const profile = checkedProfile(profileInput);
  const modules: LocalCatalogEntry[] = [];
  for (const pin of profile.modules) {
    const resolved = await resolveLocalPackage(storeDirectory, pin.moduleId, pin.version);
    if (!resolved) {
      throw new Error("Project profile requires " + pin.moduleId + "@" + pin.version +
        ", but that exact release is not registered in the local store.");
    }
    modules.push(copyEntry(resolved.entry));
  }
  return {
    schema: LOCK_SCHEMA,
    profileId: profile.profileId,
    profileDigest: computeProjectProfileDigest(profile),
    modules,
  };
}

/**
 * Resolves a lock only when the supplied profile, catalog entries, and stored bytes
 * all agree exactly. The returned paths are verified package directories, not loaded code.
 */
export async function resolveProjectLock(
  storeDirectory: string,
  profileInput: unknown,
  lockInput: unknown,
): Promise<ResolvedProjectLock> {
  const profile = checkedProfile(profileInput);
  const checkedLock = validateProjectLock(lockInput);
  if (!checkedLock.ok) {
    throw new Error("Project lock validation failed: " + checkedLock.errors.join("; "));
  }
  const lock = checkedLock.lock;
  const expectedProfileDigest = computeProjectProfileDigest(profile);
  if (lock.profileId !== profile.profileId || lock.profileDigest !== expectedProfileDigest) {
    throw new Error("Project profile does not match the profile identity recorded in the lockfile.");
  }
  if (lock.modules.length !== profile.modules.length) {
    throw new Error("Lockfile module set does not match the project profile.");
  }

  const catalog = readLocalCatalog(storeDirectory);
  const resolvedModules: ResolvedProjectModule[] = [];
  for (let index = 0; index < profile.modules.length; index += 1) {
    const pin = profile.modules[index]!;
    const locked = lock.modules[index]!;
    if (locked.moduleId !== pin.moduleId || locked.version !== pin.version) {
      throw new Error("Lockfile module order or exact version differs from the project profile at index " + index + ".");
    }
    const catalogEntry = catalog.entries.find((entry) =>
      entry.moduleId === locked.moduleId && entry.version === locked.version);
    if (!catalogEntry) {
      throw new Error("Locked release " + locked.moduleId + "@" + locked.version +
        " is not registered in the local catalog.");
    }
    if (!sameEntry(catalogEntry, locked)) {
      throw new Error("Local catalog identity differs from the lockfile for " +
        locked.moduleId + "@" + locked.version + ".");
    }
    const resolved = await resolveLocalPackage(storeDirectory, locked.moduleId, locked.version);
    if (!resolved) {
      throw new Error("Locked release disappeared while resolving: " + locked.moduleId + "@" + locked.version + ".");
    }
    if (!sameEntry(resolved.entry, locked)) {
      throw new Error("Verified stored package differs from the lockfile for " +
        locked.moduleId + "@" + locked.version + ".");
    }
    resolvedModules.push({ entry: copyEntry(resolved.entry), objectDirectory: resolved.objectDirectory });
  }
  return { lock, modules: resolvedModules };
}


function freezeSnapshotMetadata<T>(value: T): T {
  if (value === null || typeof value !== "object" ||
      ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  const record = value as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) freezeSnapshotMetadata(record[key]);
  return Object.freeze(value);
}

export type WasmProjectModuleSnapshot = {
  entry: LocalCatalogEntry;
  manifest: ModuleManifest;
  wasmBytes: Uint8Array;
  packageBytes: number;
};

export type WasmProjectSnapshot = {
  lock: ProjectLock;
  /** Preserves the exact module order recorded by the profile and lock. */
  modules: WasmProjectModuleSnapshot[];
  /** Sum of complete package-tree bytes scanned, including manifests and documentation. */
  totalBytes: number;
};

/**
 * Creates an all-or-nothing, Wasm-only in-memory snapshot from an exact project lock.
 *
 * Unlike resolveProjectLock(), this operation verifies catalog metadata and the actual
 * stored bytes in one package-directory scan per module. It never returns store paths,
 * imports JavaScript, instantiates Wasm, or invokes module hooks.
 *
 * maxTotalBytes is mandatory so callers choose an explicit project-wide snapshot budget.
 */
function validatedLockModules(
  storeDirectory: string,
  profileInput: unknown,
  lockInput: unknown,
  mode: "wasm-only" | "project",
): LocalCatalogEntry[] {
  const profile = checkedProfile(profileInput);
  const checkedLock = validateProjectLock(lockInput);
  if (!checkedLock.ok) {
    throw new Error("Project lock validation failed: " + checkedLock.errors.join("; "));
  }
  const lock = checkedLock.lock;
  const expectedProfileDigest = computeProjectProfileDigest(profile);
  if (lock.profileId !== profile.profileId || lock.profileDigest !== expectedProfileDigest) {
    throw new Error("Project profile does not match the profile identity recorded in the lockfile.");
  }
  if (lock.modules.length !== profile.modules.length) {
    throw new Error("Lockfile module set does not match the project profile.");
  }
  const catalog = readLocalCatalog(storeDirectory);
  const selected: LocalCatalogEntry[] = [];
  for (let index = 0; index < profile.modules.length; index += 1) {
    const pin = profile.modules[index]!;
    const locked = lock.modules[index]!;
    if (locked.moduleId !== pin.moduleId || locked.version !== pin.version) {
      throw new Error("Lockfile module order or exact version differs from the project profile at index " + index + ".");
    }
    if (mode === "wasm-only" && locked.runtime !== "wasm-core") {
      throw new Error(
        "Wasm-only project snapshot refuses " + locked.moduleId + "@" + locked.version +
        " because its runtime is " + locked.runtime + ".",
      );
    }
    if (locked.runtime !== "wasm-core" && locked.runtime !== "javascript-esm") {
      throw new Error(
        "Project activation refuses " + locked.moduleId + "@" + locked.version +
        " because its runtime is " + locked.runtime + ".",
      );
    }
    const catalogEntry = catalog.entries.find((entry) =>
      entry.moduleId === locked.moduleId && entry.version === locked.version);
    if (!catalogEntry) {
      throw new Error("Locked release " + locked.moduleId + "@" + locked.version +
        " is not registered in the local catalog.");
    }
    if (!sameEntry(catalogEntry, locked)) {
      throw new Error("Local catalog identity differs from the lockfile for " +
        locked.moduleId + "@" + locked.version + ".");
    }
    selected.push(copyEntry(locked));
  }
  return selected;
}

/** Package-tree digests for a Wasm-only lock, in profile order, before a composition lease or snapshot. */
export function wasmLockPackageDigests(
  storeDirectory: string,
  profileInput: unknown,
  lockInput: unknown,
): string[] {
  return validatedLockModules(storeDirectory, profileInput, lockInput, "wasm-only")
    .map((entry) => entry.packageTreeDigest);
}

/** Exact locked identities for a project activation, in profile order, before a lease or snapshot. */
export function projectLockModules(
  storeDirectory: string,
  profileInput: unknown,
  lockInput: unknown,
): LocalCatalogEntry[] {
  return validatedLockModules(storeDirectory, profileInput, lockInput, "project");
}

async function snapshotWasmProjectLockWithReadLockHeld(
  storeDirectory: string,
  profileInput: unknown,
  lockInput: unknown,
  maxTotalBytes: number,
): Promise<WasmProjectSnapshot> {
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes <= 0) {
    throw new Error("maxTotalBytes must be a positive safe integer.");
  }
  const checkedLock = validateProjectLock(lockInput);
  if (!checkedLock.ok) {
    throw new Error("Project lock validation failed: " + checkedLock.errors.join("; "));
  }
  const lock = checkedLock.lock;
  const selected = validatedLockModules(storeDirectory, profileInput, lockInput, "wasm-only").map((entry) => ({
    entry,
    objectDirectory: localPackageObjectDirectory(storeDirectory, entry.packageTreeDigest),
  }));

  const modules: WasmProjectModuleSnapshot[] = [];
  let totalBytes = 0;
  for (const item of selected) {
    const remaining = maxTotalBytes - totalBytes;
    if (remaining <= 0) {
      throw new Error("Project snapshot exceeds the configured aggregate byte limit of " + maxTotalBytes + " bytes.");
    }
    const result = await snapshotWasmReleasePackageDirectory(item.objectDirectory, remaining);
    if (!result.ok) {
      throw new Error("Wasm snapshot failed for " + item.entry.moduleId + "@" + item.entry.version +
        ": " + result.errors.join("; "));
    }
    const actual: LocalCatalogEntry = {
      moduleId: result.snapshot.package.moduleId,
      version: result.snapshot.package.version,
      packageTreeProfile: result.snapshot.package.packageTreeProfile,
      packageTreeDigest: result.snapshot.package.packageTreeDigest,
      artifactDigest: result.snapshot.package.artifactDigest,
      runtime: "wasm-core",
      files: [...result.snapshot.package.files],
    };
    if (!sameEntry(actual, item.entry)) {
      throw new Error("Stored package bytes differ from the exact lock identity for " +
        item.entry.moduleId + "@" + item.entry.version + ".");
    }
    if (result.snapshot.packageBytes > remaining) {
      throw new Error("Project snapshot exceeds the configured aggregate byte limit of " + maxTotalBytes + " bytes.");
    }
    modules.push({
      entry: copyEntry(item.entry),
      manifest: result.snapshot.manifest,
      wasmBytes: result.snapshot.wasmBytes,
      packageBytes: result.snapshot.packageBytes,
    });
    totalBytes += result.snapshot.packageBytes;
  }

  freezeSnapshotMetadata(lock);
  for (const module of modules) {
    freezeSnapshotMetadata(module.entry);
    Object.freeze(module);
  }
  Object.freeze(modules);
  return Object.freeze({ lock, modules, totalBytes });
}


/**
 * Holds a store reader marker while catalog metadata and every locked package tree
 * are verified and copied into owned memory. The marker is released only after the
 * complete all-or-nothing snapshot exists. This snapshot does not keep a store path.
 * Wasm activation holds a separate composition lease until shutdown.
 */
export async function snapshotWasmProjectLock(
  storeDirectory: string,
  profileInput: unknown,
  lockInput: unknown,
  maxTotalBytes: number,
): Promise<WasmProjectSnapshot> {
  return withLocalStoreReadLock(storeDirectory, () =>
    snapshotWasmProjectLockWithReadLockHeld(
      storeDirectory,
      profileInput,
      lockInput,
      maxTotalBytes,
    ),
  );
}

export type ProjectModuleSnapshot = {
  entry: LocalCatalogEntry;
  manifest: ModuleManifest;
  /** Owned runtime artifact from the verifying scan. Wasm bytes or module.mjs bytes. */
  artifactBytes: Uint8Array;
  packageBytes: number;
  /**
   * Every regular file hashed into this module's package-tree digest.
   * The buffers are the scanned buffers. `artifactBytes` is one of them.
   */
  files: readonly PackageFile[];
};

export type ProjectSnapshot = {
  lock: ProjectLock;
  modules: ProjectModuleSnapshot[];
  totalBytes: number;
};

async function snapshotProjectLockWithReadLockHeld(
  storeDirectory: string,
  profileInput: unknown,
  lockInput: unknown,
  maxTotalBytes: number,
): Promise<ProjectSnapshot> {
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes <= 0) {
    throw new Error("maxTotalBytes must be a positive safe integer.");
  }
  const checkedLock = validateProjectLock(lockInput);
  if (!checkedLock.ok) {
    throw new Error("Project lock validation failed: " + checkedLock.errors.join("; "));
  }
  const lock = checkedLock.lock;
  const selected = validatedLockModules(storeDirectory, profileInput, lockInput, "project").map((entry) => ({
    entry,
    objectDirectory: localPackageObjectDirectory(storeDirectory, entry.packageTreeDigest),
  }));
  const modules: ProjectModuleSnapshot[] = [];
  let totalBytes = 0;
  for (const item of selected) {
    const remaining = maxTotalBytes - totalBytes;
    if (remaining <= 0) {
      throw new Error("Project snapshot exceeds the configured aggregate byte limit of " + maxTotalBytes + " bytes.");
    }
    const result = await snapshotReleasePackageDirectory(item.objectDirectory, remaining);
    if (!result.ok) {
      throw new Error("Project snapshot failed for " + item.entry.moduleId + "@" + item.entry.version +
        ": " + result.errors.join("; "));
    }
    const actual: LocalCatalogEntry = {
      moduleId: result.snapshot.package.moduleId,
      version: result.snapshot.package.version,
      packageTreeProfile: result.snapshot.package.packageTreeProfile,
      packageTreeDigest: result.snapshot.package.packageTreeDigest,
      artifactDigest: result.snapshot.package.artifactDigest,
      runtime: result.snapshot.package.descriptor.runtime.kind,
      files: [...result.snapshot.package.files],
    };
    if (!sameEntry(actual, item.entry)) {
      throw new Error("Stored package bytes differ from the exact lock identity for " +
        item.entry.moduleId + "@" + item.entry.version + ".");
    }
    if (result.snapshot.packageBytes > remaining) {
      throw new Error("Project snapshot exceeds the configured aggregate byte limit of " + maxTotalBytes + " bytes.");
    }
    modules.push({
      entry: copyEntry(item.entry),
      manifest: result.snapshot.manifest,
      artifactBytes: result.snapshot.artifactBytes,
      packageBytes: result.snapshot.packageBytes,
      files: result.snapshot.files,
    });
    totalBytes += result.snapshot.packageBytes;
  }
  freezeSnapshotMetadata(lock);
  for (const module of modules) {
    freezeSnapshotMetadata(module.entry);
    Object.freeze(module);
  }
  Object.freeze(modules);
  return Object.freeze({ lock, modules, totalBytes });
}

/**
 * Verifies and copies every locked package before any JavaScript import or Wasm instantiation.
 * The reader marker ends when the owned snapshot exists. It does not keep a store path.
 */
export async function snapshotProjectLock(
  storeDirectory: string,
  profileInput: unknown,
  lockInput: unknown,
  maxTotalBytes: number,
): Promise<ProjectSnapshot> {
  return withLocalStoreReadLock(storeDirectory, () =>
    snapshotProjectLockWithReadLockHeld(storeDirectory, profileInput, lockInput, maxTotalBytes),
  );
}


/** Persist an exact validated project lock as a package-store retention root. */
export async function pinProjectLock(
  storeDirectory:string,projectId:string,lockInput:unknown
):Promise<import("./local-store.ts").ProjectRetentionPin>{
  const checked=validateProjectLock(lockInput);
  if(!checked.ok)throw new Error("Project lock validation failed: "+checked.errors.join("; "));
  return setProjectRetentionPin(storeDirectory,projectId,checked.lock);
}
/** Remove a project's persistent lock pin. Local-import pins remain independent. */
export async function unpinProjectLock(
  storeDirectory:string,projectId:string
):Promise<{projectId:string;removed:boolean}>{
  return removeProjectRetentionPin(storeDirectory,projectId);
}
