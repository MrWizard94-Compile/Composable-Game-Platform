import { AsyncLocalStorage } from "node:async_hooks";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, opendirSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { platform as hostPlatform, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CLOSED_POLICY,
  CROSS_POLICY,
  IN_PROCESS_POLICY,
  compose,
  createCrossBackend,
  inProcessBackend,
  policyConflict,
  type CompositionResult,
  type ExecutionBackend,
  type ExecutionPolicy,
  type ModuleImplementation,
  type ModulePackage,
  type ShutdownReport,
} from "../foundations/index.ts";
import { createWasmBackend } from "../foundations/wasm-backend.ts";
import type { HostBudget, LogBudget } from "../foundations/wasm-backend.ts";
import {
  projectLockModules,
  snapshotProjectLock,
  snapshotWasmProjectLock,
  wasmLockPackageDigests,
} from "./project-lock.ts";
import {
  acquireCompositionLease,
  releaseCompositionLease,
  type LocalCatalogEntry,
} from "./local-store.ts";
import {
  validatePackagePaths,
  type PackageFile,
} from "./package-format.ts";

export type ProjectActivationBackendOptions = {
  maxHookMs?: number;
  maxMemoryBytes?: number;
  maxBinaryBytes?: number;
  host?: HostBudget;
  log?: Partial<LogBudget>;
};

export type ProjectActivationOptions = {
  /** Required project-wide cap for bytes read into the verified package snapshot. */
  maxSnapshotBytes: number;
  /** Human-readable Foundations profile name. Defaults to the lock's profileId. */
  profileName?: string;
  /**
   * Required before any javascript-esm package is imported.
   * This admits trusted in-process code. It does not sandbox JavaScript, and the
   * Wasm import allowlist does not apply to that code.
   */
  javascript?: "trusted-in-process";
  /**
   * Defaults to the closed policy for a Wasm-only project, `IN_PROCESS_POLICY` when
   * every package is JavaScript, and `CROSS_POLICY` when both runtimes are present.
   * A closed policy never imports JavaScript.
   */
  policy?: ExecutionPolicy;
  backendOptions?: ProjectActivationBackendOptions;
};

export type ProjectActivationModuleIdentity =
  Omit<
    Pick<
      LocalCatalogEntry,
      | "moduleId"
      | "version"
      | "packageTreeProfile"
      | "packageTreeDigest"
      | "artifactDigest"
      | "runtime"
      | "files"
    >,
    "files"
  > & {
    readonly files: readonly string[];
  };

export type ProjectActivation = {
  ok: boolean;
  profileId: string;
  totalSnapshotBytes: number;
  /** Exact locked release identities, in profile order. No paths or executable bytes. */
  modules: readonly ProjectActivationModuleIdentity[];
  composition: CompositionResult;
  /**
   * Shuts down Foundations, invalidates package resource views, disposes a Wasm backend
   * when one was created, removes the owned JavaScript copies, then releases the composition
   * lease. Each step is marked done only after it returns. A second call after every step
   * has succeeded returns `already: true`. A failed step rejects again until that step
   * succeeds. The source path is kept until removal returns. Resource views stay readable
   * through Foundations shutdown hooks and close only after that shutdown settles. The
   * lease is not reported released when release throws.
   */
  shutdown: () => Promise<ShutdownReport>;
  /** Store lease held until shutdown finishes. The release token is not exposed. */
  leaseId: string;
  /** Present only when the project contains JavaScript that the caller opted into. */
  javascriptTrust?: "trusted-in-process";
};

function publicIdentity(entry: LocalCatalogEntry): ProjectActivationModuleIdentity {
  return Object.freeze({
    moduleId: entry.moduleId,
    version: entry.version,
    packageTreeProfile: entry.packageTreeProfile,
    packageTreeDigest: entry.packageTreeDigest,
    artifactDigest: entry.artifactDigest,
    runtime: entry.runtime,
    files: Object.freeze([...entry.files]),
  });
}

function cleanupError(failures: unknown[], message: string): Error {
  const present = failures.filter((item) => item !== undefined);
  if (present.length > 1) return new AggregateError(present, message);
  return present[0] instanceof Error ? present[0] : new Error(message);
}

const JAVASCRIPT_OPT_IN =
  "Project activation refuses to import JavaScript until the caller opts in with javascript: \"trusted-in-process\". " +
  "JavaScript runs in this Node process and can use its filesystem, network, and operating-system access. " +
  "It is not sandboxed. A Wasm import allowlist does not cover it.";

const UNSUPPORTED_JS_CLEANUP =
  "Project activation cannot import JavaScript on this platform because activation source cleanup is not supported. " +
  "No composition lease was acquired and JavaScript was not imported.";

/**
 * Opaque view of one verified package tree.
 * `read` returns a copy. Nothing on this object is a store path, host directory, or file URL.
 */
export type PackageResourceView = {
  readonly packageTreeDigest: string;
  read(relativePath: string): Uint8Array;
  list(): readonly string[];
};

/**
 * Test-only failure injection. This is not a host API.
 * Values follow the calling async context so concurrent tests do not share them.
 */
export type ProjectActivationTestProbes = {
  beforeRemoveSources?: () => void;
  beforeDisposeBackend?: () => void;
  beforeCloseResources?: () => void;
  /** `false` refuses JavaScript import before a lease. Omit to use the host platform. */
  cleanupSupported?: boolean;
};

const probeStorage = new AsyncLocalStorage<ProjectActivationTestProbes>();

export function setProjectActivationTestProbes(next: ProjectActivationTestProbes | undefined): void {
  probeStorage.enterWith(next ?? {});
}

function probes(): ProjectActivationTestProbes {
  return probeStorage.getStore() ?? {};
}

const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

function systemCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function modeOctal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

/**
 * Owner write and execute are required before a directory is walked.
 * This stays in force when the process is root. CAP_DAC_OVERRIDE would
 * otherwise hide a permission change and let a later shutdown look finished.
 */
function assertDirectoryRemovable(label: string, mode: number): void {
  if ((mode & 0o200) !== 0 && (mode & 0o100) !== 0) return;
  throw new Error(
    "Activation source cleanup cannot remove " + label +
    " because its permissions (" + modeOctal(mode) + ") do not allow recursive removal.",
  );
}

function refuseSymlink(label: string): never {
  throw new Error("Activation source cleanup refuses to follow a symlink at " + label + ".");
}

function procDirectory(fd: number, name?: string): string {
  const base = "/proc/self/fd/" + String(fd);
  return name === undefined ? base : base + "/" + name;
}

/**
 * Deletes one activation-owned directory.
 *
 * The walk uses the directory file descriptor, not a path looked up again from
 * the filesystem root, and it never follows a symlink. A symlink entry is
 * unlinked. Its target is not opened and not deleted. This does not contain
 * trusted in-process JavaScript: that code can still copy bytes out, replace
 * this directory, or chmod it again after a successful retry.
 */
function removeDirectoryContents(fd: number, label: string): void {
  const listing = opendirSync(procDirectory(fd));
  const names: string[] = [];
  try {
    let entry = listing.readSync();
    while (entry !== null) {
      names.push(entry.name);
      entry = listing.readSync();
    }
  } finally {
    listing.closeSync();
  }
  for (const name of names) {
    if (name.length === 0 || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
      throw new Error("Activation source cleanup refuses an unsafe directory entry under " + label + ".");
    }
    const childLabel = label + "/" + name;
    const childPath = procDirectory(fd, name);
    let info;
    try {
      info = lstatSync(childPath);
    } catch (error) {
      if (systemCode(error) === "ENOENT") continue;
      throw error;
    }
    if (info.isSymbolicLink()) {
      unlinkSync(childPath);
      continue;
    }
    if (info.isDirectory()) {
      let childFd: number;
      try {
        childFd = openSync(childPath, DIRECTORY_OPEN_FLAGS);
      } catch (error) {
        const code = systemCode(error);
        if (code === "ELOOP" || code === "ENOTDIR") {
          unlinkSync(childPath);
          continue;
        }
        throw error;
      }
      try {
        const opened = fstatSync(childFd);
        if (!opened.isDirectory() || opened.dev !== info.dev || opened.ino !== info.ino) refuseSymlink(childLabel);
        assertDirectoryRemovable(childLabel, opened.mode);
        removeDirectoryContents(childFd, childLabel);
        const after = lstatSync(childPath);
        if (after.isSymbolicLink() || !after.isDirectory() || after.dev !== opened.dev || after.ino !== opened.ino) {
          refuseSymlink(childLabel);
        }
        rmdirSync(childPath);
      } finally {
        closeSync(childFd);
      }
      continue;
    }
    unlinkSync(childPath);
  }
}

function linuxFdCleanupAvailable(): boolean {
  return typeof constants.O_NOFOLLOW === "number" &&
    typeof constants.O_DIRECTORY === "number" &&
    existsSync("/proc/self/fd");
}

/**
 * Linux can remove an activation directory without following a symlink, including one
 * swapped in after the walk starts, because the walk stays on the opened directory fd.
 * Windows has neither `O_NOFOLLOW` nor `/proc/self/fd`. macOS has the open flags, but a
 * path under `/dev/fd/N` is not a reliable `openat`. Those two platforms use an `lstat`
 * walk that refuses symlink entries and a root path swapped for a symlink. That walk
 * does not close the inode race an fd walk closes. Other platforms cannot clean up an
 * owned JavaScript directory, so activation refuses the import before a lease.
 */
export function platformJavascriptCleanupSupported(host: NodeJS.Platform = hostPlatform()): boolean {
  if (host === "linux") return linuxFdCleanupAvailable();
  return host === "win32" || host === "darwin";
}

function javascriptCleanupAvailable(): boolean {
  if (probes().cleanupSupported === false) return false;
  return platformJavascriptCleanupSupported();
}

function removeLinuxOwnedDirectory(directory: string): void {
  if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_DIRECTORY !== "number") {
    throw new Error("Activation source cleanup requires O_NOFOLLOW and O_DIRECTORY.");
  }
  let fd: number;
  try {
    fd = openSync(directory, DIRECTORY_OPEN_FLAGS);
  } catch (error) {
    const code = systemCode(error);
    if (code === "ENOENT") return;
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(
        "Activation source cleanup cannot remove " + directory +
        " because its permissions do not allow recursive removal.",
      );
    }
    let info;
    try {
      info = lstatSync(directory);
    } catch {
      throw error;
    }
    if (info.isSymbolicLink()) refuseSymlink(directory);
    throw new Error("Activation source cleanup expected a directory at " + directory + ".");
  }
  try {
    const opened = fstatSync(fd);
    assertDirectoryRemovable(directory, opened.mode);
    const current = lstatSync(directory);
    if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== opened.dev || current.ino !== opened.ino) {
      refuseSymlink(directory);
    }
    removeDirectoryContents(fd, directory);
    const again = lstatSync(directory);
    if (again.isSymbolicLink() || !again.isDirectory() || again.dev !== opened.dev || again.ino !== opened.ino) {
      refuseSymlink(directory);
    }
    rmdirSync(directory);
  } finally {
    closeSync(fd);
  }
}

function sameOpenedIdentity(beforeDev: number, beforeIno: number, afterDev: number, afterIno: number): boolean {
  if (beforeIno === 0 || afterIno === 0) return true;
  return beforeDev === afterDev && beforeIno === afterIno;
}

function removeSymlinkEntry(targetPath: string, label: string): void {
  let info;
  try {
    info = lstatSync(targetPath);
  } catch (error) {
    if (systemCode(error) === "ENOENT") return;
    throw error;
  }
  if (!info.isSymbolicLink()) refuseSymlink(label);
  try {
    unlinkSync(targetPath);
    return;
  } catch (error) {
    const code = systemCode(error);
    if (code === "ENOENT") return;
    if (code !== "EPERM" && code !== "EISDIR" && code !== "EACCES") throw error;
  }
  let again;
  try {
    again = lstatSync(targetPath);
  } catch (error) {
    if (systemCode(error) === "ENOENT") return;
    throw error;
  }
  if (!again.isSymbolicLink()) refuseSymlink(label);
  rmdirSync(targetPath);
}

/**
 * Non-following removal for Windows and macOS.
 * A symlink is unlinked, or removed with a non-recursive `rmdir` when the platform
 * requires that for a directory link. The target is not opened. Readdir results are
 * discarded if the directory inode changed during the listing. This is not the Linux
 * fd walk: a swap that returns to the original inode during `readdir` is still a race.
 */
function removeTreeWithoutFollowing(directory: string): void {
  let before;
  try {
    before = lstatSync(directory);
  } catch (error) {
    if (systemCode(error) === "ENOENT") return;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isDirectory()) refuseSymlink(directory);
  const names = readdirSync(directory);
  let afterList;
  try {
    afterList = lstatSync(directory);
  } catch (error) {
    if (systemCode(error) === "ENOENT") return;
    throw error;
  }
  if (afterList.isSymbolicLink() || !afterList.isDirectory() ||
      !sameOpenedIdentity(before.dev, before.ino, afterList.dev, afterList.ino)) {
    refuseSymlink(directory);
  }
  for (const name of names) {
    if (name.length === 0 || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
      throw new Error("Activation source cleanup refuses an unsafe directory entry under " + directory + ".");
    }
    const child = join(directory, name);
    let info;
    try {
      info = lstatSync(child);
    } catch (error) {
      if (systemCode(error) === "ENOENT") continue;
      throw error;
    }
    if (info.isSymbolicLink()) {
      removeSymlinkEntry(child, child);
      continue;
    }
    if (info.isDirectory()) {
      if (hostPlatform() !== "win32") assertDirectoryRemovable(child, info.mode);
      removeTreeWithoutFollowing(child);
      let again;
      try {
        again = lstatSync(child);
      } catch (error) {
        if (systemCode(error) === "ENOENT") continue;
        throw error;
      }
      if (again.isSymbolicLink() || !again.isDirectory() ||
          !sameOpenedIdentity(info.dev, info.ino, again.dev, again.ino)) {
        refuseSymlink(child);
      }
      rmdirSync(child);
      continue;
    }
    if (hostPlatform() === "win32") {
      try { chmodSync(child, 0o666); } catch { /* unlink reports the real failure */ }
    }
    unlinkSync(child);
  }
}

function removeWithoutFollowing(directory: string): void {
  let info;
  try {
    info = lstatSync(directory);
  } catch (error) {
    if (systemCode(error) === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink()) refuseSymlink(directory);
  if (!info.isDirectory()) {
    throw new Error("Activation source cleanup expected a directory at " + directory + ".");
  }
  if (hostPlatform() !== "win32") assertDirectoryRemovable(directory, info.mode);
  removeTreeWithoutFollowing(directory);
  let again;
  try {
    again = lstatSync(directory);
  } catch (error) {
    if (systemCode(error) === "ENOENT") return;
    throw error;
  }
  if (again.isSymbolicLink() || !again.isDirectory() ||
      !sameOpenedIdentity(info.dev, info.ino, again.dev, again.ino)) {
    refuseSymlink(directory);
  }
  rmdirSync(directory);
}

function removeOwnedActivationDirectory(directory: string): void {
  if (hostPlatform() === "linux") {
    if (!linuxFdCleanupAvailable()) {
      throw new Error("Activation source cleanup requires O_NOFOLLOW, O_DIRECTORY, and /proc/self/fd.");
    }
    removeLinuxOwnedDirectory(directory);
    return;
  }
  if (hostPlatform() === "win32" || hostPlatform() === "darwin") {
    removeWithoutFollowing(directory);
    return;
  }
  throw new Error("Activation source cleanup is not supported on " + hostPlatform() + ".");
}

function exactPackagePath(path: string): boolean {
  return typeof path === "string" && validatePackagePaths([path]).length === 0;
}

function openPackageResources(packageTreeDigest: string, files: readonly PackageFile[]): {
  view: PackageResourceView;
  close(): void;
} {
  const retained = new Map<string, Uint8Array>();
  const paths: string[] = [];
  for (const file of files) {
    retained.set(file.path, file.bytes);
    paths.push(file.path);
  }
  const listed = Object.freeze(paths.slice());
  let open = true;
  const view: PackageResourceView = Object.freeze({
    packageTreeDigest,
    read(path: string): Uint8Array {
      if (!open) throw new Error("Package resources are closed.");
      if (!exactPackagePath(path)) throw new Error("Package resource path is not an exact package path.");
      const bytes = retained.get(path);
      if (bytes === undefined) throw new Error("Package resource is not in this snapshot.");
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return copy;
    },
    list(): readonly string[] {
      if (!open) throw new Error("Package resources are closed.");
      return listed;
    },
  });
  return {
    view,
    close() {
      if (!open) return;
      open = false;
      retained.clear();
    },
  };
}

async function bindPackageResources(implementation: ModuleImplementation, view: PackageResourceView): Promise<void> {
  const opener = (implementation as ModuleImplementation & {
    openResources?: (resources: PackageResourceView) => void | Promise<void>;
  }).openResources;
  if (typeof opener !== "function") return;
  await opener.call(implementation, view);
}

async function loadOwnedJavaScript(
  sourceRoot: string,
  index: number,
  moduleId: string,
  bytes: Uint8Array,
): Promise<ModuleImplementation> {
  const file = join(sourceRoot, index + ".mjs");
  writeFileSync(file, bytes, { mode: 0o400 });
  let imported: { implementation?: ModuleImplementation };
  try {
    imported = (await import(pathToFileURL(file).href)) as { implementation?: ModuleImplementation };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error("JavaScript import failed for " + moduleId + ": " + detail);
  }
  const implementation = imported.implementation;
  if (!implementation || typeof implementation !== "object") {
    throw new Error("JavaScript module " + moduleId + " did not export implementation.");
  }
  if (implementation.wasm instanceof Uint8Array) {
    throw new Error(
      "JavaScript module " + moduleId + " exported Wasm bytes. Refusing to treat trusted in-process code as a guest.",
    );
  }
  return implementation;
}

/**
 * Activates an exact project lock on Node.
 *
 * JavaScript-only, Wasm-only, and mixed locks are all accepted. Verification of every
 * locked package finishes before the first JavaScript import and before any guest starts.
 * A composition lease covers the whole set from before the snapshot until shutdown.
 * JavaScript is trusted in-process code and is loaded only from bytes this function
 * snapshotted, never from a path stored in the lockfile. Importing it can run top-level
 * code that this host cannot roll back. Wasm guests stay on `wasm-isolate`. A mixed
 * project uses the existing cross backend and is not one sandbox.
 */
export async function activateProject(
  storeDirectory: string,
  profileInput: unknown,
  lockInput: unknown,
  options: ProjectActivationOptions,
): Promise<ProjectActivation> {
  return runProjectActivation(storeDirectory, profileInput, lockInput, options, "project");
}

/** Wasm-only entry used by the existing activation API. JavaScript is refused before a lease. */
export async function activateWasmProject(
  storeDirectory: string,
  profileInput: unknown,
  lockInput: unknown,
  options: ProjectActivationOptions,
): Promise<ProjectActivation> {
  return runProjectActivation(storeDirectory, profileInput, lockInput, options, "wasm-only");
}

async function runProjectActivation(
  storeDirectory: string,
  profileInput: unknown,
  lockInput: unknown,
  options: ProjectActivationOptions,
  mode: "project" | "wasm-only",
): Promise<ProjectActivation> {
  if (options.javascript !== undefined && options.javascript !== "trusted-in-process") {
    throw new Error(JAVASCRIPT_OPT_IN);
  }
  const selected = mode === "wasm-only"
    ? null
    : projectLockModules(storeDirectory, profileInput, lockInput);
  const digests = mode === "wasm-only"
    ? wasmLockPackageDigests(storeDirectory, profileInput, lockInput)
    : selected!.map((entry) => entry.packageTreeDigest);
  const hasJs = selected?.some((entry) => entry.runtime === "javascript-esm") ?? false;
  const hasWasm = mode === "wasm-only" || (selected?.some((entry) => entry.runtime === "wasm-core") ?? false);
  if (hasJs && options.javascript !== "trusted-in-process") throw new Error(JAVASCRIPT_OPT_IN);
  if (digests.length === 0) throw new Error("A project activation requires at least one locked package.");

  const policy = options.policy ?? (hasJs && hasWasm ? CROSS_POLICY : hasJs ? IN_PROCESS_POLICY : CLOSED_POLICY);
  const wasmBackend = hasWasm ? createWasmBackend(options.backendOptions) : undefined;
  const backend: ExecutionBackend = wasmBackend && hasJs
    ? createCrossBackend(wasmBackend)
    : wasmBackend ?? inProcessBackend;
  const admitJavaScript = hasJs && policyConflict(backend, policy) === undefined;
  const disposeWasm = async () => { if (wasmBackend) await wasmBackend.dispose(); };
  const disposeBackend = async () => {
    probes().beforeDisposeBackend?.();
    await disposeWasm();
  };
  if (admitJavaScript && !javascriptCleanupAvailable()) {
    try {
      await disposeWasm();
    } catch (error) {
      throw cleanupError(
        [new Error(UNSUPPORTED_JS_CLEANUP), error],
        "Project activation failed and its backend cleanup also failed.",
      );
    }
    throw new Error(UNSUPPORTED_JS_CLEANUP);
  }

  const lease = await acquireCompositionLease(storeDirectory, digests);
  const releaseLease = () => releaseCompositionLease(storeDirectory, lease.leaseId, lease.token);
  let sourceRoot: string | undefined;
  const sessions: Array<{ close(): void }> = [];
  const closeResources = () => {
    if (sessions.length === 0) return;
    probes().beforeCloseResources?.();
    for (const session of sessions) session.close();
  };
  const removeSources = () => {
    const path = sourceRoot;
    if (path === undefined) return;
    probes().beforeRemoveSources?.();
    removeOwnedActivationDirectory(path);
    sourceRoot = undefined;
  };
  const releaseAcquired = async (): Promise<{ resources?: unknown; dispose?: unknown; source?: unknown; lease?: unknown }> => {
    const failures: { resources?: unknown; dispose?: unknown; source?: unknown; lease?: unknown } = {};
    try { closeResources(); } catch (error) { failures.resources = error; }
    try { await disposeBackend(); } catch (error) { failures.dispose = error; }
    try { removeSources(); } catch (error) { failures.source = error; }
    try { await releaseLease(); } catch (error) { failures.lease = error; }
    return failures;
  };

  let snapshot;
  try {
    if (mode === "wasm-only") {
      const wasmSnapshot = await snapshotWasmProjectLock(
        storeDirectory,
        profileInput,
        lockInput,
        options.maxSnapshotBytes,
      );
      snapshot = {
        lock: wasmSnapshot.lock,
        totalBytes: wasmSnapshot.totalBytes,
        modules: wasmSnapshot.modules.map((module) => ({
          entry: module.entry,
          manifest: module.manifest,
          artifactBytes: module.wasmBytes,
          packageBytes: module.packageBytes,
        })),
      };
    } else {
      snapshot = await snapshotProjectLock(
        storeDirectory,
        profileInput,
        lockInput,
        options.maxSnapshotBytes,
      );
    }
  } catch (error) {
    const failures = await releaseAcquired();
    const present = [failures.resources, failures.dispose, failures.source, failures.lease].filter((item) => item !== undefined);
    if (present.length > 0) {
      throw cleanupError(
        [error, ...present],
        failures.lease !== undefined
          ? "Project activation failed and its composition lease was not released."
          : failures.dispose !== undefined
            ? "Project activation failed and its backend cleanup also failed."
            : "Project activation failed while cleaning up a JavaScript import.",
      );
    }
    throw error;
  }

  let packages: ModulePackage[];
  try {
    if (admitJavaScript) sourceRoot = mkdtempSync(join(tmpdir(), "cgp-project-activation-"));
    packages = [];
    for (let index = 0; index < snapshot.modules.length; index += 1) {
      const module = snapshot.modules[index]!;
      if (module.entry.runtime === "wasm-core") {
        packages.push({ manifest: module.manifest, implementation: { wasm: module.artifactBytes } });
        continue;
      }
      if (!admitJavaScript) {
        packages.push({ manifest: module.manifest });
        continue;
      }
      const files = (module as { files?: readonly PackageFile[] }).files;
      if (!files) throw new Error("JavaScript activation is missing its verified package snapshot.");
      const session = openPackageResources(module.entry.packageTreeDigest, files);
      sessions.push(session);
      const implementation = await loadOwnedJavaScript(sourceRoot!, index, module.entry.moduleId, module.artifactBytes);
      await bindPackageResources(implementation, session.view);
      packages.push({ manifest: module.manifest, implementation });
    }
  } catch (error) {
    const failures = await releaseAcquired();
    const present = [failures.resources, failures.source, failures.dispose, failures.lease].filter((item) => item !== undefined);
    if (present.length > 0) {
      throw cleanupError(
        [error, ...present],
        failures.lease !== undefined
          ? "Project activation failed and its composition lease was not released."
          : "Project activation failed while cleaning up a JavaScript import.",
      );
    }
    throw error;
  }

  let composition: CompositionResult;
  try {
    composition = await compose(packages, {
      profileName: options.profileName ?? snapshot.lock.profileId,
      backend,
      policy,
    });
  } catch (error) {
    const failures = await releaseAcquired();
    const present = [failures.resources, failures.source, failures.dispose, failures.lease].filter((item) => item !== undefined);
    if (present.length > 0) {
      throw cleanupError(
        [error, ...present],
        failures.lease !== undefined
          ? "Project activation failed and its composition lease was not released."
          : failures.dispose !== undefined
            ? "Project activation failed and its backend cleanup also failed."
            : "Project activation failed while cleaning up a JavaScript import.",
      );
    }
    throw error;
  }

  const foundationsShutdown = composition.shutdown;
  let foundationsDone = false;
  let resourcesDone = false;
  let disposeDone = false;
  let sourcesDone = false;
  let leaseDone = false;
  let report: ShutdownReport | undefined;
  let inFlight: Promise<ShutdownReport> | undefined;
  const shutdown = (): Promise<ShutdownReport> => {
    if (foundationsDone && resourcesDone && disposeDone && sourcesDone && leaseDone && report) {
      return Promise.resolve({ already: true, order: [], diagnostics: [] });
    }
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const failures: unknown[] = [];
      if (!foundationsDone) {
        try {
          report = await foundationsShutdown();
          foundationsDone = true;
        } catch (error) { failures.push(error); }
      }
      if (!resourcesDone) {
        try {
          closeResources();
          resourcesDone = true;
        } catch (error) { failures.push(error); }
      }
      if (!disposeDone) {
        try {
          await disposeBackend();
          disposeDone = true;
        } catch (error) { failures.push(error); }
      }
      if (!sourcesDone) {
        try {
          removeSources();
          sourcesDone = true;
        } catch (error) { failures.push(error); }
      }
      if (!leaseDone) {
        try {
          await releaseLease();
          leaseDone = true;
        } catch (error) { failures.push(error); }
      }
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          "Project activation shutdown failed while releasing the runtime or composition lease.",
        );
      }
      if (failures.length === 1) throw failures[0];
      if (!report) throw new Error("Foundations shutdown completed without a shutdown report.");
      return report;
    })().finally(() => { inFlight = undefined; });
    return inFlight;
  };

  composition.shutdown = shutdown;
  const activation: ProjectActivation = Object.freeze({
    ok: composition.ok && composition.runtimeActive,
    profileId: snapshot.lock.profileId,
    totalSnapshotBytes: snapshot.totalBytes,
    modules: Object.freeze(snapshot.modules.map((module) => publicIdentity(module.entry))),
    composition,
    shutdown,
    leaseId: lease.leaseId,
    ...(hasJs && options.javascript === "trusted-in-process" ? { javascriptTrust: "trusted-in-process" as const } : {}),
  });

  if (!activation.ok) {
    try {
      await shutdown();
    } catch (cleanup) {
      throw cleanupError(
        [new Error("Project activation failed before the runtime stayed active."), cleanup],
        "Project activation failed and its cleanup also failed.",
      );
    }
  }
  return activation;
}
