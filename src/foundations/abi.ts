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
 * `dispatch: true` means later calls go back through `cg_hook` (`call`).
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
