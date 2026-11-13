/**
 * Portable module ABI `cgp.abi/1`.
 *
 * A guest is a WebAssembly module. It cannot see another guest's memory.
 * The host copies bytes in and copies bytes out. The only host import is
 * `cgp.abi.log`, and only when the module's manifest lists `cgp.log` and the
 * policy allows that capability.
 *
 * Guest exports:
 * - `memory`, with a maximum, in pages of 65536 bytes
 * - `cg_alloc(n: i32) -> i32`, or 0 if the guest cannot take `n` bytes
 * - `cg_hook(hook: i32, ptr: i32, len: i32) -> i32`, 0 on success
 * - `cg_out_ptr() -> i32` and `cg_out_len() -> i32`, the UTF-8 result
 *
 * Hook numbers are `ABI_HOOK`. The input and the result are UTF-8 JSON.
 * A zero-length result is `undefined`. Register may return
 * `{ "contributions": [{ "slotId", "id", "payload", "dispatch"? }] }`.
 * `dispatch: true` on the contribution replaces its payload with an ABI handle.
 * An object inside that payload whose only key is `dispatch: true` becomes a handle too.
 * Any other import is refused before the guest runs.
 */

export const ABI_ID = "cgp.abi/1" as const;

export const ABI_HOOK = {
  register: 0,
  initialize: 1,
  shutdown: 2,
  exportState: 3,
  importState: 4,
  call: 5,
} as const;

export type AbiHookName = keyof typeof ABI_HOOK;

export type AbiContribution = {
  slotId: string;
  id: string;
  payload?: unknown;
  dispatch?: boolean;
  order?: number;
};

export type AbiHandle = {
  abi: typeof ABI_ID;
  moduleId: string;
  contributionId: string;
};

export function isAbiHandle(payload: unknown): payload is AbiHandle {
  if (!payload || typeof payload !== "object") return false;
  const row = payload as { abi?: unknown; moduleId?: unknown; contributionId?: unknown };
  return row.abi === ABI_ID && typeof row.moduleId === "string" && typeof row.contributionId === "string";
}

export function abiHandle(moduleId: string, contributionId: string): AbiHandle {
  return { abi: ABI_ID, moduleId, contributionId };
}

/** `{ dispatch: true }` as an object's only key becomes an ABI handle. Other objects are walked. */
export function materializeAbiValue(moduleId: string, contributionId: string, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => materializeAbiValue(moduleId, contributionId, item));
  if (!value || typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length === 1 && keys[0] === "dispatch" && row.dispatch === true) return abiHandle(moduleId, contributionId);
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = materializeAbiValue(moduleId, contributionId, row[key]);
  return out;
}

export type GuestContributionInput = { id: string; order?: number; payload: unknown };

/** Turns a register result into host contributions. A top-level `dispatch: true` replaces the payload. */
export function guestContributions(
  moduleId: string,
  value: unknown,
): Array<{ slotId: string; id: string; order?: number; payload: unknown }> {
  const row = value && typeof value === "object" ? (value as { contributions?: unknown }).contributions : undefined;
  if (row === undefined) return [];
  if (!Array.isArray(row)) throw new Error("Register result contributions must be an array.");
  return row.map((item) => {
    const contribution = item as AbiContribution;
    if (!contribution || typeof contribution.slotId !== "string" || typeof contribution.id !== "string") {
      throw new Error("A guest contribution is missing a slot or an id.");
    }
    const payload = contribution.dispatch
      ? abiHandle(moduleId, contribution.id)
      : materializeAbiValue(moduleId, contribution.id, contribution.payload);
    return { slotId: contribution.slotId, id: contribution.id, order: contribution.order, payload };
  });
}
