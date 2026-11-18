import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
   * Shuts down Foundations, disposes a Wasm backend when one was created, removes the
   * owned JavaScript copies, then releases the composition lease. A second successful
   * call returns `already: true`. A failed cleanup rejects again until the unfinished
   * step succeeds, and it never reports the lease as released when release threw.
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

  const lease = await acquireCompositionLease(storeDirectory, digests);
  const releaseLease = () => releaseCompositionLease(storeDirectory, lease.leaseId, lease.token);
  let sourceRoot: string | undefined;
  const removeSources = () => {
    if (!sourceRoot) return;
    const path = sourceRoot;
    sourceRoot = undefined;
    rmSync(path, { recursive: true, force: true });
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
    let leaseError: unknown;
    try { await releaseLease(); } catch (cleanup) { leaseError = cleanup; }
    if (leaseError !== undefined) {
      throw cleanupError(
        [error, leaseError],
        "Project activation failed and its composition lease was not released.",
      );
    }
    throw error;
  }

  const policy = options.policy ?? (hasJs && hasWasm ? CROSS_POLICY : hasJs ? IN_PROCESS_POLICY : CLOSED_POLICY);
  const wasmBackend = hasWasm ? createWasmBackend(options.backendOptions) : undefined;
  const backend: ExecutionBackend = wasmBackend && hasJs
    ? createCrossBackend(wasmBackend)
    : wasmBackend ?? inProcessBackend;
  const disposeBackend = async () => { if (wasmBackend) await wasmBackend.dispose(); };
  const admitJavaScript = hasJs && policyConflict(backend, policy) === undefined;

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
      packages.push({
        manifest: module.manifest,
        implementation: await loadOwnedJavaScript(sourceRoot!, index, module.entry.moduleId, module.artifactBytes),
      });
    }
  } catch (error) {
    let sourceError: unknown;
    let disposeError: unknown;
    let leaseError: unknown;
    try { removeSources(); } catch (cleanup) { sourceError = cleanup; }
    try { await disposeBackend(); } catch (cleanup) { disposeError = cleanup; }
    try { await releaseLease(); } catch (cleanup) { leaseError = cleanup; }
    const message = leaseError !== undefined
      ? "Project activation failed and its composition lease was not released."
      : "Project activation failed while cleaning up a JavaScript import.";
    if (sourceError !== undefined || disposeError !== undefined || leaseError !== undefined) {
      throw cleanupError([error, sourceError, disposeError, leaseError], message);
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
    let sourceError: unknown;
    let disposeError: unknown;
    let leaseError: unknown;
    try { removeSources(); } catch (cleanup) { sourceError = cleanup; }
    try { await disposeBackend(); } catch (cleanup) { disposeError = cleanup; }
    try { await releaseLease(); } catch (cleanup) { leaseError = cleanup; }
    const message = leaseError !== undefined
      ? "Project activation failed and its composition lease was not released."
      : disposeError !== undefined
        ? "Project activation failed and its backend cleanup also failed."
        : "Project activation failed while cleaning up a JavaScript import.";
    if (sourceError !== undefined || disposeError !== undefined || leaseError !== undefined) {
      throw cleanupError([error, sourceError, disposeError, leaseError], message);
    }
    throw error;
  }

  const foundationsShutdown = composition.shutdown;
  let foundationsDone = false;
  let disposeDone = false;
  let sourcesDone = false;
  let leaseDone = false;
  let report: ShutdownReport | undefined;
  let inFlight: Promise<ShutdownReport> | undefined;
  const shutdown = (): Promise<ShutdownReport> => {
    if (foundationsDone && disposeDone && sourcesDone && leaseDone && report) {
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
