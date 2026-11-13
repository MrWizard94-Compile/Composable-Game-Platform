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
 * The host mints the handle for that composition. The three JSON fields are not the capability:
 * a copied object is not a handle, and a handle from another composition does not call.
 * A call with no arguments sends `arg: null` and `args: []`. An explicit `undefined` is refused.
 * Guest JSON is copied onto fresh objects so `__proto__` cannot change a prototype.
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

type HandleBrand = {
  scope: object;
  moduleId: string;
  contributionId: string;
};

const brands = new WeakMap<object, HandleBrand>();

export type AbiHandleMint = (moduleId: string, contributionId: string) => AbiHandle;

/** Host-minted capability. The fields are visible JSON. The brand is not. */
export function mintAbiHandle(scope: object, moduleId: string, contributionId: string): AbiHandle {
  const handle: AbiHandle = Object.freeze({
    abi: ABI_ID,
    moduleId,
    contributionId,
  });
  brands.set(handle, { scope, moduleId, contributionId });
  return handle;
}

export function isAbiHandle(payload: unknown): payload is AbiHandle {
  if (!payload || typeof payload !== "object") return false;
  const brand = brands.get(payload);
  if (!brand) return false;
  const row = payload as AbiHandle;
  return row.abi === ABI_ID && row.moduleId === brand.moduleId && row.contributionId === brand.contributionId;
}

/** True only for a handle this composition minted. A lookalike is not a handle at all. */
export function abiHandleOwned(payload: unknown, scope: object): payload is AbiHandle {
  return isAbiHandle(payload) && brands.get(payload)?.scope === scope;
}

const ARRAY_MSG = "Register result contributions must be an array.";
const ROW_MSG = "A guest contribution is missing a slot or an id.";

function rethrowContribution(error: unknown): never {
  if (error instanceof Error) {
    if (error.message === ARRAY_MSG || error.message === ROW_MSG || error.message.startsWith("ABI payload is not JSON")) {
      throw error;
    }
  }
  throw new Error(ROW_MSG);
}

/**
 * Copies JSON data. `__proto__` and `constructor` stay own data properties.
 * They do not run the prototype setter and they are not read from the prototype chain.
 */
export function copyJsonData(value: unknown, seen?: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  const visiting = seen ?? new WeakSet<object>();
  if (visiting.has(value)) throw new Error("ABI payload is not JSON (circular).");
  visiting.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => copyJsonData(item, visiting));
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error("ABI payload is not JSON (non-plain object).");
    }
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      Object.defineProperty(out, key, {
        value: copyJsonData(source[key], visiting),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  } finally {
    visiting.delete(value);
  }
}

function replaceDispatch(moduleId: string, contributionId: string, value: unknown, mint: AbiHandleMint): unknown {
  if (Array.isArray(value)) return value.map((item) => replaceDispatch(moduleId, contributionId, item, mint));
  if (!value || typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length === 1 && keys[0] === "dispatch" && Object.hasOwn(row, "dispatch") && row.dispatch === true) {
    return mint(moduleId, contributionId);
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    Object.defineProperty(out, key, {
      value: replaceDispatch(moduleId, contributionId, row[key], mint),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** `{ dispatch: true }` as an object's only own key becomes an ABI handle. Other objects are copied. */
export function materializeAbiValue(moduleId: string, contributionId: string, value: unknown, mint: AbiHandleMint): unknown {
  return replaceDispatch(moduleId, contributionId, copyJsonData(value), mint);
}

export type GuestContributionInput = { id: string; order?: number; payload: unknown };

/**
 * Why `value` cannot cross the ABI as JSON.
 * JSON data is null, a boolean, a finite number, a string, an array, or a plain object.
 * `undefined`, functions, symbols, bigints, non-finite numbers, class instances, and cycles are not.
 */
export function nonJsonReason(value: unknown, seen: WeakSet<object> = new WeakSet()): string | undefined {
  if (value === null) return undefined;
  if (value === undefined) return "undefined";
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return undefined;
  if (kind === "number") return Number.isFinite(value) ? undefined : "non-finite number";
  if (kind === "bigint") return "bigint";
  if (kind === "function") return "function";
  if (kind === "symbol") return "symbol";
  if (kind !== "object") return kind;
  if (seen.has(value)) return "circular";
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const reason = nonJsonReason(item, seen);
      if (reason) return reason;
    }
    seen.delete(value);
    return undefined;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return "non-plain object";
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const reason = nonJsonReason((value as Record<string, unknown>)[key], seen);
    if (reason) return reason;
  }
  seen.delete(value);
  return undefined;
}

/** UTF-8 JSON for a guest input, or a stable reason the value cannot be sent. A throw becomes `could not encode` and is not forwarded. */
export function encodeAbiJson(value: unknown): { ok: true; json: string } | { ok: false; error: string } {
  try {
    const reason = nonJsonReason(value);
    if (reason) return { ok: false, error: `ABI payload is not JSON (${reason}).` };
    const json = JSON.stringify(value);
    if (typeof json !== "string") return { ok: false, error: "ABI payload is not JSON." };
    return { ok: true, json };
  } catch {
    return { ok: false, error: "ABI payload is not JSON (could not encode)." };
  }
}

/**
 * Hook `5` input. No arguments is `arg: null` and `args: []`.
 * That null is not an explicit argument: `[null]` stays `arg: null` with `args: [null]`.
 * An explicit `undefined` is refused. A throw while reading `args` is `could not encode`.
 */
export function encodeAbiCall(
  contributionId: string,
  args: readonly unknown[],
): { ok: true; json: string } | { ok: false; error: string } {
  try {
    if (!Array.isArray(args)) return { ok: false, error: "ABI payload is not JSON (could not encode)." };
    const arg = args.length === 0 ? null : args[0];
    return encodeAbiJson({ contributionId, arg, args });
  } catch {
    return { ok: false, error: "ABI payload is not JSON (could not encode)." };
  }
}

function readContribution(
  moduleId: string,
  item: unknown,
  mint: AbiHandleMint,
): { slotId: string; id: string; order?: number; payload: unknown } {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(ROW_MSG);
  const proto = Object.getPrototypeOf(item);
  if (proto !== Object.prototype && proto !== null) throw new Error(ROW_MSG);
  if (!Object.hasOwn(item, "slotId") || !Object.hasOwn(item, "id")) throw new Error(ROW_MSG);
  const row = item as Record<string, unknown>;
  if (typeof row.slotId !== "string" || typeof row.id !== "string") throw new Error(ROW_MSG);
  const dispatch = Object.hasOwn(item, "dispatch") && row.dispatch === true;
  const order = Object.hasOwn(item, "order") ? (row.order as number | undefined) : undefined;
  const payload = dispatch
    ? mint(moduleId, row.id)
    : materializeAbiValue(moduleId, row.id, Object.hasOwn(item, "payload") ? row.payload : undefined, mint);
  return { slotId: row.slotId, id: row.id, order, payload };
}

/** Turns a register result into host contributions. A top-level `dispatch: true` replaces the payload. */
export function guestContributions(
  moduleId: string,
  value: unknown,
  mint: AbiHandleMint,
): Array<{ slotId: string; id: string; order?: number; payload: unknown }> {
  try {
    if (!value || typeof value !== "object") return [];
    if (!Object.hasOwn(value, "contributions")) return [];
    const row = (value as { contributions?: unknown }).contributions;
    if (row === undefined) return [];
    if (!Array.isArray(row)) throw new Error(ARRAY_MSG);
    return row.map((item) => readContribution(moduleId, item, mint));
  } catch (error) {
    rethrowContribution(error);
  }
}
