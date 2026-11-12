import { isCallablePayload } from "./slots.ts";

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
  maxMemoryBytes?: number;
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
  implementation: Partial<Record<HookName, (...args: unknown[]) => unknown>> | undefined;
  args: readonly unknown[];
};

export type HookResult = { ok: true; value: unknown } | { ok: false; error: unknown };

export type PayloadResult =
  | { ok: true; value: unknown }
  | { ok: false; code: "not-callable" }
  | { ok: false; code: "threw"; error: unknown };

export type ExecutionBackend = {
  id: string;
  grants: readonly HostGrant[];
  enforcesLimits: boolean;
  invoke(call: HookCall): HookResult;
  callPayload(payload: unknown, arg: unknown): PayloadResult;
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
  const asksForLimit = policy.maxHookMs !== undefined || policy.maxMemoryBytes !== undefined;
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
  return undefined;
}

function thrown(error: unknown): unknown {
  return error;
}

export const inProcessBackend: ExecutionBackend = {
  id: "in-process",
  grants: ["filesystem", "network", "os"],
  enforcesLimits: false,
  invoke(call) {
    const fn = call.implementation?.[call.hook];
    if (typeof fn !== "function") return { ok: true, value: undefined };
    try {
      return { ok: true, value: fn(...call.args) };
    } catch (error) {
      return { ok: false, error: thrown(error) };
    }
  },
  callPayload(payload, arg) {
    if (!isCallablePayload(payload)) return { ok: false, code: "not-callable" };
    try {
      const value =
        typeof payload === "function"
          ? payload(arg)
          : (payload as { handle: (input: unknown) => unknown }).handle(arg);
      return { ok: true, value };
    } catch (error) {
      return { ok: false, code: "threw", error: thrown(error) };
    }
  },
};

/** Used when a result has no backend. It never calls the payload. */
export const denyingBackend: ExecutionBackend = {
  id: "denied",
  grants: [],
  enforcesLimits: true,
  invoke() {
    return { ok: false, error: new Error("This composition has no execution backend.") };
  },
  callPayload() {
    return { ok: false, code: "threw", error: new Error("This composition has no execution backend.") };
  },
};
