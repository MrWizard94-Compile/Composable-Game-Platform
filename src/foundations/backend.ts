import { isCallablePayload } from "./slots.ts";
import { runInSaveZone } from "./save-zone.ts";

/**
 * The only way the host runs a module hook or a slot payload.
 * Foundations do not call module functions themselves.
 *
 * A backend lists the grants it cannot take away. The in-process backend
 * cannot revoke filesystem, network, or operating-system access, and it
 * cannot enforce a time or memory limit. A policy that does not allow those
 * grants, or that sets a limit, refuses that backend before any hook runs.
 */

export const HOST_GRANTS = ["filesystem", "network", "os"] as const;

export type HostGrant = (typeof HOST_GRANTS)[number];

export type ExecutionPolicy = {
  allowGrants: readonly HostGrant[];
  maxHookMs?: number;
  /** Declared linear-memory maximum for one guest. Not the binary size. */
  maxMemoryBytes?: number;
  /** One guest's WebAssembly binary. Not the linear-memory maximum and not the composition sum. */
  maxBinaryBytes?: number;
  /** Imports an isolating backend may link. The in-process backend cannot enforce these. */
  allowCapabilities?: readonly string[];
  /**
   * Aggregate budgets. Only an isolating backend enforces them.
   * Unset means unlimited. They are per composition, not per backend.
   */
  maxGuests?: number;
  maxTotalMemoryBytes?: number;
  maxTotalBinaryBytes?: number;
  maxTotalHookMs?: number;
  /**
   * Old-generation heap cap of a Node guest worker, in megabytes.
   * The browser isolate cannot apply it and refuses the policy before any hook runs.
   */
  isolateHeapMb?: number;
};

/** No implicit filesystem, network, or operating-system grant. No unenforced limit. */
export const CLOSED_POLICY: ExecutionPolicy = { allowGrants: [] };

/**
 * Explicit opt-in for the in-process backend.
 * This does not make that backend safe. It records that the caller accepted its grants.
 */
export const IN_PROCESS_POLICY: ExecutionPolicy = {
  allowGrants: ["filesystem", "network", "os"],
};

export type HookName = "register" | "initialize" | "shutdown" | "exportState" | "importState";

export type HookCall = {
  moduleId: string;
  hook: HookName;
  implementation: (Partial<Record<HookName, (...args: unknown[]) => unknown>> & { wasm?: Uint8Array }) | undefined;
  args: readonly unknown[];
  permissions?: readonly string[];
};

export type HookResult = { ok: true; value: unknown } | { ok: false; error: unknown };

export type PayloadResult =
  | { ok: true; value: unknown }
  | { ok: false; code: "not-callable" }
  | { ok: false; code: "threw"; error: unknown };

export type ExecutionSession = {
  id: string;
  invoke(call: HookCall): Promise<HookResult>;
  callPayload(payload: unknown, args: readonly unknown[]): Promise<PayloadResult>;
  release(): Promise<void>;
};

export type ExecutionBackend = {
  id: string;
  grants: readonly HostGrant[];
  enforcesLimits: boolean;
  /** Tighten limits to the composition policy before `open`. */
  configure?(policy: ExecutionPolicy): void;
  /** True when this backend, not a raw function, accepts the payload. */
  recognizesPayload(payload: unknown): boolean;
  /** True when this backend can run the hook. The host does not call the function itself. */
  hasHook(implementation: unknown, hook: HookName): boolean;
  /**
   * Set when this backend cannot enforce one declared limit.
   * The host refuses the policy before any hook runs.
   */
  unsupportedPolicy?(policy: ExecutionPolicy): PolicyConflict | undefined;
  /** One composition. Its guests die with `release`, not with another composition. */
  open(): ExecutionSession;
};

let sessionSerial = 0;

function ownsWasm(implementation: unknown): boolean {
  return (
    !!implementation &&
    typeof implementation === "object" &&
    (implementation as { wasm?: unknown }).wasm instanceof Uint8Array
  );
}

async function inProcessInvoke(call: HookCall): Promise<HookResult> {
  if (ownsWasm(call.implementation)) {
    return { ok: false, error: new Error("This backend does not run WebAssembly. No module function was called.") };
  }
  const fn = call.implementation?.[call.hook];
  if (typeof fn !== "function") return { ok: true, value: undefined };
  try {
    return { ok: true, value: await runInSaveZone(() => fn(...call.args)) };
  } catch (error) {
    return { ok: false, error: thrown(error) };
  }
}

function inProcessPayload(payload: unknown, args: readonly unknown[]): PayloadResult {
  if (!isCallablePayload(payload)) return { ok: false, code: "not-callable" };
  try {
    const value = runInSaveZone(() =>
      typeof payload === "function"
        ? payload(...args)
        : (payload as { handle: (...input: unknown[]) => unknown }).handle(...args),
    );
    return { ok: true, value };
  } catch (error) {
    return { ok: false, code: "threw", error: thrown(error) };
  }
}

export const inProcessBackend: ExecutionBackend = {
  id: "in-process",
  grants: ["filesystem", "network", "os"],
  enforcesLimits: false,
  recognizesPayload: isCallablePayload,
  hasHook(implementation, hook) {
    if (ownsWasm(implementation)) return false;
    if (!implementation || typeof implementation !== "object") return false;
    const fn = (implementation as Partial<Record<HookName, unknown>>)[hook];
    return typeof fn === "function";
  },
  open() {
    const id = `in-process-${++sessionSerial}`;
    let released = false;
    return {
      id,
      async invoke(call) {
        if (released) return { ok: false, error: new Error("This composition has been released.") };
        return inProcessInvoke(call);
      },
      async callPayload(payload, args) {
        if (released) return { ok: false, code: "threw", error: new Error("This composition has been released.") };
        return inProcessPayload(payload, args);
      },
      async release() {
        released = true;
      },
    };
  },
};

/** Used when a result has no session. It never calls the payload. */
export const denyingBackend: ExecutionBackend = {
  id: "denied",
  grants: [],
  enforcesLimits: true,
  recognizesPayload() {
    return false;
  },
  hasHook() {
    return false;
  },
  open() {
    return deniedSession;
  },
};

export const deniedSession: ExecutionSession = {
  id: "denied",
  async invoke() {
    return { ok: false, error: new Error("This composition has no execution backend.") };
  },
  async callPayload() {
    return { ok: false, code: "threw", error: new Error("This composition has no execution backend.") };
  },
  async release() {},
};

export type PolicyConflict = {
  code: "trust.grants" | "trust.limits";
  message: string;
};

export function policyConflict(backend: ExecutionBackend, policy: ExecutionPolicy): PolicyConflict | undefined {
  const extra = backend.grants.filter((grant) => !policy.allowGrants.includes(grant));
  if (extra.length > 0) {
    return {
      code: "trust.grants",
      message: `Backend "${backend.id}" grants ${extra.join(", ")}. The policy does not allow that, so no module code ran.`,
    };
  }
  const asksForLimit =
    policy.maxHookMs !== undefined ||
    policy.maxMemoryBytes !== undefined ||
    policy.maxBinaryBytes !== undefined ||
    policy.maxGuests !== undefined ||
    policy.maxTotalMemoryBytes !== undefined ||
    policy.maxTotalBinaryBytes !== undefined ||
    policy.maxTotalHookMs !== undefined ||
    policy.isolateHeapMb !== undefined;
  if (asksForLimit && !backend.enforcesLimits) {
    return {
      code: "trust.limits",
      message: `Backend "${backend.id}" cannot enforce execution or memory limits. No module code ran.`,
    };
  }
  if (policy.maxHookMs !== undefined && (!Number.isFinite(policy.maxHookMs) || policy.maxHookMs <= 0)) {
    return { code: "trust.limits", message: "maxHookMs must be a positive finite number." };
  }
  if (policy.maxMemoryBytes !== undefined && (!Number.isFinite(policy.maxMemoryBytes) || policy.maxMemoryBytes <= 0)) {
    return { code: "trust.limits", message: "maxMemoryBytes must be a positive finite number." };
  }
  if (policy.maxBinaryBytes !== undefined && (!Number.isFinite(policy.maxBinaryBytes) || policy.maxBinaryBytes <= 0)) {
    return { code: "trust.limits", message: "maxBinaryBytes must be a positive finite number." };
  }
  if (policy.maxGuests !== undefined && (!Number.isInteger(policy.maxGuests) || policy.maxGuests <= 0)) {
    return { code: "trust.limits", message: "maxGuests must be a positive integer." };
  }
  if (policy.maxTotalMemoryBytes !== undefined && (!Number.isFinite(policy.maxTotalMemoryBytes) || policy.maxTotalMemoryBytes <= 0)) {
    return { code: "trust.limits", message: "maxTotalMemoryBytes must be a positive finite number." };
  }
  if (policy.maxTotalBinaryBytes !== undefined && (!Number.isFinite(policy.maxTotalBinaryBytes) || policy.maxTotalBinaryBytes <= 0)) {
    return { code: "trust.limits", message: "maxTotalBinaryBytes must be a positive finite number." };
  }
  if (policy.maxTotalHookMs !== undefined && (!Number.isFinite(policy.maxTotalHookMs) || policy.maxTotalHookMs <= 0)) {
    return { code: "trust.limits", message: "maxTotalHookMs must be a positive finite number." };
  }
  if (policy.isolateHeapMb !== undefined && (!Number.isInteger(policy.isolateHeapMb) || policy.isolateHeapMb <= 0)) {
    return { code: "trust.limits", message: "isolateHeapMb must be a positive integer." };
  }
  if (policy.allowCapabilities !== undefined) {
    const names = policy.allowCapabilities;
    if (!Array.isArray(names) || names.some((item) => typeof item !== "string" || item.length === 0)) {
      return { code: "trust.limits", message: "allowCapabilities must be a list of capability names." };
    }
    if (!backend.enforcesLimits) {
      return {
        code: "trust.limits",
        message: `Backend "${backend.id}" cannot enforce capability grants. No module code ran.`,
      };
    }
  }
  return backend.unsupportedPolicy?.(policy);
}

function thrown(error: unknown): unknown {
  return error;
}
