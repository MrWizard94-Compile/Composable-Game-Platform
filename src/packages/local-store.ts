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
  rmdirSync,
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


export type StoreObjectState =
  | "ready"
  | "deleting"
  | "intent"
  | "quarantined"
  | "removing"
  | "deleted"
  | "ambiguous";
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
export type StoreDeletionClaim = { token: string; pid: number; createdAt: string };
export type StoreDeletionIntent = {
  claimToken: string;
  writerToken: string;
  packageTreeDigest: string;
  createdAt: string;
};
export type StoreTombstoneRecord = { name: string; movedAt: string };
export type StoreRemovalRecord = { startedAt: string };
export type StoreDeletionRecord = { claimToken: string; deletedAt: string };
export type StoreAmbiguityRecord = { reason: string; detectedAt: string };
export type StoreObjectLifecycle = {
  digest: string;
  state: StoreObjectState;
  createdAt: string;
  updatedAt: string;
  deletionClaim?: StoreDeletionClaim;
  deletionIntent?: StoreDeletionIntent;
  tombstone?: StoreTombstoneRecord;
  removal?: StoreRemovalRecord;
  deletedAt?: string;
  deletionRecord?: StoreDeletionRecord;
  ambiguity?: StoreAmbiguityRecord;
};
export type StoreLifecycle = {
  schema: "cgp.local-store-lifecycle/2";
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
  status: "candidate" | "retained" | "grace-period" | "deleting" | "invalid" | "in-progress" | "ambiguous";
  bytes: number | null; createdAt: string; ageMs: number;
  releases: Array<{ moduleId: string; version: string }>;
  retentionRoots: string[]; reasons: string[];
};
export type StoreGcPreview = {
  schema: "cgp.store-gc-preview/1"; dryRun: true; generatedAt: string; gracePeriodMs: number;
  rootsChecked: { localPins: number; projectPins: number; compositionLeases: number; activeReaderMarkers: number };
  candidates: StoreGcObjectReport[]; objects: StoreGcObjectReport[];
  missingObjects: Array<{ digest: string; releases: Array<{ moduleId: string; version: string }> }>;
  ignoredEntries: string[]; candidateBytes: number;
  recoveryRequired: Array<{ digest: string; state: StoreObjectState; reason: string }>;
  completedDeletions: Array<{ digest: string; deletedAt: string; releases: Array<{ moduleId: string; version: string }> }>;
};
export type StoreGcCoordinationOptions = StoreGcPreviewOptions & {
  coordination?: StoreCoordinationOptions;
};
export type StoreGcApplyReport = {
  schema: "cgp.store-gc-apply/1";
  appliedAt: string;
  gracePeriodMs: number;
  deleted: string[];
  skipped: Array<{ digest: string; status: string; reasons: string[] }>;
};
export type StoreGcRecoveryReport = {
  schema: "cgp.store-gc-recovery/1";
  recoveredAt: string;
  completed: string[];
  unchanged: string[];
  ambiguous: Array<{ digest: string; reason: string }>;
  refused: Array<{ digest: string; error: string }>;
};
export type StoreGcReconcileReport = {
  schema: "cgp.store-gc-reconcile/1";
  reconciledAt: string;
  /** Claims returned to ready by explicit administrative cancellation. Never inferred from pid or age. */
  released: string[];
  /** Token-owned deleting claims left with their holder. */
  retained: Array<{ digest: string; reason: string }>;
  leftInProgress: string[];
};
export type StoreGcFaultPoint =
  | "before-intent"
  | "after-intent"
  | "after-move"
  | "during-removal"
  | "after-bytes-removed";


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

const LIFECYCLE_SCHEMA_V1 = "cgp.local-store-lifecycle/1";
const LIFECYCLE_SCHEMA = "cgp.local-store-lifecycle/2";
const LIFECYCLE_FILE = ".cgp-store-lifecycle.json";
const TOMBSTONE_DIRECTORY = ".cgp-store-tombstones";
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
  const state = lifecycleObject(lifecycle, digest)?.state;
  if (state === "deleting") {
    throw new Error("Package object " + digest + " is marked deleting; new readers and retention pins are refused.");
  }
  if (state && state !== "ready") {
    throw new Error("Package object " + digest + " is " + state + " and is not available to readers or new retention pins.");
  }
}
function assertObjectRegisterable(lifecycle: StoreLifecycle, digest: string): void {
  const state = lifecycleObject(lifecycle, digest)?.state;
  if (state === "deleting") {
    throw new Error("Package object " + digest + " is marked deleting; new readers and retention pins are refused.");
  }
  if (state && state !== "ready" && state !== "deleted") {
    throw new Error("Package object " + digest + " is " + state + " and cannot be registered until deletion recovery finishes.");
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
function parseDeletionClaim(raw: unknown): StoreDeletionClaim {
  if (!isRecord(raw) ||
      Object.keys(raw).sort().join(",") !== "createdAt,pid,token" ||
      typeof raw.token !== "string" || raw.token.length < 16 ||
      !Number.isSafeInteger(raw.pid) || (raw.pid as number) <= 0 ||
      !validIsoDate(raw.createdAt)) {
    throw new Error(LIFECYCLE_FILE + " contains an invalid deletion claim.");
  }
  return { token: raw.token, pid: raw.pid as number, createdAt: raw.createdAt };
}
function parseDeletionIntent(raw: unknown, digest: string, claimToken: string): StoreDeletionIntent {
  if (!isRecord(raw) ||
      Object.keys(raw).sort().join(",") !== "claimToken,createdAt,packageTreeDigest,writerToken" ||
      raw.claimToken !== claimToken || raw.packageTreeDigest !== digest ||
      typeof raw.writerToken !== "string" || raw.writerToken.length < 16 ||
      !validIsoDate(raw.createdAt)) {
    throw new Error(LIFECYCLE_FILE + " contains an invalid deletion intent.");
  }
  return {
    claimToken,
    writerToken: raw.writerToken,
    packageTreeDigest: digest,
    createdAt: raw.createdAt,
  };
}
function parseTombstone(raw: unknown, digest: string): StoreTombstoneRecord {
  const name = digest.slice("sha256:".length);
  if (!isRecord(raw) || Object.keys(raw).sort().join(",") !== "movedAt,name" ||
      raw.name !== name || !validIsoDate(raw.movedAt)) {
    throw new Error(LIFECYCLE_FILE + " contains an invalid tombstone record.");
  }
  return { name, movedAt: raw.movedAt };
}
function lifecycleObjectKeys(state: StoreObjectState): string {
  switch (state) {
    case "ready": return "createdAt,digest,state,updatedAt";
    case "deleting": return "createdAt,deletionClaim,digest,state,updatedAt";
    case "intent": return "createdAt,deletionClaim,deletionIntent,digest,state,updatedAt";
    case "quarantined": return "createdAt,deletionClaim,deletionIntent,digest,state,tombstone,updatedAt";
    case "removing": return "createdAt,deletionClaim,deletionIntent,digest,removal,state,tombstone,updatedAt";
    case "deleted": return "createdAt,deletedAt,deletionRecord,digest,state,updatedAt";
    case "ambiguous": return "ambiguity,createdAt,digest,state,updatedAt";
  }
}
function parseLifecycleObject(raw: unknown, version: 1 | 2): StoreObjectLifecycle {
  if (!isRecord(raw)) throw new Error(LIFECYCLE_FILE + " contains an invalid object-state record.");
  const state = raw.state;
  const allowed: StoreObjectState[] = version === 1
    ? ["ready", "deleting"]
    : ["ready", "deleting", "intent", "quarantined", "removing", "deleted", "ambiguous"];
  if (!isDigest(raw.digest) || typeof state !== "string" || !allowed.includes(state as StoreObjectState) ||
      !validIsoDate(raw.createdAt) || !validIsoDate(raw.updatedAt)) {
    throw new Error(LIFECYCLE_FILE + " contains an invalid or duplicate object-state record.");
  }
  const objectState = state as StoreObjectState;
  if (Object.keys(raw).sort().join(",") !== lifecycleObjectKeys(objectState)) {
    throw new Error(LIFECYCLE_FILE + " object-state record has unknown or missing fields.");
  }
  if (objectState === "ready") {
    return { digest: raw.digest, state: "ready", createdAt: raw.createdAt, updatedAt: raw.updatedAt };
  }
  if (objectState === "deleted") {
    if (!validIsoDate(raw.deletedAt) || !isRecord(raw.deletionRecord) ||
        Object.keys(raw.deletionRecord).sort().join(",") !== "claimToken,deletedAt" ||
        typeof raw.deletionRecord.claimToken !== "string" || raw.deletionRecord.claimToken.length < 16 ||
        raw.deletionRecord.deletedAt !== raw.deletedAt) {
      throw new Error(LIFECYCLE_FILE + " contains an invalid deletion record.");
    }
    return {
      digest: raw.digest, state: "deleted", createdAt: raw.createdAt, updatedAt: raw.updatedAt,
      deletedAt: raw.deletedAt,
      deletionRecord: { claimToken: raw.deletionRecord.claimToken, deletedAt: raw.deletedAt },
    };
  }
  if (objectState === "ambiguous") {
    if (!isRecord(raw.ambiguity) || Object.keys(raw.ambiguity).sort().join(",") !== "detectedAt,reason" ||
        typeof raw.ambiguity.reason !== "string" || raw.ambiguity.reason.length === 0 ||
        raw.ambiguity.reason.length > 500 || !validIsoDate(raw.ambiguity.detectedAt)) {
      throw new Error(LIFECYCLE_FILE + " contains an invalid ambiguity record.");
    }
    return {
      digest: raw.digest, state: "ambiguous", createdAt: raw.createdAt, updatedAt: raw.updatedAt,
      ambiguity: { reason: raw.ambiguity.reason, detectedAt: raw.ambiguity.detectedAt },
    };
  }
  const deletionClaim = parseDeletionClaim(raw.deletionClaim);
  const object: StoreObjectLifecycle = {
    digest: raw.digest, state: objectState, createdAt: raw.createdAt, updatedAt: raw.updatedAt, deletionClaim,
  };
  if (objectState === "deleting") return object;
  object.deletionIntent = parseDeletionIntent(raw.deletionIntent, raw.digest, deletionClaim.token);
  if (objectState === "intent") return object;
  object.tombstone = parseTombstone(raw.tombstone, raw.digest);
  if (objectState === "quarantined") return object;
  if (!isRecord(raw.removal) || Object.keys(raw.removal).sort().join(",") !== "startedAt" ||
      !validIsoDate(raw.removal.startedAt)) {
    throw new Error(LIFECYCLE_FILE + " contains an invalid removal record.");
  }
  object.removal = { startedAt: raw.removal.startedAt };
  return object;
}
function validateStoreLifecycleValue(value: unknown): StoreLifecycle {
  if (!isRecord(value) ||
      Object.keys(value).sort().join(",") !== "localPins,objects,projectPins,schema" ||
      (value.schema !== LIFECYCLE_SCHEMA && value.schema !== LIFECYCLE_SCHEMA_V1) ||
      !Array.isArray(value.objects) || !Array.isArray(value.localPins) || !Array.isArray(value.projectPins)) {
    throw new Error(LIFECYCLE_FILE + " must use closed lifecycle schema v1 or v2.");
  }
  const version: 1 | 2 = value.schema === LIFECYCLE_SCHEMA ? 2 : 1;
  const objects: StoreObjectLifecycle[] = [];
  const objectDigests = new Set<string>();
  for (const raw of value.objects) {
    const object = parseLifecycleObject(raw, version);
    if (objectDigests.has(object.digest)) {
      throw new Error(LIFECYCLE_FILE + " contains an invalid or duplicate object-state record.");
    }
    objectDigests.add(object.digest);
    objects.push(object);
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
  if(existing && existing.state!=="ready" && existing.state!=="deleted"){
    throw new Error("Package object "+digest+" is "+existing.state+" and cannot be registered.");
  }
  if(existing){
    existing.state="ready";
    existing.updatedAt=now;
    delete existing.deletionClaim;
    delete existing.deletionIntent;
    delete existing.tombstone;
    delete existing.removal;
    delete existing.deletedAt;
    delete existing.deletionRecord;
    delete existing.ambiguity;
  } else lifecycle.objects.push({digest,state:"ready",createdAt,updatedAt:now});
}
function setLocalPin(lifecycle:StoreLifecycle,digest:string,now:string):boolean{
  if(lifecycle.localPins.some(x=>x.digest===digest))return false;
  lifecycle.localPins.push({digest,createdAt:now});return true;
}
function projectPinRootsDigest(lifecycle:StoreLifecycle,digest:string):string[]{
  return lifecycle.projectPins.filter(p=>p.modules.some(m=>m.digest===digest)).map(p=>"project:"+p.projectId);
}

const COMPOSITION_LEASE_DIR = ".cgp-store.composition-leases";
const COMPOSITION_LEASE_SCHEMA = "cgp.store-composition-lease/1";
const LEASE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type CompositionLease = {
  schema: "cgp.store-composition-lease/1";
  leaseId: string;
  token: string;
  pid: number;
  createdAt: string;
  digests: string[];
};
export type CompositionLeaseSummary = {
  leaseId: string;
  pid: number;
  createdAt: string;
  digests: string[];
};

function leasePath(root: string, leaseId: string): string {
  return join(root, COMPOSITION_LEASE_DIR, leaseId + ".json");
}
function parseCompositionLease(path: string, expectedId: string): CompositionLease {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("Composition lease must be a regular file: " + path);
  }
  if (info.size > 1024 * 1024) throw new Error("Composition lease exceeds the 1 MiB limit: " + path);
  const parsed = parseStrictJson(new Uint8Array(readFileSync(path)), "composition lease");
  if (!parsed.ok || !isRecord(parsed.value) ||
      Object.keys(parsed.value).sort().join(",") !== "createdAt,digests,leaseId,pid,schema,token" ||
      parsed.value.schema !== COMPOSITION_LEASE_SCHEMA ||
      parsed.value.leaseId !== expectedId || !LEASE_ID_RE.test(expectedId) ||
      typeof parsed.value.token !== "string" || parsed.value.token.length < 16 ||
      !Number.isSafeInteger(parsed.value.pid) || (parsed.value.pid as number) <= 0 ||
      !validIsoDate(parsed.value.createdAt) || !Array.isArray(parsed.value.digests) ||
      parsed.value.digests.length === 0) {
    throw new Error("Composition lease is malformed. Refusing to ignore it: " + path);
  }
  const digests: string[] = [];
  for (const digest of parsed.value.digests) {
    if (!isDigest(digest) || digests.includes(digest)) {
      throw new Error("Composition lease contains an invalid or duplicate digest: " + path);
    }
    digests.push(digest);
  }
  const sorted = [...digests].sort();
  if (digests.some((digest, index) => digest !== sorted[index])) {
    throw new Error("Composition lease digests must be sorted: " + path);
  }
  return {
    schema: COMPOSITION_LEASE_SCHEMA,
    leaseId: expectedId,
    token: parsed.value.token,
    pid: parsed.value.pid as number,
    createdAt: parsed.value.createdAt,
    digests,
  };
}
function readCompositionLeases(root: string): CompositionLease[] {
  const directory = join(root, COMPOSITION_LEASE_DIR);
  if (!existsByLstat(directory)) return [];
  const info = lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("Composition-lease path must be a real directory: " + directory);
  }
  const leases: CompositionLease[] = [];
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith(".json") || !LEASE_ID_RE.test(name.slice(0, -".json".length))) {
      throw new Error("Composition-lease directory contains an unexpected entry: " + name);
    }
    const child = join(directory, name);
    leases.push(parseCompositionLease(child, name.slice(0, -".json".length)));
  }
  return leases;
}
function compositionLeaseRoots(root: string, digest: string): string[] {
  return readCompositionLeases(root)
    .filter((lease) => lease.digests.includes(digest))
    .map((lease) => "composition:" + lease.leaseId);
}
function writeCompositionLease(root: string, lease: CompositionLease): void {
  const directory = join(root, COMPOSITION_LEASE_DIR);
  if (!existsByLstat(directory)) mkdirSync(directory, { mode: 0o700 });
  const info = lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("Composition-lease path must be a real directory: " + directory);
  }
  const path = leasePath(root, lease.leaseId);
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, JSON.stringify(lease, null, 2) + "\n");
    fsyncSync(descriptor);
    closeSync(descriptor);
  } catch (error) {
    try { closeSync(descriptor); } catch {}
    try { unlinkSync(path); } catch {}
    throw error;
  }
}
/**
 * Retains exact package objects for one composition. The lease is a GC root.
 * It does not hold the store writer or reader marker after this call returns.
 * A deleting or otherwise unavailable object is refused. Bytes are not copied.
 */
export async function acquireCompositionLease(
  storeDirectory: string,
  digests: readonly string[],
): Promise<CompositionLease> {
  if (!Array.isArray(digests) || digests.length === 0) {
    throw new Error("A composition lease requires at least one package digest.");
  }
  const unique = [...new Set(digests)];
  for (const digest of unique) if (!isDigest(digest)) throw new Error("Invalid package-tree SHA-256 digest.");
  const sorted = [...unique].sort();
  return withLocalStoreWriteLock(storeDirectory, async (root) => {
    const catalog = readCatalog(root);
    const lifecycle = readStoreLifecycle(root, catalog);
    for (const digest of sorted) {
      assertObjectReady(lifecycle, digest);
      await verifyPackageObjectForDigest(root, digest, catalog);
    }
    const lease: CompositionLease = {
      schema: COMPOSITION_LEASE_SCHEMA,
      leaseId: randomUUID(),
      token: randomUUID(),
      pid: process.pid,
      createdAt: new Date().toISOString(),
      digests: sorted,
    };
    writeCompositionLease(root, lease);
    return lease;
  });
}
/** Removes one lease. A missing lease is already released. A wrong token deletes nothing. */
export async function releaseCompositionLease(
  storeDirectory: string,
  leaseId: string,
  token: string,
): Promise<{ leaseId: string; released: boolean }> {
  if (!LEASE_ID_RE.test(leaseId)) throw new Error("Invalid composition lease id.");
  if (typeof token !== "string" || token.length < 16) throw new Error("A composition lease token is required.");
  return withLocalStoreWriteLock(storeDirectory, (root) => {
    const path = leasePath(root, leaseId);
    if (!existsByLstat(path)) return { leaseId, released: false };
    const lease = parseCompositionLease(path, leaseId);
    if (lease.token !== token) throw new Error("Composition lease token does not own this lease.");
    unlinkSync(path);
    return { leaseId, released: true };
  });
}
/**
 * Drops one lease whose recorded pid is not alive. Explicit only.
 * This does not delete package bytes and does not run during GC or registration.
 * Unknown liveness fails closed. A live pid is not stolen.
 */
export async function releaseAbandonedCompositionLease(
  storeDirectory: string,
  leaseId: string,
): Promise<{ leaseId: string; released: true; digests: string[] }> {
  if (!LEASE_ID_RE.test(leaseId)) throw new Error("Invalid composition lease id.");
  return withLocalStoreWriteLock(storeDirectory, (root) => {
    const path = leasePath(root, leaseId);
    if (!existsByLstat(path)) throw new Error("Composition lease does not exist: " + leaseId);
    const lease = parseCompositionLease(path, leaseId);
    const alive = writerPidIsAlive(lease.pid);
    if (alive !== false) {
      throw new Error(
        "Composition lease owner may still be active (pid " + lease.pid +
        "). Refusing to release " + leaseId + ".",
      );
    }
    const again = parseCompositionLease(path, leaseId);
    if (again.token !== lease.token || again.pid !== lease.pid) {
      throw new Error("Composition lease changed while it was checked. Refusing to release it.");
    }
    unlinkSync(path);
    return { leaseId, released: true, digests: lease.digests };
  });
}
/** Lists lease ids and digests. Tokens stay in the lease files and are not returned. */
export async function listCompositionLeases(storeDirectory: string): Promise<CompositionLeaseSummary[]> {
  return withLocalStoreReadLock(storeDirectory, (root) =>
    readCompositionLeases(root).map((lease) => ({
      leaseId: lease.leaseId,
      pid: lease.pid,
      createdAt: lease.createdAt,
      digests: [...lease.digests],
    })));
}

function retentionRootsFor(root: string, lifecycle: StoreLifecycle, digest: string): string[] {
  const roots: string[] = [];
  if (lifecycle.localPins.some((pin) => pin.digest === digest)) roots.push("local-retention");
  roots.push(...projectPinRootsDigest(lifecycle, digest));
  roots.push(...compositionLeaseRoots(root, digest));
  return roots;
}
function assertNoRetentionRoots(root: string, lifecycle: StoreLifecycle, digest: string): void {
  const roots = retentionRootsFor(root, lifecycle, digest);
  if (roots.length) throw new Error("Package object " + digest + " is still retained by: " + roots.join(", ") + ".");
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
    assertObjectRegisterable(lifecycle,entry.packageTreeDigest);
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
    assertNoRetentionRoots(root,lifecycle,digest);
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
async function inspectLockedStore(
  root: string,
  checked: { gracePeriodMs: number; now: Date },
): Promise<{
  lifecycle: StoreLifecycle;
  reports: StoreGcObjectReport[];
  missingObjects: StoreGcPreview["missingObjects"];
  ignoredEntries: string[];
  recoveryRequired: StoreGcPreview["recoveryRequired"];
  completedDeletions: StoreGcPreview["completedDeletions"];
}> {
  const catalog = readCatalog(root);
  const lifecycle = readStoreLifecycle(root, catalog);
  const ignoredEntries: string[] = [];
  const names = packageObjectDirectoryNames(root, ignoredEntries);
  const found = new Set(names);
  const catalogByDigest = new Map<string, LocalCatalogEntry[]>();
  for (const entry of catalog.entries) {
    const group = catalogByDigest.get(entry.packageTreeDigest) ?? [];
    group.push(entry);
    catalogByDigest.set(entry.packageTreeDigest, group);
  }
  const releasesFor = (digest: string) =>
    (catalogByDigest.get(digest) ?? []).map((entry) => ({ moduleId: entry.moduleId, version: entry.version }));
  const missingMap = new Map<string, Array<{ moduleId: string; version: string }>>();
  const recoveryRequired: StoreGcPreview["recoveryRequired"] = [];
  const completedDeletions: StoreGcPreview["completedDeletions"] = [];
  const objectDigests = new Set(names.map((name) => "sha256:" + name));
  const handledAbsent = new Set<string>();
  const noteAbsent = (digest: string) => {
    if (handledAbsent.has(digest) || objectDigests.has(digest)) return;
    handledAbsent.add(digest);
    const record = lifecycleObject(lifecycle, digest);
    const releases = releasesFor(digest);
    if (record?.state === "deleted") {
      completedDeletions.push({ digest, deletedAt: record.deletedAt ?? record.updatedAt, releases });
      return;
    }
    if (record && record.state !== "ready" && record.state !== "deleting") {
      recoveryRequired.push({
        digest,
        state: record.state,
        reason: "The package directory is absent while deletion is unfinished. Run store GC recovery. This inspection did not delete it.",
      });
      return;
    }
    missingMap.set(digest, releases);
  };
  for (const [digest] of catalogByDigest) if (!found.has(digest.slice("sha256:".length))) noteAbsent(digest);
  for (const record of lifecycle.objects) if (!objectDigests.has(record.digest)) noteAbsent(record.digest);
  const reports: StoreGcObjectReport[] = [];
  for (const name of names) {
    const digest = "sha256:" + name;
    const path = assertStoreObjectParents(root, digest);
    const info = lstatSync(path);
    const record = lifecycleObject(lifecycle, digest);
    const createdAt = record?.createdAt ?? new Date(info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs).toISOString();
    const ageMs = Math.max(0, checked.now.getTime() - Date.parse(createdAt));
    const releases = releasesFor(digest);
    const retentionRoots = retentionRootsFor(root, lifecycle, digest);
    const report: StoreGcObjectReport = {
      digest, state: record?.state ?? "untracked", status: "invalid", bytes: null, createdAt, ageMs,
      releases, retentionRoots, reasons: [],
    };
    try {
      const checkedPackage = await validateReleasePackageDirectory(path);
      if (!checkedPackage.ok) throw new Error(checkedPackage.errors.join("; "));
      if (checkedPackage.package.packageTreeDigest !== digest) {
        throw new Error("Verified package-tree digest does not match the content-store directory name.");
      }
      const actual = toCatalogEntry(checkedPackage.package);
      for (const entry of catalogByDigest.get(digest) ?? []) {
        if (JSON.stringify(actual) !== JSON.stringify(entry)) {
          throw new Error("Verified package metadata disagrees with catalog release " + entry.moduleId + "@" + entry.version + ".");
        }
      }
      report.bytes = await measurePackageDirectory(path);
    } catch (error) {
      report.reasons.push(error instanceof Error ? error.message : String(error));
      reports.push(report);
      continue;
    }
    if (record && record.state !== "ready" && record.state !== "deleting") {
      report.status = record.state === "ambiguous" || record.state === "deleted" ? "ambiguous" : "in-progress";
      const reason = record.state === "ambiguous"
        ? (record.ambiguity?.reason ?? "Deletion state is ambiguous. Recovery will not delete it.")
        : "Deletion is already in progress. A preview cannot authorize another deletion.";
      report.reasons.push(reason);
      recoveryRequired.push({ digest, state: record.state, reason });
    } else if (record?.state === "deleting") {
      report.status = "deleting";
      report.reasons.push("An existing deletion claim requires recovery or release.");
    } else if (retentionRoots.length) {
      report.status = "retained";
      report.reasons.push("One or more retention roots reference this object.");
    } else if (ageMs < checked.gracePeriodMs) {
      report.status = "grace-period";
      report.reasons.push("The object has not reached the configured GC grace period.");
    } else {
      report.status = "candidate";
      report.reasons.push("Verified package has no local, project, or composition retention and has passed the grace period.");
    }
    reports.push(report);
  }
  return {
    lifecycle,
    reports,
    missingObjects: [...missingMap].map(([digest, releases]) => ({ digest, releases })),
    ignoredEntries,
    recoveryRequired,
    completedDeletions,
  };
}
export async function previewLocalStoreGarbageCollection(
  storeDirectory:string,options:StoreGcPreviewOptions={}
):Promise<StoreGcPreview>{
  const checked=checkedGcOptions(options);
  return withLocalStoreReadLock(storeDirectory,async root=>{
    const inspected=await inspectLockedStore(root,checked);
    const activeReaderMarkers=Math.max(0,readerMarkerPaths(root).length-1);
    const candidates=inspected.reports.filter(x=>x.status==="candidate");
    return {
      schema:"cgp.store-gc-preview/1",dryRun:true,generatedAt:checked.now.toISOString(),
      gracePeriodMs:checked.gracePeriodMs,
      rootsChecked:{
        localPins:inspected.lifecycle.localPins.length,
        projectPins:inspected.lifecycle.projectPins.length,
        compositionLeases:readCompositionLeases(root).length,
        activeReaderMarkers,
      },
      candidates,objects:inspected.reports,
      missingObjects:inspected.missingObjects,
      ignoredEntries:inspected.ignoredEntries,
      candidateBytes:candidates.reduce((sum,x)=>sum+(x.bytes??0),0),
      recoveryRequired:inspected.recoveryRequired,
      completedDeletions:inspected.completedDeletions,
    };
  });
}

let storeGcFault: StoreGcFaultPoint | null = null;
let storeWriterLivenessProbe: ((pid: number) => boolean | "unknown") | null = null;

/** Test-only interruption points. Production calls leave this unset. */
export function setStoreGcFaultForTests(point: StoreGcFaultPoint | null): void {
  storeGcFault = point;
}
/** Test-only replacement for the PID liveness half of stale-lock adoption. */
export function setStoreWriterLivenessProbeForTests(
  probe: ((pid: number) => boolean | "unknown") | null,
): void {
  storeWriterLivenessProbe = probe;
}
function consumeStoreGcFault(point: StoreGcFaultPoint): void {
  if (storeGcFault !== point) return;
  storeGcFault = null;
  throw new Error("Injected store GC fault: " + point);
}
function replaceLifecycleObject(lifecycle: StoreLifecycle, object: StoreObjectLifecycle): void {
  const index = lifecycle.objects.findIndex((item) => item.digest === object.digest);
  if (index < 0) lifecycle.objects.push(object);
  else lifecycle.objects[index] = object;
}
function digestHex(digest: string): string {
  return digest.slice("sha256:".length);
}
function describeNamedChild(parent: string, name: string): "absent" | "directory" | "symlink" | "other" | "blocked" {
  if (!existsByLstat(parent)) return "absent";
  const parentInfo = lstatSync(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) return "blocked";
  const path = join(parent, name);
  if (!existsByLstat(path)) return "absent";
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return "symlink";
  if (info.isDirectory()) return "directory";
  return "other";
}
function classifyPresence(root: string, digest: string): "canonical" | "tombstone" | "both" | "neither" | "ambiguous" {
  const hex = digestHex(digest);
  const canonical = describeNamedChild(join(root, "objects", "cgp.package-tree", "1", "sha256"), hex);
  const tombRoot = describeNamedChild(root, TOMBSTONE_DIRECTORY);
  const tomb = tombRoot === "absent"
    ? "absent"
    : tombRoot === "directory"
      ? describeNamedChild(join(root, TOMBSTONE_DIRECTORY), hex)
      : "blocked";
  const unsafe = (value: string) => value === "symlink" || value === "other" || value === "blocked";
  if (unsafe(canonical) || unsafe(tomb)) return "ambiguous";
  if (canonical === "directory" && tomb === "directory") return "both";
  if (canonical === "directory") return "canonical";
  if (tomb === "directory") return "tombstone";
  return "neither";
}
function presenceReason(kind: "both" | "neither" | "ambiguous"): string {
  if (kind === "both") return "Package object and quarantine tombstone both exist. Refusing to delete either.";
  if (kind === "neither") return "Deletion intent has neither a package object nor a tombstone. Refusing to record a completed deletion.";
  return "Package object or quarantine entry is a symlink or special file. Refusing to follow or delete it.";
}
function markAmbiguous(root: string, lifecycle: StoreLifecycle, current: StoreObjectLifecycle, reason: string, now: string): void {
  replaceLifecycleObject(lifecycle, {
    digest: current.digest,
    state: "ambiguous",
    createdAt: current.createdAt,
    updatedAt: now,
    ambiguity: { reason, detectedAt: now },
  });
  writeStoreLifecycleAtomically(root, lifecycle);
}
function ensureTombstoneRoot(root: string): string {
  const path = join(root, TOMBSTONE_DIRECTORY);
  if (!existsByLstat(path)) mkdirSync(path, { mode: 0o700 });
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("Quarantine directory must be a real directory on the store filesystem.");
  }
  return path;
}
function moveCanonicalToTombstone(root: string, digest: string): void {
  if (classifyPresence(root, digest) !== "canonical") {
    throw new Error("Refusing to quarantine because the package object location is not an intact directory.");
  }
  const source = objectDirectory(root, digest);
  const sourceInfo = lstatSync(source);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) {
    throw new Error("Refusing to move a package object that is not a real directory.");
  }
  // Stored object directories are mode 0555. ext4 refuses to rename a directory
  // that is not writable, because the rename updates its "..". Thaw only this
  // directory inode; do not follow or retarget anything inside it.
  chmodSync(source, 0o755);
  const destination = join(ensureTombstoneRoot(root), digestHex(digest));
  if (existsByLstat(destination)) throw new Error("Quarantine path already exists for " + digest + ".");
  renameSync(source, destination);
}
function refuseSpecial(
  path: string,
  info: { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean },
): void {
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
    throw new Error("Refusing to delete a symlink or special filesystem entry: " + path);
  }
}
function thawRegularTree(directory: string): void {
  const info = lstatSync(directory);
  refuseSpecial(directory, info);
  if (!info.isDirectory()) throw new Error("Refusing to delete a non-directory quarantine entry: " + directory);
  for (const name of readdirSync(directory).sort()) {
    const child = join(directory, name);
    const childInfo = lstatSync(child);
    refuseSpecial(child, childInfo);
    if (childInfo.isDirectory()) thawRegularTree(child);
    else chmodSync(child, 0o644);
  }
  chmodSync(directory, 0o755);
}
function removeRegularTree(directory: string): void {
  thawRegularTree(directory);
  const files: string[] = [];
  const collect = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const child = join(dir, name);
      const info = lstatSync(child);
      refuseSpecial(child, info);
      if (info.isDirectory()) collect(child);
      else files.push(child);
    }
  };
  collect(directory);
  let removed = 0;
  for (const file of files) {
    const info = lstatSync(file);
    refuseSpecial(file, info);
    unlinkSync(file);
    removed += 1;
    if (removed === 1) consumeStoreGcFault("during-removal");
  }
  const removeDirs = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const child = join(dir, name);
      const info = lstatSync(child);
      refuseSpecial(child, info);
      if (!info.isDirectory()) throw new Error("Quarantine entry changed during removal: " + child);
      removeDirs(child);
    }
    rmdirSync(dir);
  };
  removeDirs(directory);
}
function readWriterMarker(root: string): { token: string; pid: number } {
  const path = join(root, STORE_WRITER_LOCK);
  if (!existsByLstat(path)) throw new Error("Package-store writer lock is not present.");
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Package-store writer lock is not a regular file.");
  const parsed = parseStrictJson(new Uint8Array(readFileSync(path)), "package-store writer lock");
  if (!parsed.ok || !isRecord(parsed.value) ||
      Object.keys(parsed.value).sort().join(",") !== "createdAt,pid,schema,token" ||
      parsed.value.schema !== "cgp.local-store-lock/1" ||
      typeof parsed.value.token !== "string" || parsed.value.token.length < 16 ||
      !Number.isSafeInteger(parsed.value.pid) || (parsed.value.pid as number) <= 0 ||
      !validIsoDate(parsed.value.createdAt)) {
    throw new Error("Package-store writer lock is malformed. Refusing to adopt it.");
  }
  return { token: parsed.value.token, pid: parsed.value.pid as number };
}
function requireWriterToken(root: string): string {
  return readWriterMarker(root).token;
}
function writerPidIsAlive(pid: number): boolean | "unknown" {
  if (storeWriterLivenessProbe) return storeWriterLivenessProbe(pid);
  if (!existsSync("/proc")) return "unknown";
  try { return existsSync("/proc/" + String(pid)); } catch { return "unknown"; }
}
function adoptInactiveDeletionLock(root: string): void {
  const lockPath = join(root, STORE_WRITER_LOCK);
  const marker = readWriterMarker(root);
  const alive = writerPidIsAlive(marker.pid);
  if (alive !== false) {
    throw new Error(
      "Package-store writer lock may still be active (pid " + marker.pid +
      "). Refusing to adopt it. Confirm the owner is gone before removing " + lockPath + ".",
    );
  }
  const lifecycle = readStoreLifecycle(root, readCatalog(root));
  const match = lifecycle.objects.find((object) =>
    (object.state === "intent" || object.state === "quarantined" || object.state === "removing") &&
    object.deletionIntent?.writerToken === marker.token);
  if (!match) {
    throw new Error(
      "Writer lock token does not match a durable in-progress deletion. Refusing to remove " +
      lockPath + ". This recovery does not clear unrelated or idle writer locks.",
    );
  }
  const again = readWriterMarker(root);
  if (again.token !== marker.token || again.pid !== marker.pid) {
    throw new Error("Writer lock changed while recovery checked it. Refusing to adopt it.");
  }
  const stillAlive = writerPidIsAlive(marker.pid);
  if (stillAlive !== false) {
    throw new Error("Package-store writer became active while recovery checked the lock. Refusing to adopt it.");
  }
  unlinkSync(lockPath);
}
async function advancePersistedDeletion(root: string, digest: string, now: string): Promise<void> {
  const load = () => {
    const lifecycle = readStoreLifecycle(root, readCatalog(root));
    const current = lifecycleObject(lifecycle, digest);
    if (!current) throw new Error("Deletion lifecycle record disappeared for " + digest + ".");
    return { lifecycle, current };
  };
  let { lifecycle, current } = load();
  if (current.state === "deleted") return;
  if (current.state === "ambiguous") throw new Error(current.ambiguity?.reason ?? "Deletion state is ambiguous.");
  if (current.state === "intent") {
    const presence = classifyPresence(root, digest);
    if (presence === "canonical") {
      moveCanonicalToTombstone(root, digest);
      consumeStoreGcFault("after-move");
    } else if (presence !== "tombstone") {
      const reason = presenceReason(presence);
      markAmbiguous(root, lifecycle, current, reason, now);
      throw new Error(reason);
    }
    ({ lifecycle, current } = load());
    if (current.state !== "intent" || !current.deletionClaim || !current.deletionIntent) {
      throw new Error("Deletion intent changed during quarantine.");
    }
    replaceLifecycleObject(lifecycle, {
      digest,
      state: "quarantined",
      createdAt: current.createdAt,
      updatedAt: now,
      deletionClaim: current.deletionClaim,
      deletionIntent: current.deletionIntent,
      tombstone: { name: digestHex(digest), movedAt: now },
    });
    writeStoreLifecycleAtomically(root, lifecycle);
  }
  ({ lifecycle, current } = load());
  if (current.state === "quarantined") {
    const presence = classifyPresence(root, digest);
    if (presence !== "tombstone") {
      const reason = presence === "neither"
        ? "Quarantine record has no tombstone. Refusing to record a completed deletion."
        : presence === "canonical" || presence === "both"
          ? "Quarantine record does not match a single tombstone. Refusing to delete the package object."
          : presenceReason("ambiguous");
      markAmbiguous(root, lifecycle, current, reason, now);
      throw new Error(reason);
    }
    if (!current.deletionClaim || !current.deletionIntent || !current.tombstone) {
      throw new Error("Quarantine record is missing its deletion intent.");
    }
    replaceLifecycleObject(lifecycle, {
      digest,
      state: "removing",
      createdAt: current.createdAt,
      updatedAt: now,
      deletionClaim: current.deletionClaim,
      deletionIntent: current.deletionIntent,
      tombstone: current.tombstone,
      removal: { startedAt: now },
    });
    writeStoreLifecycleAtomically(root, lifecycle);
  }
  ({ lifecycle, current } = load());
  if (current.state !== "removing") {
    throw new Error("Cannot advance deletion from state " + current.state + ".");
  }
  const presence = classifyPresence(root, digest);
  if (presence === "tombstone") {
    removeRegularTree(join(root, TOMBSTONE_DIRECTORY, digestHex(digest)));
    consumeStoreGcFault("after-bytes-removed");
  } else if (presence !== "neither") {
    const reason = presence === "canonical" || presence === "both"
      ? "Removal record exists while the canonical package object is still present. Refusing to delete it."
      : presenceReason("ambiguous");
    markAmbiguous(root, lifecycle, current, reason, now);
    throw new Error(reason);
  }
  const claimToken = current.deletionClaim?.token;
  if (!claimToken) throw new Error("Deletion record is missing its claim token.");
  ({ lifecycle, current } = load());
  if (current.state !== "removing") throw new Error("Deletion state changed while tombstone bytes were removed.");
  replaceLifecycleObject(lifecycle, {
    digest,
    state: "deleted",
    createdAt: current.createdAt,
    updatedAt: now,
    deletedAt: now,
    deletionRecord: { claimToken, deletedAt: now },
  });
  writeStoreLifecycleAtomically(root, lifecycle);
}
async function recheckFreshDeletion(
  root: string,
  digest: string,
  checked: { gracePeriodMs: number; now: Date },
): Promise<{ createdAt: string } | { skip: string }> {
  const catalog = readCatalog(root);
  const lifecycle = readStoreLifecycle(root, catalog);
  const roots = retentionRootsFor(root, lifecycle, digest);
  if (roots.length) return { skip: "Package object " + digest + " is still retained by: " + roots.join(", ") + "." };
  const current = lifecycleObject(lifecycle, digest);
  if (current && current.state !== "ready") {
    return { skip: "Package object " + digest + " is " + current.state + " and was not deleted." };
  }
  try {
    await verifyPackageObjectForDigest(root, digest, catalog);
    await measurePackageDirectory(assertStoreObjectParents(root, digest));
  } catch (error) {
    return { skip: error instanceof Error ? error.message : String(error) };
  }
  const path = assertStoreObjectParents(root, digest);
  const info = lstatSync(path);
  const createdAt = current?.createdAt ?? new Date(info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs).toISOString();
  const ageMs = Math.max(0, checked.now.getTime() - Date.parse(createdAt));
  if (ageMs < checked.gracePeriodMs) return { skip: "Package object " + digest + " has not reached its GC grace period." };
  return { createdAt };
}
async function commitFreshDeletion(
  root: string,
  digest: string,
  createdAt: string,
  now: string,
  claimToken: string,
): Promise<void> {
  consumeStoreGcFault("before-intent");
  const lifecycle = readStoreLifecycle(root, readCatalog(root));
  const writerToken = requireWriterToken(root);
  replaceLifecycleObject(lifecycle, {
    digest,
    state: "intent",
    createdAt,
    updatedAt: now,
    deletionClaim: { token: claimToken, pid: process.pid, createdAt: now },
    deletionIntent: { claimToken, writerToken, packageTreeDigest: digest, createdAt: now },
  });
  writeStoreLifecycleAtomically(root, lifecycle);
  consumeStoreGcFault("after-intent");
  await advancePersistedDeletion(root, digest, now);
}
/**
 * Deletes currently eligible objects under the writer gate.
 * A previous preview is not an authorization. Retention, grace, and digest are rechecked.
 * Catalog release rows are left in place.
 */
export async function applyLocalStoreGarbageCollection(
  storeDirectory: string,
  options: StoreGcCoordinationOptions = {},
): Promise<StoreGcApplyReport> {
  const checked = checkedGcOptions(options);
  return withLocalStoreWriteLock(storeDirectory, async (root) => {
    const inspected = await inspectLockedStore(root, checked);
    const deleted: string[] = [];
    const skipped: StoreGcApplyReport["skipped"] = inspected.reports
      .filter((report) => report.status !== "candidate")
      .map((report) => ({ digest: report.digest, status: report.status, reasons: report.reasons }));
    const now = checked.now.toISOString();
    for (const candidate of inspected.reports.filter((report) => report.status === "candidate")) {
      const decision = await recheckFreshDeletion(root, candidate.digest, checked);
      if ("skip" in decision) {
        skipped.push({ digest: candidate.digest, status: "rechecked", reasons: [decision.skip] });
        continue;
      }
      await commitFreshDeletion(root, candidate.digest, decision.createdAt, now, randomUUID());
      deleted.push(candidate.digest);
    }
    return {
      schema: "cgp.store-gc-apply/1",
      appliedAt: now,
      gracePeriodMs: checked.gracePeriodMs,
      deleted,
      skipped,
    };
  }, options.coordination);
}
/**
 * Applies one existing deletion claim exactly once. A wrong token does not delete.
 * The claim is revalidated under the writer gate before any bytes move.
 */
export async function applyClaimedPackageObjectDeletion(
  storeDirectory: string,
  digest: string,
  claimToken: string,
  options: StoreGcCoordinationOptions = {},
): Promise<{ digest: string; deleted: true }> {
  if (!isDigest(digest)) throw new Error("Invalid package-tree SHA-256 digest.");
  if (typeof claimToken !== "string" || claimToken.length < 16) throw new Error("A valid deletion claim token is required.");
  const checked = checkedGcOptions(options);
  return withLocalStoreWriteLock(storeDirectory, async (root) => {
    const catalog = readCatalog(root);
    const lifecycle = readStoreLifecycle(root, catalog);
    const current = lifecycleObject(lifecycle, digest);
    if (current?.state === "deleted") throw new Error("Package object was already deleted: " + digest);
    if (current?.state !== "deleting" || current.deletionClaim?.token !== claimToken) {
      throw new Error("Deletion claim token does not own the deleting package object.");
    }
    assertNoRetentionRoots(root, lifecycle, digest);
    await verifyPackageObjectForDigest(root, digest, catalog);
    await measurePackageDirectory(assertStoreObjectParents(root, digest));
    const path = assertStoreObjectParents(root, digest);
    const info = lstatSync(path);
    const createdAt = current.createdAt ?? new Date(info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs).toISOString();
    const ageMs = Math.max(0, checked.now.getTime() - Date.parse(createdAt));
    if (ageMs < checked.gracePeriodMs) throw new Error("Package object " + digest + " has not reached its GC grace period.");
    const now = checked.now.toISOString();
    await commitFreshDeletion(root, digest, createdAt, now, claimToken);
    return { digest, deleted: true as const };
  }, options.coordination);
}
/**
 * Resumes interrupted deletions from durable lifecycle state.
 * Idle deletion claims are not stolen. Unrelated writer locks are not removed.
 * Ambiguous object/tombstone pairs are recorded and left on disk.
 */
export async function recoverInterruptedStoreDeletions(
  storeDirectory: string,
  options: { now?: Date; coordination?: StoreCoordinationOptions } = {},
): Promise<StoreGcRecoveryReport> {
  const nowDate = options.now ?? new Date();
  if (!(nowDate instanceof Date) || !Number.isFinite(nowDate.getTime())) {
    throw new Error("GC recovery clock must be a valid Date.");
  }
  const now = nowDate.toISOString();
  const root = storeRoot(storeDirectory);
  if (existsByLstat(join(root, STORE_WRITER_LOCK))) adoptInactiveDeletionLock(root);
  return withLocalStoreWriteLock(storeDirectory, async (lockedRoot) => {
    const lifecycle = readStoreLifecycle(lockedRoot, readCatalog(lockedRoot));
    const completed: string[] = [];
    const unchanged: string[] = [];
    const ambiguous: Array<{ digest: string; reason: string }> = [];
    const refused: Array<{ digest: string; error: string }> = [];
    for (const object of [...lifecycle.objects].sort((a, b) => compareString(a.digest, b.digest))) {
      if (object.state === "ready" || object.state === "deleting") {
        unchanged.push(object.digest);
        continue;
      }
      if (object.state === "ambiguous") {
        ambiguous.push({ digest: object.digest, reason: object.ambiguity?.reason ?? "Deletion state is ambiguous." });
        continue;
      }
      if (object.state === "deleted") {
        const presence = classifyPresence(lockedRoot, object.digest);
        if (presence === "neither") {
          unchanged.push(object.digest);
          continue;
        }
        if (presence === "tombstone") {
          try {
            removeRegularTree(join(lockedRoot, TOMBSTONE_DIRECTORY, digestHex(object.digest)));
            completed.push(object.digest);
          } catch (error) {
            refused.push({ digest: object.digest, error: error instanceof Error ? error.message : String(error) });
          }
          continue;
        }
        const reason = presence === "both" || presence === "canonical"
          ? "A deleted record still has a canonical package object. Refusing to delete it."
          : presenceReason("ambiguous");
        const fresh = readStoreLifecycle(lockedRoot, readCatalog(lockedRoot));
        const current = lifecycleObject(fresh, object.digest) ?? object;
        markAmbiguous(lockedRoot, fresh, current, reason, now);
        ambiguous.push({ digest: object.digest, reason });
        continue;
      }
      try {
        await advancePersistedDeletion(lockedRoot, object.digest, now);
        completed.push(object.digest);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const fresh = readStoreLifecycle(lockedRoot, readCatalog(lockedRoot));
        const current = lifecycleObject(fresh, object.digest);
        if (current?.state === "ambiguous") ambiguous.push({ digest: object.digest, reason: current.ambiguity?.reason ?? message });
        else refused.push({ digest: object.digest, error: message });
      }
    }
    return { schema: "cgp.store-gc-recovery/1", recoveredAt: now, completed, unchanged, ambiguous, refused };
  }, options.coordination);
}
/**
 * Reports token-owned deletion claims and, only when asked, cancels one of them.
 *
 * This is not stale-owner recovery. A dead pid or an old timestamp is not proof that
 * the holder is gone, so those facts are ignored. `releasePackageObjectDeletionClaim`
 * is the holder's own release and requires the claim token.
 *
 * `cancelClaim` is administrative cancellation of that one digest. It revokes the
 * holder even if they still have the token. It does not sweep other claims and it
 * does not delete bytes. In-progress intent, quarantine, and removal records are left
 * for recovery. Ordinary reads never call this.
 */
export async function reconcileIdleDeletionClaims(
  storeDirectory: string,
  options: {
    now?: Date;
    digest?: string;
    cancelClaim?: string;
    coordination?: StoreCoordinationOptions;
  } = {},
): Promise<StoreGcReconcileReport> {
  if (options.digest !== undefined && !isDigest(options.digest)) throw new Error("Invalid package-tree SHA-256 digest.");
  if (options.cancelClaim !== undefined && !isDigest(options.cancelClaim)) {
    throw new Error("Invalid package-tree SHA-256 digest.");
  }
  if (options.cancelClaim !== undefined && options.digest !== undefined && options.cancelClaim !== options.digest) {
    throw new Error("cancelClaim and digest must name the same package object.");
  }
  const nowDate = options.now ?? new Date();
  if (!(nowDate instanceof Date) || !Number.isFinite(nowDate.getTime())) {
    throw new Error("GC reconcile clock must be a valid Date.");
  }
  const now = nowDate.toISOString();
  const retainedReason =
    "Deletion claim stays with its token owner. Reconcile is not stale-owner recovery and does not consult pid or age. " +
    "Release the claim with its token, or cancel that one claim explicitly.";
  return withLocalStoreWriteLock(storeDirectory, (root) => {
    const lifecycle = readStoreLifecycle(root, readCatalog(root));
    const cancelDigest = options.cancelClaim;
    if (cancelDigest) {
      const target = lifecycleObject(lifecycle, cancelDigest);
      if (target?.state !== "deleting") {
        throw new Error(
          "No token-owned deletion claim exists for " + cancelDigest +
          ". Administrative cancellation did not change other claims.",
        );
      }
    }
    const released: string[] = [];
    const retained: Array<{ digest: string; reason: string }> = [];
    const leftInProgress: string[] = [];
    for (const object of lifecycle.objects) {
      if (object.state === "intent" || object.state === "quarantined" || object.state === "removing" || object.state === "ambiguous") {
        leftInProgress.push(object.digest);
        continue;
      }
      if (object.state !== "deleting") continue;
      if (cancelDigest && object.digest === cancelDigest) {
        replaceLifecycleObject(lifecycle, {
          digest: object.digest,
          state: "ready",
          createdAt: object.createdAt,
          updatedAt: now,
        });
        released.push(object.digest);
        continue;
      }
      retained.push({ digest: object.digest, reason: retainedReason });
    }
    if (released.length > 0) writeStoreLifecycleAtomically(root, lifecycle);
    return { schema: "cgp.store-gc-reconcile/1", reconciledAt: now, released, retained, leftInProgress };
  }, options.coordination);
}
