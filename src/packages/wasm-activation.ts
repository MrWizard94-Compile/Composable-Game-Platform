import {
  CLOSED_POLICY,
  compose,
  type CompositionResult,
  type ExecutionPolicy,
  type ModulePackage,
  type ShutdownReport,
} from "../foundations/index.ts";
import { createWasmBackend } from "../foundations/wasm-backend.ts";
import type { HostBudget, LogBudget } from "../foundations/wasm-backend.ts";
import {
  snapshotWasmProjectLock,
  type ProjectLock,
} from "./project-lock.ts";
import type { LocalCatalogEntry } from "./local-store.ts";

export type WasmActivationBackendOptions = {
  maxHookMs?: number;
  maxMemoryBytes?: number;
  maxBinaryBytes?: number;
  host?: HostBudget;
  log?: Partial<LogBudget>;
};

export type WasmProjectActivationOptions = {
  /** Required project-wide cap for bytes read into the verified package snapshot. */
  maxSnapshotBytes: number;
  /** Human-readable Foundations profile name. Defaults to the lock's profileId. */
  profileName?: string;
  /** Defaults to the closed policy. The Wasm backend still enforces every requested limit. */
  policy?: ExecutionPolicy;
  /** Options for the Node worker backend. Capability grants are supplied through policy. */
  backendOptions?: WasmActivationBackendOptions;
};

export type WasmActivationModuleIdentity = Pick<
  LocalCatalogEntry,
  | "moduleId"
  | "version"
  | "packageTreeProfile"
  | "packageTreeDigest"
  | "artifactDigest"
  | "runtime"
  | "files"
>;

export type WasmProjectActivation = {
  ok: boolean;
  profileId: string;
  totalSnapshotBytes: number;
  /** Exact locked release identities, in profile order. No paths or executable bytes. */
  modules: readonly WasmActivationModuleIdentity[];
  /** The existing Foundations composition result. Its shutdown is wrapped to dispose the backend. */
  composition: CompositionResult;
  /** Idempotently shuts down Foundations and disposes the Node Wasm backend. */
  shutdown: () => Promise<ShutdownReport>;
};

function publicIdentity(entry: LocalCatalogEntry): WasmActivationModuleIdentity {
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

function cleanupError(primary: unknown, cleanup: unknown): AggregateError {
  return new AggregateError(
    [primary, cleanup],
    "Wasm project activation failed and its backend cleanup also failed.",
  );
}

/**
 * Activates an exact, verified, Wasm-only project lock through the existing Foundations lifecycle.
 *
 * Snapshot verification completes before a backend is created or compose() is called. The
 * operation never imports JavaScript, resolves alternate versions, opens a browser runtime,
 * or loads modules from arbitrary paths after snapshot creation.
 *
 * This is a one-shot composition owner, not a global active-generation manager. The caller
 * must await shutdown() when finished. Destructive store maintenance concurrent with snapshot
 * creation is not supported until a store reader/GC coordination protocol exists.
 */
export async function activateWasmProject(
  storeDirectory: string,
  profileInput: unknown,
  lockInput: unknown,
  options: WasmProjectActivationOptions,
): Promise<WasmProjectActivation> {
  const snapshot = await snapshotWasmProjectLock(
    storeDirectory,
    profileInput,
    lockInput,
    options.maxSnapshotBytes,
  );

  const packages: ModulePackage[] = snapshot.modules.map((module) => ({
    manifest: module.manifest,
    implementation: { wasm: module.wasmBytes },
  }));

  const backend = createWasmBackend(options.backendOptions);
  let composition: CompositionResult;
  try {
    composition = await compose(packages, {
      profileName: options.profileName ?? snapshot.lock.profileId,
      backend,
      policy: options.policy ?? CLOSED_POLICY,
    });
  } catch (error) {
    try {
      await backend.dispose();
    } catch (cleanup) {
      throw cleanupError(error, cleanup);
    }
    throw error;
  }

  const foundationsShutdown = composition.shutdown;
  let shutdownPromise: Promise<ShutdownReport> | undefined;
  const shutdown = (): Promise<ShutdownReport> => {
    if (shutdownPromise) {
      return shutdownPromise.then(() => ({
        already: true,
        order: [],
        diagnostics: [],
      }));
    }

    shutdownPromise = (async () => {
      let report: ShutdownReport | undefined;
      let primaryError: unknown;
      try {
        report = await foundationsShutdown();
      } catch (error) {
        primaryError = error;
      }

      try {
        await backend.dispose();
      } catch (cleanup) {
        if (primaryError !== undefined) throw cleanupError(primaryError, cleanup);
        throw cleanup;
      }

      if (primaryError !== undefined) throw primaryError;
      if (!report) throw new Error("Foundations shutdown completed without a shutdown report.");
      return report;
    })();

    return shutdownPromise;
  };

  // Keep both access paths under the same cleanup owner. Callers cannot accidentally
  // shut down Foundations while leaving the package activation backend undisposed.
  composition.shutdown = shutdown;

  const identities = Object.freeze(snapshot.modules.map((module) => publicIdentity(module.entry)));
  const activation: WasmProjectActivation = Object.freeze({
    ok: composition.ok && composition.runtimeActive,
    profileId: snapshot.lock.profileId,
    totalSnapshotBytes: snapshot.totalBytes,
    modules: identities,
    composition,
    shutdown,
  });

  // A failed compose has already rolled back its session. Dispose the now-unused backend
  // immediately rather than relying on callers to invoke shutdown on an inactive result.
  if (!activation.ok) await shutdown();

  return activation;
}
