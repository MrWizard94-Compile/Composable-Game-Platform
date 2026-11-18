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
  wasmLockPackageDigests,
} from "./project-lock.ts";
import {
  acquireCompositionLease,
  releaseCompositionLease,
  type LocalCatalogEntry,
} from "./local-store.ts";

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

export type WasmActivationModuleIdentity =
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

export type WasmProjectActivation = {
  ok: boolean;
  profileId: string;
  totalSnapshotBytes: number;
  /** Exact locked release identities, in profile order. No paths or executable bytes. */
  modules: readonly WasmActivationModuleIdentity[];
  /** The existing Foundations composition result. Its shutdown is wrapped to dispose the backend and release the lease. */
  composition: CompositionResult;
  /** Idempotently shuts down Foundations, disposes the Node Wasm backend, and releases the store lease. */
  shutdown: () => Promise<ShutdownReport>;
  /** Store lease held until shutdown finishes. The release token is not exposed. */
  leaseId: string;
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

function cleanupError(primary: unknown, cleanup: unknown, message: string): AggregateError {
  return new AggregateError([primary, cleanup], message);
}

/**
 * Activates an exact, verified, Wasm-only project lock through the existing Foundations lifecycle.
 *
 * A composition lease is written before the package snapshot is taken and is released only
 * after Foundations shutdown and backend disposal finish, including when activation fails.
 * The snapshot still copies Wasm bytes into memory. The lease is what stops GC from
 * quarantining those objects while the composition is live. JavaScript packages are refused
 * before a lease or a runtime is created.
 *
 * This is a one-shot composition owner, not a global active-generation manager. The caller
 * must await shutdown() when finished.
 */
export async function activateWasmProject(
  storeDirectory: string,
  profileInput: unknown,
  lockInput: unknown,
  options: WasmProjectActivationOptions,
): Promise<WasmProjectActivation> {
  const digests = wasmLockPackageDigests(storeDirectory, profileInput, lockInput);
  const lease = await acquireCompositionLease(storeDirectory, digests);
  const releaseLease = () => releaseCompositionLease(storeDirectory, lease.leaseId, lease.token);

  let snapshot;
  try {
    snapshot = await snapshotWasmProjectLock(
      storeDirectory,
      profileInput,
      lockInput,
      options.maxSnapshotBytes,
    );
  } catch (error) {
    try {
      await releaseLease();
    } catch (cleanup) {
      throw cleanupError(error, cleanup, "Wasm project activation failed and its composition lease was not released.");
    }
    throw error;
  }

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
    let disposeError: unknown;
    try {
      await backend.dispose();
    } catch (cleanup) {
      disposeError = cleanup;
    }
    let leaseError: unknown;
    try {
      await releaseLease();
    } catch (cleanup) {
      leaseError = cleanup;
    }
    const failures = [error, disposeError, leaseError].filter((item) => item !== undefined);
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        leaseError !== undefined
          ? "Wasm project activation failed and its composition lease was not released."
          : "Wasm project activation failed and its backend cleanup also failed.",
      );
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
      let disposeError: unknown;
      let leaseError: unknown;
      try {
        report = await foundationsShutdown();
      } catch (error) {
        primaryError = error;
      }
      try {
        await backend.dispose();
      } catch (error) {
        disposeError = error;
      }
      try {
        await releaseLease();
      } catch (error) {
        leaseError = error;
      }
      const failures = [primaryError, disposeError, leaseError].filter((error) => error !== undefined);
      if (failures.length > 1) {
        throw new AggregateError(failures, "Wasm activation shutdown failed while releasing the runtime or composition lease.");
      }
      if (failures.length === 1) throw failures[0];
      if (!report) throw new Error("Foundations shutdown completed without a shutdown report.");
      return report;
    })();

    return shutdownPromise;
  };

  composition.shutdown = shutdown;
  const identities = Object.freeze(snapshot.modules.map((module) => publicIdentity(module.entry)));
  const activation: WasmProjectActivation = Object.freeze({
    ok: composition.ok && composition.runtimeActive,
    profileId: snapshot.lock.profileId,
    totalSnapshotBytes: snapshot.totalBytes,
    modules: identities,
    composition,
    shutdown,
    leaseId: lease.leaseId,
  });

  if (!activation.ok) await shutdown();
  return activation;
}
