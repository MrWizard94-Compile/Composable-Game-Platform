import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  PACKAGE_RESOURCE_LIMITS,
  parseStrictJson,
  validatePackagePaths,
} from "./package-format.ts";
import {
  validateReleasePackageDirectory,
  type ReleasePackageSummary,
} from "./package-directory.ts";

export type LocalCatalogEntry = {
  moduleId: string;
  version: string;
  packageTreeProfile: "cgp.package-tree/1";
  packageTreeDigest: string;
  artifactDigest: string;
  runtime: "wasm-core" | "javascript-esm";
  files: string[];
};

export type LocalCatalog = {
  schema: "cgp.local-catalog/1";
  entries: LocalCatalogEntry[];
};

export type RegisterStagedPackageResult = {
  entry: LocalCatalogEntry;
  objectDirectory: string;
  idempotent: boolean;
};

export type StoreVerification = {
  checked: number;
  valid: number;
  errors: Array<{ moduleId: string; version: string; error: string }>;
};


export type StoreObjectState = "ready" | "deleting";
export type ProjectRetentionPinInput = {
  profileId: string;
  profileDigest: string;
  modules: readonly Pick<LocalCatalogEntry, "moduleId" | "version" | "packageTreeDigest">[];
};
export type LocalRetentionPin = { digest: string; createdAt: string };
export type ProjectRetentionPin = {
  projectId: string; profileId: string; profileDigest: string;
  modules: Array<{ moduleId: string; version: string; digest: string }>;
  createdAt: string; updatedAt: string;
};
export type StoreObjectLifecycle = {
  digest: string; state: StoreObjectState; createdAt: string; updatedAt: string;
  deletionClaim?: { token: string; pid: number; createdAt: string };
};
export type StoreLifecycle = {
  schema: "cgp.local-store-lifecycle/1";
  objects: StoreObjectLifecycle[];
  localPins: LocalRetentionPin[];
  projectPins: ProjectRetentionPin[];
};
export type StoreGcPreviewOptions = {
  gracePeriodMs?: number;
  now?: Date;
};
export type StoreGcObjectReport = {
  digest: string; state: StoreObjectState | "untracked";
  status: "candidate" | "retained" | "grace-period" | "deleting" | "invalid";
  bytes: number | null; createdAt: string; ageMs: number;
  releases: Array<{ moduleId: string; version: string }>;
  retentionRoots: string[]; reasons: string[];
};
export type StoreGcPreview = {
  schema: "cgp.store-gc-preview/1"; dryRun: true; generatedAt: string; gracePeriodMs: number;
  rootsChecked: { localPins: number; projectPins: number; activeReaderMarkers: number };
  candidates: StoreGcObjectReport[]; objects: StoreGcObjectReport[];
  missingObjects: Array<{ digest: string; releases: Array<{ moduleId: string; version: string }> }>;
  ignoredEntries: string[]; candidateBytes: number;
};


const CATALOG_SCHEMA = "cgp.local-catalog/1";
const TREE_PROFILE = "cgp.package-tree/1";

function withinLimit(path: string, size: number, count: number, total: number): void {
  if (Buffer.byteLength(path, "utf8") > PACKAGE_RESOURCE_LIMITS.maxPathBytes) {
    throw new Error("Package path exceeds the " + PACKAGE_RESOURCE_LIMITS.maxPathBytes + "-byte store limit: " + path);
  }
  if (path.split("/").length > PACKAGE_RESOURCE_LIMITS.maxPathDepth) {
    throw new Error("Package path exceeds the " + PACKAGE_RESOURCE_LIMITS.maxPathDepth + "-component store limit: " + path);
  }
  if (size > PACKAGE_RESOURCE_LIMITS.maxFileBytes) throw new Error("Package file exceeds the 64 MiB store limit: " + path);
  if (count + 1 > PACKAGE_RESOURCE_LIMITS.maxFiles) throw new Error("Package exceeds the 4,096-file store limit.");
  if (total + size > PACKAGE_RESOURCE_LIMITS.maxTotalBytes) throw new Error("Package exceeds the 128 MiB store limit.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function entryKey(entry: Pick<LocalCatalogEntry, "moduleId" | "version">): string {
  return entry.moduleId + "\0" + entry.version;
}

function sortEntries(entries: LocalCatalogEntry[]): LocalCatalogEntry[] {
  return [...entries].sort((a, b) =>
    a.moduleId < b.moduleId ? -1 :
    a.moduleId > b.moduleId ? 1 :
    a.version < b.version ? -1 :
    a.version > b.version ? 1 : 0);
}

function validateCatalogValue(value: unknown): LocalCatalog {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "entries,schema" ||
      value.schema !== CATALOG_SCHEMA || !Array.isArray(value.entries)) {
    throw new Error("catalog.json must use the closed cgp.local-catalog/1 schema.");
  }
  const entries: LocalCatalogEntry[] = [];
  const coordinates = new Set<string>();
  for (const raw of value.entries) {
    if (!isRecord(raw) ||
        Object.keys(raw).sort().join(",") !==
          "artifactDigest,files,moduleId,packageTreeDigest,packageTreeProfile,runtime,version") {
      throw new Error("catalog.json contains an entry with unknown or missing fields.");
    }
    if (typeof raw.moduleId !== "string" || raw.moduleId.length === 0 ||
        typeof raw.version !== "string" || raw.version.length === 0 ||
        raw.packageTreeProfile !== TREE_PROFILE ||
        !isDigest(raw.packageTreeDigest) || !isDigest(raw.artifactDigest) ||
        (raw.runtime !== "wasm-core" && raw.runtime !== "javascript-esm") ||
        !Array.isArray(raw.files) || raw.files.some((item) => typeof item !== "string")) {
      throw new Error("catalog.json contains an invalid release entry.");
    }
    const files = raw.files as string[];
    if (validatePackagePaths(files).length > 0 ||
        files.some((path, index) => index > 0 && files[index - 1]! >= path)) {
      throw new Error("catalog.json entry file paths must be valid, unique, and ordinally sorted.");
    }
    const entry: LocalCatalogEntry = {
      moduleId: raw.moduleId,
      version: raw.version,
      packageTreeProfile: TREE_PROFILE,
      packageTreeDigest: raw.packageTreeDigest,
      artifactDigest: raw.artifactDigest,
      runtime: raw.runtime,
      files: [...files],
    };
    const key = entryKey(entry);
    if (coordinates.has(key)) throw new Error("catalog.json contains a duplicate moduleId/version coordinate.");
    coordinates.add(key);
    entries.push(entry);
  }
  const sorted = sortEntries(entries);
  if (entries.some((entry, index) => entryKey(entry) !== entryKey(sorted[index]!))) {
    throw new Error("catalog.json entries must be sorted by moduleId and exact version.");
  }
  return { schema: CATALOG_SCHEMA, entries: sorted };
}

function existsByLstat(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function ensureStoreDirectory(root: string, relativePath: string): string {
  let current = root;
  for (const component of relativePath.split("/")) {
    current = join(current, component);
    if (existsByLstat(current)) {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error("Store path component must be a real directory: " + current);
      }
    } else {
      mkdirSync(current);
    }
  }
  return current;
}

function readCatalog(root: string): LocalCatalog {
  const path = join(root, "catalog.json");
  if (!existsByLstat(path)) return { schema: CATALOG_SCHEMA, entries: [] };
  const info = lstatSync(path);
  if (info.size > 16 * 1024 * 1024) throw new Error("catalog.json exceeds the 16 MiB metadata limit.");
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("catalog.json must be a regular file, not a symlink or special entry.");
  }
  const parsed = parseStrictJson(new Uint8Array(readFileSync(path)), "catalog.json");
  if (!parsed.ok) throw new Error(parsed.error);
  return validateCatalogValue(parsed.value);
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel));
}

function storeRoot(path: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute)) mkdirSync(absolute, { recursive: true });
  const info = lstatSync(absolute);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("Store root must be a real directory, not a symlink or file.");
  }
  return realpathSync(absolute);
}


export type StoreCoordinationOptions = {
  /** Maximum time to wait for a conflicting store operation. Defaults to 30 seconds. */
  waitTimeoutMs?: number;
  /** Poll interval while waiting for another operation. Defaults to 10 milliseconds. */
  pollIntervalMs?: number;
};

const STORE_READER_DIRECTORY = ".cgp-store.readers";
const STORE_WRITER_LOCK = ".cgp-store.lock";
const STORE_READER_SCHEMA = "cgp.local-store-reader/1";
const DEFAULT_STORE_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_STORE_POLL_INTERVAL_MS = 10;

type CheckedStoreCoordinationOptions = {
  waitTimeoutMs: number;
  pollIntervalMs: number;
};

function checkedCoordinationOptions(
  options: StoreCoordinationOptions = {},
): CheckedStoreCoordinationOptions {
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_STORE_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_STORE_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs < 0) {
    throw new Error("Store coordination waitTimeoutMs must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 1000) {
    throw new Error("Store coordination pollIntervalMs must be an integer from 1 through 1000.");
  }
  return { waitTimeoutMs, pollIntervalMs };
}

function createOwnedMarker(
  path: string,
  marker: Record<string, unknown>,
  label: string,
): void {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, JSON.stringify(marker) + "\n");
    fsyncSync(descriptor);
    closeSync(descriptor);
  } catch (error) {
    try { closeSync(descriptor); } catch {}
    try { unlinkSync(path); } catch {}
    throw new Error("Could not create " + label + " marker: " +
      (error instanceof Error ? error.message : String(error)));
  }
}

function releaseOwnedMarker(
  path: string,
  token: string,
  schema: string,
  label: string,
): void {
  if (!existsByLstat(path)) {
    throw new Error("The " + label + " marker disappeared before its owner released it.");
  }
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("The " + label + " marker was replaced by a non-regular entry.");
  }
  const parsed = parseStrictJson(new Uint8Array(readFileSync(path)), label + " marker");
  if (!parsed.ok || !isRecord(parsed.value) ||
      parsed.value.schema !== schema || parsed.value.token !== token) {
    throw new Error("The " + label + " marker ownership changed; refusing to remove a marker not owned by this operation.");
  }
  unlinkSync(path);
}

function readerMarkerPaths(root: string): string[] {
  const directory = join(root, STORE_READER_DIRECTORY);
  if (!existsByLstat(directory)) return [];
  const info = lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("Store reader-marker path must be a real directory: " + directory);
  }
  const paths: string[] = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    let marker;
    try {
      marker = lstatSync(path);
    } catch (error) {
      // A reader may finish after readdirSync but before lstatSync. That marker
      // is already gone, so it no longer blocks the writer.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    // Unknown entries and malformed markers count as readers. A writer must fail
    // closed rather than infer that an unrecognized marker is safe to ignore.
    if (marker.isSymbolicLink() || !marker.isFile()) {
      throw new Error("Store reader-marker directory contains a non-regular entry: " + path);
    }
    paths.push(path);
  }
  return paths;
}

async function waitForReadersToDrain(
  root: string,
  options: CheckedStoreCoordinationOptions,
): Promise<void> {
  const deadline = performance.now() + options.waitTimeoutMs;
  while (true) {
    const readers = readerMarkerPaths(root);
    if (readers.length === 0) return;
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new Error(
        "Timed out waiting for active or stale package-store reader markers: " +
        readers.map((path) => basename(path)).join(", ") +
        ". No package-store write or deletion was started. Inspect the owning processes before manually removing stale markers.",
      );
    }
    await new Promise<void>((resolveDelay) =>
      setTimeout(resolveDelay, Math.max(1, Math.min(options.pollIntervalMs, Math.ceil(remaining)))));
  }
}

async function waitForWriterToClear(
  root: string,
  options: CheckedStoreCoordinationOptions,
  deadline: number,
): Promise<void> {
  const writerPath = join(root, STORE_WRITER_LOCK);
  while (existsByLstat(writerPath)) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new Error(
        "Timed out waiting for the package-store writer lock (which may be stale): " + writerPath +
        ". No package bytes were read. Inspect the owning process before manually removing the writer marker.",
      );
    }
    await new Promise<void>((resolveDelay) =>
      setTimeout(resolveDelay, Math.max(1, Math.min(options.pollIntervalMs, Math.ceil(remaining)))));
  }
}

function ensureReaderMarkerDirectory(root: string): string {
  const directory = join(root, STORE_READER_DIRECTORY);
  if (!existsByLstat(directory)) {
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      // Another first reader may have created the directory after our existence check.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const info = lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("Store reader-marker path must be a real directory: " + directory);
  }
  return directory;
}

async function acquireReadLock(
  root: string,
  options: CheckedStoreCoordinationOptions,
): Promise<{ release(): void }> {
  const directory = ensureReaderMarkerDirectory(root);
  const token = randomUUID();
  const markerPath = join(directory, token + ".json");
  const marker = {
    schema: STORE_READER_SCHEMA,
    token,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  const release = () => releaseOwnedMarker(
    markerPath, token, STORE_READER_SCHEMA, "package-store reader",
  );
  const deadline = performance.now() + options.waitTimeoutMs;

  while (true) {
    await waitForWriterToClear(root, options, deadline);
    createOwnedMarker(markerPath, marker, "package-store reader");
    // This second check closes the race with a writer that claimed the store
    // after the first check but before this reader published its marker.
    if (!existsByLstat(join(root, STORE_WRITER_LOCK))) return { release };
    release();
  }
}

async function acquireWriteLock(
  root: string,
  options: CheckedStoreCoordinationOptions,
): Promise<{ release(): void }> {
  const lockPath = join(root, STORE_WRITER_LOCK);
  const token = randomUUID();
  const marker = {
    schema: "cgp.local-store-lock/1",
    token,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  try {
    createOwnedMarker(lockPath, marker, "package-store writer");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        "Store is locked by another writer or a stale lock exists: " + lockPath +
        ". Verify no store operation is active before manually removing a stale lock.",
      );
    }
    throw error;
  }
  const release = () => releaseOwnedMarker(
    lockPath, token, "cgp.local-store-lock/1", "package-store writer",
  );
  try {
    // Creating the writer marker prevents new readers from entering. Existing
    // readers drain before the operation is allowed to mutate store contents.
    await waitForReadersToDrain(root, options);
  } catch (error) {
    try {
      release();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Could not acquire the package-store writer lock or clean up its marker.",
      );
    }
    throw error;
  }
  return { release };
}

async function runWithStoreLock<T>(
  operation: () => Promise<T> | T,
  release: () => void,
  label: string,
): Promise<T> {
  let result!: T;
  let operationFailed = false;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  let releaseFailed = false;
  let releaseError: unknown;
  try {
    release();
  } catch (error) {
    releaseFailed = true;
    releaseError = error;
  }
  if (operationFailed && releaseFailed) {
    throw new AggregateError(
      [operationError, releaseError],
      "The package-store " + label + " operation and marker release both failed.",
    );
  }
  if (operationFailed) throw operationError;
  if (releaseFailed) throw releaseError;
  return result;
}

/**
 * Holds a cooperative cross-process reader marker for the entire callback.
 *
 * The callback must finish all package-file reads before returning. Returning a
 * package path does not extend this marker's lifetime and is not a retention pin.
 * A marker left by a crashed process is deliberately not reclaimed automatically.
 */
export async function withLocalStoreReadLock<T>(
  storeDirectory: string,
  operation: (canonicalStoreRoot: string) => Promise<T> | T,
  coordination: StoreCoordinationOptions = {},
): Promise<T> {
  const root = storeRoot(storeDirectory);
  const lock = await acquireReadLock(root, checkedCoordinationOptions(coordination));
  return runWithStoreLock(() => operation(root), lock.release, "reader");
}

/**
 * Holds the exclusive package-store writer marker and waits for all readers to drain.
 *
 * Registration and future destructive maintenance must use this gate. The lock is
 * cooperative and intended for same-host processes on a local filesystem; it is not
 * a distributed lock or a security boundary.
 */
export async function withLocalStoreWriteLock<T>(
  storeDirectory: string,
  operation: (canonicalStoreRoot: string) => Promise<T> | T,
  coordination: StoreCoordinationOptions = {},
): Promise<T> {
  const root = storeRoot(storeDirectory);
  const lock = await acquireWriteLock(root, checkedCoordinationOptions(coordination));
  return runWithStoreLock(() => operation(root), lock.release, "writer");
}
function assertStoreObjectParents(root: string, digest: string): string {
  let current = root;
  for (const component of ["objects", "cgp.package-tree", "1", "sha256", digest.slice("sha256:".length)]) {
    current = join(current, component);
    let info;
    try { info = lstatSync(current); } catch {
      throw new Error("Content-store object path is missing: " + current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("Content-store object path contains a non-directory or symlink: " + current);
    }
  }
  return current;
}

function objectDirectory(root: string, digest: string): string {
  return join(root, "objects", "cgp.package-tree", "1", "sha256", digest.slice("sha256:".length));
}

/**
 * Returns the validated content-object directory for a package-tree digest.
 * This checks the store path itself but deliberately does not scan package files.
 */

const LIFECYCLE_SCHEMA = "cgp.local-store-lifecycle/1";
const LIFECYCLE_FILE = ".cgp-store-lifecycle.json";
const DEFAULT_GC_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function validIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function projectIdIsValid(value: unknown): value is string {
  return typeof value === "string" && PROJECT_ID_RE.test(value);
}
function lifecycleObject(lifecycle: StoreLifecycle, digest: string): StoreObjectLifecycle | undefined {
  return lifecycle.objects.find((item) => item.digest === digest);
}
function assertObjectReady(lifecycle: StoreLifecycle, digest: string): void {
  if (lifecycleObject(lifecycle, digest)?.state === "deleting") {
    throw new Error("Package object " + digest + " is marked deleting; new readers and retention pins are refused.");
  }
}
function compareString(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function sortLifecycle(lifecycle: StoreLifecycle): StoreLifecycle {
  return {
    schema: LIFECYCLE_SCHEMA,
    objects: [...lifecycle.objects].sort((a,b)=>compareString(a.digest,b.digest)),
    localPins: [...lifecycle.localPins].sort((a,b)=>compareString(a.digest,b.digest)),
    projectPins: [...lifecycle.projectPins].sort((a,b)=>compareString(a.projectId,b.projectId)),
  };
}
function validateStoreLifecycleValue(value: unknown): StoreLifecycle {
  if (!isRecord(value) ||
      Object.keys(value).sort().join(",") !== "localPins,objects,projectPins,schema" ||
      value.schema !== LIFECYCLE_SCHEMA || !Array.isArray(value.objects) ||
      !Array.isArray(value.localPins) || !Array.isArray(value.projectPins)) {
    throw new Error(LIFECYCLE_FILE + " must use the closed cgp.local-store-lifecycle/1 schema.");
  }
  const objects: StoreObjectLifecycle[] = [];
  const objectDigests = new Set<string>();
  for (const raw of value.objects) {
    if (!isRecord(raw)) throw new Error(LIFECYCLE_FILE + " contains an invalid object-state record.");
    const keys = Object.keys(raw).sort().join(",");
    if (keys !== "createdAt,digest,state,updatedAt" && keys !== "createdAt,deletionClaim,digest,state,updatedAt") {
      throw new Error(LIFECYCLE_FILE + " object-state record has unknown or missing fields.");
    }
    if (!isDigest(raw.digest) || (raw.state !== "ready" && raw.state !== "deleting") ||
        !validIsoDate(raw.createdAt) || !validIsoDate(raw.updatedAt) || objectDigests.has(raw.digest)) {
      throw new Error(LIFECYCLE_FILE + " contains an invalid or duplicate object-state record.");
    }
    let deletionClaim: StoreObjectLifecycle["deletionClaim"];
    if (raw.state === "deleting") {
      if (!isRecord(raw.deletionClaim) ||
          Object.keys(raw.deletionClaim).sort().join(",") !== "createdAt,pid,token" ||
          typeof raw.deletionClaim.token !== "string" || raw.deletionClaim.token.length < 16 ||
          !Number.isSafeInteger(raw.deletionClaim.pid) || (raw.deletionClaim.pid as number) <= 0 ||
          !validIsoDate(raw.deletionClaim.createdAt)) {
        throw new Error(LIFECYCLE_FILE + " contains an invalid deletion claim.");
      }
      deletionClaim = {token:raw.deletionClaim.token,pid:raw.deletionClaim.pid as number,createdAt:raw.deletionClaim.createdAt};
    } else if (raw.deletionClaim !== undefined) {
      throw new Error(LIFECYCLE_FILE + " ready objects must not carry a deletion claim.");
    }
    objectDigests.add(raw.digest);
    objects.push({
      digest:raw.digest,state:raw.state,createdAt:raw.createdAt,updatedAt:raw.updatedAt,
      ...(deletionClaim?{deletionClaim}:{})
    });
  }
  const localPins: LocalRetentionPin[] = [];
  const localPinDigests = new Set<string>();
  for (const raw of value.localPins) {
    if (!isRecord(raw) || Object.keys(raw).sort().join(",") !== "createdAt,digest" ||
        !isDigest(raw.digest) || !validIsoDate(raw.createdAt) || localPinDigests.has(raw.digest)) {
      throw new Error(LIFECYCLE_FILE + " contains an invalid or duplicate local-retention pin.");
    }
    localPinDigests.add(raw.digest); localPins.push({digest:raw.digest,createdAt:raw.createdAt});
  }
  const projectPins: ProjectRetentionPin[] = [];
  const projectIds = new Set<string>();
  for (const raw of value.projectPins) {
    if (!isRecord(raw) ||
        Object.keys(raw).sort().join(",") !== "createdAt,modules,profileDigest,profileId,projectId,updatedAt" ||
        !projectIdIsValid(raw.projectId) || typeof raw.profileId !== "string" || !raw.profileId ||
        !isDigest(raw.profileDigest) || !validIsoDate(raw.createdAt) || !validIsoDate(raw.updatedAt) ||
        !Array.isArray(raw.modules) || projectIds.has(raw.projectId)) {
      throw new Error(LIFECYCLE_FILE + " contains an invalid or duplicate project-retention pin.");
    }
    const modules: ProjectRetentionPin["modules"] = [];
    const seenModuleIds = new Set<string>();
    for (const module of raw.modules) {
      if (!isRecord(module) || Object.keys(module).sort().join(",") !== "digest,moduleId,version" ||
          typeof module.moduleId !== "string" || !module.moduleId ||
          typeof module.version !== "string" || !module.version || !isDigest(module.digest) ||
          seenModuleIds.has(module.moduleId)) {
        throw new Error(LIFECYCLE_FILE + " contains an invalid project pin module.");
      }
      seenModuleIds.add(module.moduleId);
      modules.push({moduleId:module.moduleId,version:module.version,digest:module.digest});
    }
    projectIds.add(raw.projectId);
    projectPins.push({
      projectId:raw.projectId,profileId:raw.profileId,profileDigest:raw.profileDigest,modules,
      createdAt:raw.createdAt,updatedAt:raw.updatedAt
    });
  }
  const sorted=sortLifecycle({schema:LIFECYCLE_SCHEMA,objects,localPins,projectPins});
  if (objects.some((x,i)=>x.digest!==sorted.objects[i]!.digest) ||
      localPins.some((x,i)=>x.digest!==sorted.localPins[i]!.digest) ||
      projectPins.some((x,i)=>x.projectId!==sorted.projectPins[i]!.projectId)) {
    throw new Error(LIFECYCLE_FILE + " records must be sorted deterministically.");
  }
  for (const digest of localPinDigests) if (!objectDigests.has(digest)) {
    throw new Error(LIFECYCLE_FILE + " local-retention pin references an unknown object.");
  }
  for (const pin of projectPins) for (const module of pin.modules) if (!objectDigests.has(module.digest)) {
    throw new Error(LIFECYCLE_FILE + " project-retention pin references an unknown object.");
  }
  return sorted;
}
function legacyObjectCreatedAt(root: string, digest: string): string {
  try {
    const info=lstatSync(assertStoreObjectParents(root,digest));
    const millis=Number.isFinite(info.birthtimeMs)&&info.birthtimeMs>0?info.birthtimeMs:info.mtimeMs;
    return new Date(millis).toISOString();
  } catch { return new Date().toISOString(); }
}
/** Missing lifecycle data is migrated conservatively: every catalog package stays locally pinned. */
function readStoreLifecycle(root: string, catalog: LocalCatalog): StoreLifecycle {
  const path=join(root,LIFECYCLE_FILE);
  if(!existsByLstat(path)){
    const byDigest=new Map<string,StoreObjectLifecycle>();
    for(const entry of catalog.entries) if(!byDigest.has(entry.packageTreeDigest)){
      const createdAt=legacyObjectCreatedAt(root,entry.packageTreeDigest);
      byDigest.set(entry.packageTreeDigest,{digest:entry.packageTreeDigest,state:"ready",createdAt,updatedAt:createdAt});
    }
    return sortLifecycle({
      schema:LIFECYCLE_SCHEMA,objects:[...byDigest.values()],
      localPins:[...byDigest.keys()].map(digest=>({digest,createdAt:byDigest.get(digest)!.createdAt})),
      projectPins:[]
    });
  }
  const info=lstatSync(path);
  if(info.isSymbolicLink()||!info.isFile()) throw new Error(LIFECYCLE_FILE+" must be a regular file, not a symlink or special entry.");
  if(info.size>16*1024*1024) throw new Error(LIFECYCLE_FILE+" exceeds the 16 MiB metadata limit.");
  const parsed=parseStrictJson(new Uint8Array(readFileSync(path)),LIFECYCLE_FILE);
  if(!parsed.ok) throw new Error(parsed.error);
  const lifecycle=validateStoreLifecycleValue(parsed.value);
  const known=new Set(lifecycle.objects.map(item=>item.digest));
  for(const entry of catalog.entries) if(!known.has(entry.packageTreeDigest)){
    throw new Error(LIFECYCLE_FILE+" is missing an object-state record for catalog digest "+entry.packageTreeDigest+".");
  }
  return lifecycle;
}
function writeStoreLifecycleAtomically(root:string,input:StoreLifecycle):void{
  const lifecycle=sortLifecycle(input),target=join(root,LIFECYCLE_FILE);
  const temporary=join(root,".cgp-store-lifecycle-"+randomUUID()+".tmp");
  const descriptor=openSync(temporary,"wx",0o600);
  try{
    writeFileSync(descriptor,JSON.stringify(lifecycle,null,2)+"\n");
    fsyncSync(descriptor);closeSync(descriptor);renameSync(temporary,target);
  }catch(error){
    try{closeSync(descriptor);}catch{}
    rmSync(temporary,{force:true});throw error;
  }
}
function setObjectReady(lifecycle:StoreLifecycle,digest:string,now:string,createdAt=now):void{
  const existing=lifecycleObject(lifecycle,digest);
  if(existing?.state==="deleting") throw new Error("Package object "+digest+" is marked deleting and cannot be registered.");
  if(existing){existing.state="ready";existing.updatedAt=now;delete existing.deletionClaim;}
  else lifecycle.objects.push({digest,state:"ready",createdAt,updatedAt:now});
}
function setLocalPin(lifecycle:StoreLifecycle,digest:string,now:string):boolean{
  if(lifecycle.localPins.some(x=>x.digest===digest))return false;
  lifecycle.localPins.push({digest,createdAt:now});return true;
}
function projectPinRootsDigest(lifecycle:StoreLifecycle,digest:string):string[]{
  return lifecycle.projectPins.filter(p=>p.modules.some(m=>m.digest===digest)).map(p=>"project:"+p.projectId);
}
function assertNoRetentionRoots(lifecycle:StoreLifecycle,digest:string):void{
  const roots:string[]=[];
  if(lifecycle.localPins.some(p=>p.digest===digest))roots.push("local-retention");
  roots.push(...projectPinRootsDigest(lifecycle,digest));
  if(roots.length)throw new Error("Package object "+digest+" is still retained by: "+roots.join(", ")+".");
}
async function verifyPackageObjectForDigest(root:string,digest:string,catalog:LocalCatalog):Promise<ReleasePackageSummary>{
  const path=assertStoreObjectParents(root,digest);
  const result=await validateReleasePackageDirectory(path);
  if(!result.ok)throw new Error("Package object "+digest+" failed validation: "+result.errors.join("; "));
  if(result.package.packageTreeDigest!==digest)throw new Error("Package object directory digest does not match its verified package-tree digest: "+digest);
  const actual=toCatalogEntry(result.package);
  for(const entry of catalog.entries.filter(x=>x.packageTreeDigest===digest)){
    if(JSON.stringify(actual)!==JSON.stringify(entry))throw new Error("Package object "+digest+" disagrees with its catalog release identity.");
  }
  return result.package;
}
async function measurePackageDirectory(path:string):Promise<number>{
  let total=0;
  function visit(directory:string):void{
    for(const entry of readdirSync(directory,{withFileTypes:true})){
      const childPath=join(directory,entry.name),info=lstatSync(childPath);
      if(info.isSymbolicLink())throw new Error("Package object contains a symbolic link: "+childPath);
      if(info.isDirectory())visit(childPath);
      else if(info.isFile())total+=info.size;
      else throw new Error("Package object contains a special filesystem entry: "+childPath);
    }
  }
  visit(path);return total;
}
function checkedGcOptions(options:StoreGcPreviewOptions):{gracePeriodMs:number;now:Date}{
  const gracePeriodMs=options.gracePeriodMs??DEFAULT_GC_GRACE_PERIOD_MS;
  const now=options.now??new Date();
  if(!Number.isSafeInteger(gracePeriodMs)||gracePeriodMs<0)throw new Error("GC gracePeriodMs must be a non-negative safe integer.");
  if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw new Error("GC preview clock must be a valid Date.");
  return {gracePeriodMs,now};
}

export function localPackageObjectDirectory(storeDirectory: string, digest: string): string {
  if (!isDigest(digest)) throw new Error("Invalid package-tree SHA-256 digest.");
  const root=storeRoot(storeDirectory),catalog=readCatalog(root);
  assertObjectReady(readStoreLifecycle(root,catalog),digest);
  return assertStoreObjectParents(root,digest);
}


function removeTemporaryDirectory(directory: string): void {
  if (!existsByLstat(directory)) return;
  function thaw(current: string): void {
    for (const child of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, child.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) thaw(path);
      try { chmodSync(path, info.isDirectory() ? 0o755 : 0o644); } catch {}
    }
    try { chmodSync(current, 0o755); } catch {}
  }
  thaw(directory);
  rmSync(directory, { recursive: true, force: true });
}

function copyValidatedFiles(source: string, destination: string): void {
  let count = 0;
  let total = 0;
  function visit(directory: string, prefix: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = prefix ? prefix + "/" + entry.name : entry.name;
      const absolute = join(directory, entry.name);
      const before = lstatSync(absolute);
      if (before.isSymbolicLink()) throw new Error("Staging input contains a symbolic link: " + path);
      if (before.isDirectory()) {
        visit(absolute, path);
        continue;
      }
      if (!before.isFile()) throw new Error("Staging input contains a special entry: " + path);
      withinLimit(path, before.size, count, total);
      const bytes = readFileSync(absolute);
      const after = lstatSync(absolute);
      if (after.isSymbolicLink() || !after.isFile() ||
          after.dev !== before.dev || after.ino !== before.ino ||
          after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        throw new Error("Staging input changed while being copied: " + path);
      }
      count += 1;
      total += bytes.byteLength;
      const target = join(destination, ...path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes, { flag: "wx" });
    }
  }
  visit(source, "");
}

function summariesMatch(a: ReleasePackageSummary, b: ReleasePackageSummary): boolean {
  return a.moduleId === b.moduleId &&
    a.version === b.version &&
    a.packageTreeProfile === b.packageTreeProfile &&
    a.packageTreeDigest === b.packageTreeDigest &&
    a.artifactDigest === b.artifactDigest &&
    a.descriptor.runtime.kind === b.descriptor.runtime.kind &&
    JSON.stringify(a.files) === JSON.stringify(b.files);
}

function toCatalogEntry(summary: ReleasePackageSummary): LocalCatalogEntry {
  return {
    moduleId: summary.moduleId,
    version: summary.version,
    packageTreeProfile: summary.packageTreeProfile,
    packageTreeDigest: summary.packageTreeDigest,
    artifactDigest: summary.artifactDigest,
    runtime: summary.descriptor.runtime.kind,
    files: [...summary.files].sort(),
  };
}

function writeCatalogAtomically(root: string, catalog: LocalCatalog): void {
  const target = join(root, "catalog.json");
  const temporary = join(root, ".catalog-" + randomUUID() + ".tmp");
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, JSON.stringify(catalog, null, 2) + String.fromCharCode(10));
    fsyncSync(descriptor);
    closeSync(descriptor);
    renameSync(temporary, target);
  } catch (error) {
    try { closeSync(descriptor); } catch {}
    rmSync(temporary, { force: true });
    throw error;
  }
}

function verifyObjectDirectory(path: string, expected: ReleasePackageSummary): Promise<ReleasePackageSummary> {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("Content-addressed object path is not a real directory: " + path);
  }
  return validateReleasePackageDirectory(path).then((result) => {
    if (!result.ok) throw new Error("Stored package failed validation: " + result.errors.join("; "));
    if (!summariesMatch(expected, result.package)) {
      throw new Error("Stored package bytes or metadata do not match the expected content identity.");
    }
    return result.package;
  });
}

/** Registers a validated staging directory in the local content store and immutable release catalog. */
export async function registerStagedPackage(
  stagingDirectory: string,
  storeDirectory: string,
): Promise<RegisterStagedPackageResult> {
  const stagingPath = resolve(stagingDirectory);
  return withLocalStoreWriteLock(storeDirectory, async (root) => {
    const staged = await validateReleasePackageDirectory(stagingPath);
    if (!staged.ok) throw new Error("Staging package validation failed: " + staged.errors.join("; "));
    const stagingCanonical = realpathSync(stagingPath);
    if (isWithin(root, stagingCanonical) || isWithin(stagingCanonical, root)) {
      throw new Error("Staging directory and content-store root must not overlap.");
    }
    const entry = toCatalogEntry(staged.package);
    const catalog=readCatalog(root),lifecycle=readStoreLifecycle(root,catalog);
    assertObjectReady(lifecycle,entry.packageTreeDigest);
    const existingCoordinate = catalog.entries.find((item) =>
      item.moduleId === entry.moduleId && item.version === entry.version);
    if (existingCoordinate &&
        (existingCoordinate.packageTreeProfile !== entry.packageTreeProfile ||
         existingCoordinate.packageTreeDigest !== entry.packageTreeDigest)) {
      throw new Error(
        "Immutable release conflict for " + entry.moduleId + "@" + entry.version +
        ": catalog already binds this coordinate to " + existingCoordinate.packageTreeDigest + ".",
      );
    }
    if (existingCoordinate && JSON.stringify(existingCoordinate) !== JSON.stringify(entry)) {
      throw new Error("Existing catalog record metadata disagrees with the validated package for " +
        entry.moduleId + "@" + entry.version + ".");
    }
    const target = objectDirectory(root, entry.packageTreeDigest);
    ensureStoreDirectory(root, "objects/cgp.package-tree/1/sha256");
    let idempotent = existingCoordinate !== undefined;
    if (existsByLstat(target)) {
      await verifyObjectDirectory(target, staged.package);
    } else {
      const temporary = mkdtempSync(join(dirname(target), ".cgp-object-"));
      try {
        copyValidatedFiles(stagingPath, temporary);
        const copied = await validateReleasePackageDirectory(temporary);
        if (!copied.ok) throw new Error("Copied content object failed validation: " + copied.errors.join("; "));
        if (!summariesMatch(staged.package, copied.package)) {
          throw new Error("Staging content changed or copied object digest did not match.");
        }
        // Freeze synchronously before publishing the directory.
        function freeze(path: string): void {
          for (const child of readdirSync(path, { withFileTypes: true })) {
            const childPath = join(path, child.name);
            const childInfo = lstatSync(childPath);
            if (childInfo.isSymbolicLink()) throw new Error("Refusing to freeze a symlink in the content store.");
            if (childInfo.isDirectory()) {
              freeze(childPath);
              chmodSync(childPath, 0o555);
            } else if (childInfo.isFile()) chmodSync(childPath, 0o444);
            else throw new Error("Refusing to freeze a special entry in the content store.");
          }
          chmodSync(path, 0o555);
        }
        freeze(temporary);
        renameSync(temporary, target);
      } catch (error) {
        removeTemporaryDirectory(temporary);
        throw error;
      }
    }
    const afterStage = await validateReleasePackageDirectory(stagingPath);
    if (!afterStage.ok || !summariesMatch(staged.package, afterStage.package)) {
      throw new Error("Staging directory changed during registration; catalog was not updated.");
    }
    // Commit retention metadata first. An interrupted registration can leave a
    // pinned orphan, never a catalog row pointing at immediately collectable bytes.
    const now=new Date().toISOString(),objectInfo=lstatSync(target);
    const createdAt=lifecycleObject(lifecycle,entry.packageTreeDigest)?.createdAt ??
      new Date(objectInfo.birthtimeMs>0?objectInfo.birthtimeMs:objectInfo.mtimeMs).toISOString();
    setObjectReady(lifecycle,entry.packageTreeDigest,now,createdAt);
    setLocalPin(lifecycle,entry.packageTreeDigest,now);
    writeStoreLifecycleAtomically(root,lifecycle);
    if (!existingCoordinate) {
      const entries = sortEntries([...catalog.entries, entry]);
      writeCatalogAtomically(root, { schema: CATALOG_SCHEMA, entries });
      idempotent = false;
    }
    return { entry, objectDirectory: target, idempotent };
  });
}

/** Returns the validated local catalog. Missing catalog is an empty catalog. */
export function readLocalCatalog(storeDirectory: string): LocalCatalog {
  const root = storeRoot(storeDirectory);
  return readCatalog(root);
}

/** Resolves and verifies an exact package while a store read marker is held. The returned path is not a retention lease. */
export async function resolveLocalPackage(
  storeDirectory: string,
  moduleId: string,
  version: string,
): Promise<{ entry: LocalCatalogEntry; objectDirectory: string } | undefined> {
  return withLocalStoreReadLock(storeDirectory, async (root) => {
    const catalog=readCatalog(root),lifecycle=readStoreLifecycle(root,catalog);
    const entry = catalog.entries.find((item) => item.moduleId === moduleId && item.version === version);
    if (!entry) return undefined;
    assertObjectReady(lifecycle,entry.packageTreeDigest);
    const path = assertStoreObjectParents(root, entry.packageTreeDigest);
    const result = await validateReleasePackageDirectory(path);
    if (!result.ok) throw new Error("Stored package failed validation: " + result.errors.join("; "));
    if (JSON.stringify(toCatalogEntry(result.package)) !== JSON.stringify(entry)) {
      throw new Error("Stored object metadata or digests disagree with the catalog record.");
    }
    return { entry, objectDirectory: path };
  });
}

/** Revalidates every catalog-referenced object while a store read marker is held. */
export async function verifyLocalStore(storeDirectory: string): Promise<StoreVerification> {
  return withLocalStoreReadLock(storeDirectory, async (root) => {
    const catalog=readCatalog(root),lifecycle=readStoreLifecycle(root,catalog);
    const errors: StoreVerification["errors"] = [];
    let valid = 0;
    for (const entry of catalog.entries) {
      let path = objectDirectory(root, entry.packageTreeDigest);
      try {
        assertObjectReady(lifecycle,entry.packageTreeDigest);
        path = assertStoreObjectParents(root, entry.packageTreeDigest);
        const result = await validateReleasePackageDirectory(path);
        if (!result.ok) throw new Error(result.errors.join("; "));
        const actual = toCatalogEntry(result.package);
        if (JSON.stringify(actual) !== JSON.stringify(entry)) {
          throw new Error("Stored object metadata or digests disagree with the catalog record.");
        }
        valid += 1;
      } catch (error) {
        errors.push({
          moduleId: entry.moduleId,
          version: entry.version,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { checked: catalog.entries.length, valid, errors };
  });
}


/** Add or restore a local-retention pin for a verified package object. */
export async function addLocalRetentionPin(storeDirectory:string,digest:string):Promise<{digest:string;added:boolean}>{
  if(!isDigest(digest))throw new Error("Invalid package-tree SHA-256 digest.");
  return withLocalStoreWriteLock(storeDirectory,async root=>{
    const catalog=readCatalog(root),lifecycle=readStoreLifecycle(root,catalog);
    assertObjectReady(lifecycle,digest);
    const objectPath=assertStoreObjectParents(root,digest),info=lstatSync(objectPath);
    const now=new Date().toISOString(),existing=lifecycleObject(lifecycle,digest);
    const createdAt=existing?.createdAt??new Date(info.birthtimeMs>0?info.birthtimeMs:info.mtimeMs).toISOString();
    if(!existing)setObjectReady(lifecycle,digest,now,createdAt);
    await verifyPackageObjectForDigest(root,digest,catalog);
    const added=setLocalPin(lifecycle,digest,now);
    if(added||!existing)writeStoreLifecycleAtomically(root,lifecycle);
    return {digest,added};
  });
}
/** Remove only the local-import pin. Project pins, if any, remain independent roots. */
export async function removeLocalRetentionPin(storeDirectory:string,digest:string):Promise<{digest:string;removed:boolean}>{
  if(!isDigest(digest))throw new Error("Invalid package-tree SHA-256 digest.");
  return withLocalStoreWriteLock(storeDirectory,root=>{
    const catalog=readCatalog(root),lifecycle=readStoreLifecycle(root,catalog);
    const previous=lifecycle.localPins.length;
    lifecycle.localPins=lifecycle.localPins.filter(x=>x.digest!==digest);
    const removed=lifecycle.localPins.length!==previous;
    if(removed)writeStoreLifecycleAtomically(root,lifecycle);
    return {digest,removed};
  });
}
/** Atomically persist a project lock's exact package digests as one retention root. */
export async function setProjectRetentionPin(
  storeDirectory:string,projectId:string,input:ProjectRetentionPinInput
):Promise<ProjectRetentionPin>{
  if(!projectIdIsValid(projectId))throw new Error("projectId must start with an alphanumeric character and contain at most 128 safe identifier characters.");
  if(!isRecord(input)||typeof input.profileId!=="string"||!input.profileId||!isDigest(input.profileDigest)||!Array.isArray(input.modules)){
    throw new Error("Project retention pin input is invalid.");
  }
  return withLocalStoreWriteLock(storeDirectory,async root=>{
    const catalog=readCatalog(root),lifecycle=readStoreLifecycle(root,catalog);
    const modules:ProjectRetentionPin["modules"]=[],seen=new Set<string>();
    for(const raw of input.modules){
      if(!isRecord(raw)||typeof raw.moduleId!=="string"||!raw.moduleId||
        typeof raw.version!=="string"||!raw.version||!isDigest(raw.packageTreeDigest)){
        throw new Error("Project lock contains an invalid retention identity.");
      }
      if(seen.has(raw.moduleId))throw new Error("Project lock contains duplicate module IDs.");
      seen.add(raw.moduleId);
      const catalogEntry=catalog.entries.find(x=>x.moduleId===raw.moduleId&&x.version===raw.version);
      if(!catalogEntry||catalogEntry.packageTreeDigest!==raw.packageTreeDigest){
        throw new Error("Project lock does not match the local catalog for "+raw.moduleId+"@"+raw.version+".");
      }
      assertObjectReady(lifecycle,raw.packageTreeDigest);
      const verified=await verifyPackageObjectForDigest(root,raw.packageTreeDigest,catalog);
      if(JSON.stringify(toCatalogEntry(verified))!==JSON.stringify(catalogEntry)){
        throw new Error("Project lock package bytes do not match the catalog for "+raw.moduleId+".");
      }
      modules.push({moduleId:raw.moduleId,version:raw.version,digest:raw.packageTreeDigest});
    }
    const now=new Date().toISOString(),previous=lifecycle.projectPins.find(x=>x.projectId===projectId);
    const pin:ProjectRetentionPin={
      projectId,profileId:input.profileId,profileDigest:input.profileDigest,modules,
      createdAt:previous?.createdAt??now,updatedAt:now
    };
    lifecycle.projectPins=[...lifecycle.projectPins.filter(x=>x.projectId!==projectId),pin];
    writeStoreLifecycleAtomically(root,lifecycle);
    return pin;
  });
}
/** Remove one project's persistent lock pin without changing local-import pins. */
export async function removeProjectRetentionPin(storeDirectory:string,projectId:string):Promise<{projectId:string;removed:boolean}>{
  if(!projectIdIsValid(projectId))throw new Error("projectId must start with an alphanumeric character and contain at most 128 safe identifier characters.");
  return withLocalStoreWriteLock(storeDirectory,root=>{
    const catalog=readCatalog(root),lifecycle=readStoreLifecycle(root,catalog);
    const previous=lifecycle.projectPins.length;
    lifecycle.projectPins=lifecycle.projectPins.filter(x=>x.projectId!==projectId);
    const removed=lifecycle.projectPins.length!==previous;
    if(removed)writeStoreLifecycleAtomically(root,lifecycle);
    return {projectId,removed};
  });
}
/**
 * Atomically reserve an old verified unreferenced object for a future delete worker.
 * This operation does not delete bytes. A matching release restores state to ready.
 */
export async function claimPackageObjectDeletion(
  storeDirectory:string,digest:string,options:StoreGcPreviewOptions={}
):Promise<{digest:string;claimToken:string;createdAt:string}>{
  if(!isDigest(digest))throw new Error("Invalid package-tree SHA-256 digest.");
  const checked=checkedGcOptions(options);
  return withLocalStoreWriteLock(storeDirectory,async root=>{
    const catalog=readCatalog(root),lifecycle=readStoreLifecycle(root,catalog);
    assertNoRetentionRoots(lifecycle,digest);
    const current=lifecycleObject(lifecycle,digest);
    if(current?.state==="deleting")throw new Error("Package object already has an active deletion claim: "+digest);
    const verified=await verifyPackageObjectForDigest(root,digest,catalog);
    const path=assertStoreObjectParents(root,digest),info=lstatSync(path);
    const createdAt=current?.createdAt??new Date(info.birthtimeMs>0?info.birthtimeMs:info.mtimeMs).toISOString();
    const ageMs=Math.max(0,checked.now.getTime()-Date.parse(createdAt));
    if(ageMs<checked.gracePeriodMs)throw new Error("Package object "+digest+" has not reached its GC grace period.");
    if(verified.packageTreeDigest!==digest)throw new Error("Package object failed its content-address verification.");
    const now=checked.now.toISOString(),claimToken=randomUUID();
    const objectState:StoreObjectLifecycle={
      digest,state:"deleting",createdAt,updatedAt:now,
      deletionClaim:{token:claimToken,pid:process.pid,createdAt:now}
    };
    lifecycle.objects=[...lifecycle.objects.filter(x=>x.digest!==digest),objectState];
    writeStoreLifecycleAtomically(root,lifecycle);
    return {digest,claimToken,createdAt};
  });
}
/** Cancel a not-yet-applied deletion claim. This function never removes filesystem bytes. */
export async function releasePackageObjectDeletionClaim(
  storeDirectory:string,digest:string,claimToken:string
):Promise<void>{
  if(!isDigest(digest))throw new Error("Invalid package-tree SHA-256 digest.");
  if(typeof claimToken!=="string"||claimToken.length<16)throw new Error("A valid deletion claim token is required.");
  return withLocalStoreWriteLock(storeDirectory,root=>{
    const catalog=readCatalog(root),lifecycle=readStoreLifecycle(root,catalog);
    const current=lifecycleObject(lifecycle,digest);
    if(current?.state!=="deleting"||current.deletionClaim?.token!==claimToken){
      throw new Error("Deletion claim token does not own the deleting package object.");
    }
    current.state="ready";current.updatedAt=new Date().toISOString();delete current.deletionClaim;
    writeStoreLifecycleAtomically(root,lifecycle);
  });
}
function packageObjectDirectoryNames(root:string,ignoredEntries:string[]):string[]{
  const parent=join(root,"objects","cgp.package-tree","1","sha256");
  if(!existsByLstat(parent))return [];
  const info=lstatSync(parent);
  if(info.isSymbolicLink()||!info.isDirectory())throw new Error("Package object namespace must be a real directory.");
  const names:string[]=[];
  for(const name of readdirSync(parent).sort()){
    if(!/^[0-9a-f]{64}$/.test(name)){ignoredEntries.push(name);continue;}
    const child=lstatSync(join(parent,name));
    if(child.isSymbolicLink()||!child.isDirectory()){ignoredEntries.push(name+" (not a regular object directory)");continue;}
    names.push(name);
  }
  return names;
}
/**
 * Read-only mark analysis. It verifies content-addressed packages, checks all
 * persistent roots and applies a grace period. No lifecycle records or package
 * objects are removed or claimed.
 */
export async function previewLocalStoreGarbageCollection(
  storeDirectory:string,options:StoreGcPreviewOptions={}
):Promise<StoreGcPreview>{
  const checked=checkedGcOptions(options);
  return withLocalStoreReadLock(storeDirectory,async root=>{
    const catalog=readCatalog(root),lifecycle=readStoreLifecycle(root,catalog);
    const ignoredEntries:string[]=[],names=packageObjectDirectoryNames(root,ignoredEntries);
    const found=new Set(names),catalogByDigest=new Map<string,LocalCatalogEntry[]>();
    for(const entry of catalog.entries){
      const group=catalogByDigest.get(entry.packageTreeDigest)??[];
      group.push(entry);catalogByDigest.set(entry.packageTreeDigest,group);
    }
    const missingMap=new Map<string,Array<{moduleId:string;version:string}>>();
    for(const [digest,entries] of catalogByDigest)if(!found.has(digest.slice("sha256:".length))){
      missingMap.set(digest,entries.map(x=>({moduleId:x.moduleId,version:x.version})));
    }
    const objectDigests=new Set(names.map(name=>"sha256:"+name));
    for(const record of lifecycle.objects)if(!objectDigests.has(record.digest)&&!missingMap.has(record.digest)){
      missingMap.set(record.digest,(catalogByDigest.get(record.digest)??[]).map(x=>({moduleId:x.moduleId,version:x.version})));
    }
    const reports:StoreGcObjectReport[]=[];
    for(const name of names){
      const digest="sha256:"+name,path=assertStoreObjectParents(root,digest),info=lstatSync(path);
      const record=lifecycleObject(lifecycle,digest);
      const createdAt=record?.createdAt??new Date(info.birthtimeMs>0?info.birthtimeMs:info.mtimeMs).toISOString();
      const ageMs=Math.max(0,checked.now.getTime()-Date.parse(createdAt));
      const releases=(catalogByDigest.get(digest)??[]).map(x=>({moduleId:x.moduleId,version:x.version}));
      const retentionRoots:string[]=[];
      if(lifecycle.localPins.some(x=>x.digest===digest))retentionRoots.push("local-retention");
      retentionRoots.push(...projectPinRootsDigest(lifecycle,digest));
      const report:StoreGcObjectReport={
        digest,state:record?.state??"untracked",status:"invalid",bytes:null,createdAt,ageMs,
        releases,retentionRoots,reasons:[]
      };
      try{
        const checkedPackage=await validateReleasePackageDirectory(path);
        if(!checkedPackage.ok)throw new Error(checkedPackage.errors.join("; "));
        if(checkedPackage.package.packageTreeDigest!==digest)throw new Error("Verified package-tree digest does not match the content-store directory name.");
        const actual=toCatalogEntry(checkedPackage.package);
        for(const entry of catalogByDigest.get(digest)??[])if(JSON.stringify(actual)!==JSON.stringify(entry)){
          throw new Error("Verified package metadata disagrees with catalog release "+entry.moduleId+"@"+entry.version+".");
        }
        report.bytes=await measurePackageDirectory(path);
      }catch(error){
        report.reasons.push(error instanceof Error?error.message:String(error));
        reports.push(report);continue;
      }
      if(record?.state==="deleting"){
        report.status="deleting";report.reasons.push("An existing deletion claim requires recovery or release.");
      }else if(retentionRoots.length){
        report.status="retained";report.reasons.push("One or more persistent retention pins reference this object.");
      }else if(ageMs<checked.gracePeriodMs){
        report.status="grace-period";report.reasons.push("The object has not reached the configured GC grace period.");
      }else{
        report.status="candidate";report.reasons.push("Verified package has no local or project retention pins and has passed the grace period.");
      }
      reports.push(report);
    }
    const activeReaderMarkers=Math.max(0,readerMarkerPaths(root).length-1);
    const candidates=reports.filter(x=>x.status==="candidate");
    return {
      schema:"cgp.store-gc-preview/1",dryRun:true,generatedAt:checked.now.toISOString(),
      gracePeriodMs:checked.gracePeriodMs,
      rootsChecked:{localPins:lifecycle.localPins.length,projectPins:lifecycle.projectPins.length,activeReaderMarkers},
      candidates,objects:reports,
      missingObjects:[...missingMap].map(([digest,releases])=>({digest,releases})),
      ignoredEntries,candidateBytes:candidates.reduce((sum,x)=>sum+(x.bytes??0),0)
    };
  });
}
