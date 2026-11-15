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
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

function acquireLock(root: string): { release(): void } {
  const lockPath = join(root, ".cgp-store.lock");
  const token = randomUUID();
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        "Store is locked by another writer or a stale lock exists: " + lockPath +
        ". Verify no store operation is active before manually removing a stale lock.",
      );
    }
    throw error;
  }
  try {
    writeFileSync(descriptor, JSON.stringify({
      schema: "cgp.local-store-lock/1",
      token,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    }) + "\n");
    fsyncSync(descriptor);
  } catch (error) {
    try { closeSync(descriptor); } catch {}
    try { unlinkSync(lockPath); } catch {}
    throw error;
  }
  closeSync(descriptor);
  return {
    release() {
      if (!existsSync(lockPath)) return;
      const parsed = parseStrictJson(new Uint8Array(readFileSync(lockPath)), "store lock");
      if (!parsed.ok || !isRecord(parsed.value) || parsed.value.token !== token) {
        throw new Error("Store lock ownership changed; refusing to remove a lock not owned by this operation.");
      }
      unlinkSync(lockPath);
    },
  };
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
  const root = storeRoot(storeDirectory);
  const stagingPath = resolve(stagingDirectory);
  const lock = acquireLock(root);
  try {
    const staged = await validateReleasePackageDirectory(stagingPath);
    if (!staged.ok) throw new Error("Staging package validation failed: " + staged.errors.join("; "));
    const stagingCanonical = realpathSync(stagingPath);
    if (isWithin(root, stagingCanonical) || isWithin(stagingCanonical, root)) {
      throw new Error("Staging directory and content-store root must not overlap.");
    }
    const entry = toCatalogEntry(staged.package);
    const catalog = readCatalog(root);
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
        try {
          chmodSync(temporary, 0o755);
        } catch {}
        rmSync(temporary, { recursive: true, force: true });
        throw error;
      }
    }
    const afterStage = await validateReleasePackageDirectory(stagingPath);
    if (!afterStage.ok || !summariesMatch(staged.package, afterStage.package)) {
      throw new Error("Staging directory changed during registration; catalog was not updated.");
    }
    if (!existingCoordinate) {
      const entries = sortEntries([...catalog.entries, entry]);
      writeCatalogAtomically(root, { schema: CATALOG_SCHEMA, entries });
      idempotent = false;
    }
    return { entry, objectDirectory: target, idempotent };
  } finally {
    lock.release();
  }
}

/** Returns the validated local catalog. Missing catalog is an empty catalog. */
export function readLocalCatalog(storeDirectory: string): LocalCatalog {
  const root = storeRoot(storeDirectory);
  return readCatalog(root);
}

/** Resolves an exact immutable coordinate and verifies its stored bytes before returning the object path. */
export async function resolveLocalPackage(
  storeDirectory: string,
  moduleId: string,
  version: string,
): Promise<{ entry: LocalCatalogEntry; objectDirectory: string } | undefined> {
  const root = storeRoot(storeDirectory);
  const catalog = readCatalog(root);
  const entry = catalog.entries.find((item) => item.moduleId === moduleId && item.version === version);
  if (!entry) return undefined;
  const path = assertStoreObjectParents(root, entry.packageTreeDigest);
  const result = await validateReleasePackageDirectory(path);
  if (!result.ok) throw new Error("Stored package failed validation: " + result.errors.join("; "));
  if (JSON.stringify(toCatalogEntry(result.package)) !== JSON.stringify(entry)) {
    throw new Error("Stored object metadata or digests disagree with the catalog record.");
  }
  return { entry, objectDirectory: path };
}

/** Revalidates every catalog-referenced object and compares it to its catalog record. */
export async function verifyLocalStore(storeDirectory: string): Promise<StoreVerification> {
  const root = storeRoot(storeDirectory);
  const catalog = readCatalog(root);
  const errors: StoreVerification["errors"] = [];
  let valid = 0;
  for (const entry of catalog.entries) {
    let path = objectDirectory(root, entry.packageTreeDigest);
    try {
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
}
