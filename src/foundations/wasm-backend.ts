import { Worker } from "node:worker_threads";
import { ABI_HOOK, ABI_ID, isAbiHandle, type AbiContribution } from "./abi.ts";
import type { ExecutionBackend, ExecutionPolicy, HookCall, HookName, HookResult, PayloadResult } from "./backend.ts";

const PAGE = 65536;

type Limits = {
  maxHookMs: number;
  maxMemoryBytes: number;
  allow: Set<string>;
};

type Guest = {
  worker: Worker;
  dead: boolean;
};

export type WasmImport = { module: string; name: string; kind: "func" | "memory" | "table" | "global" };

export type WasmMemoryLimit = { min: number; max: number | null } | { imported: true } | { missing: true };

function readUleb(bytes: Uint8Array, at: { i: number }): number {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = bytes[at.i];
    if (byte === undefined) throw new Error("Truncated WebAssembly binary.");
    at.i += 1;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result;
    shift += 7;
  }
}

function nameAt(bytes: Uint8Array, at: { i: number }): string {
  const length = readUleb(bytes, at);
  const text = new TextDecoder().decode(bytes.subarray(at.i, at.i + length));
  at.i += length;
  return text;
}

function skipLimits(bytes: Uint8Array, at: { i: number }) {
  const flags = readUleb(bytes, at);
  readUleb(bytes, at);
  if (flags & 1) readUleb(bytes, at);
}

/** Reads import names and the guest memory limit without compiling or instantiating. */
export function inspectWasm(bytes: Uint8Array): { imports: WasmImport[]; memory: WasmMemoryLimit } {
  if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error("Module bytes are not WebAssembly.");
  }
  const at = { i: 8 };
  const imports: WasmImport[] = [];
  let memory: WasmMemoryLimit = { missing: true };
  while (at.i < bytes.length) {
    const id = bytes[at.i];
    at.i += 1;
    const size = readUleb(bytes, at);
    const end = at.i + size;
    if (id === 2) {
      const count = readUleb(bytes, at);
      for (let n = 0; n < count; n += 1) {
        const moduleName = nameAt(bytes, at);
        const field = nameAt(bytes, at);
        const kind = bytes[at.i];
        at.i += 1;
        if (kind === 0) {
          readUleb(bytes, at);
          imports.push({ module: moduleName, name: field, kind: "func" });
        } else if (kind === 1) {
          at.i += 1;
          skipLimits(bytes, at);
          imports.push({ module: moduleName, name: field, kind: "table" });
        } else if (kind === 2) {
          skipLimits(bytes, at);
          imports.push({ module: moduleName, name: field, kind: "memory" });
          memory = { imported: true };
        } else if (kind === 3) {
          at.i += 2;
          imports.push({ module: moduleName, name: field, kind: "global" });
        } else {
          throw new Error("Unsupported WebAssembly import.");
        }
      }
    } else if (id === 5) {
      const count = readUleb(bytes, at);
      if (count > 0) {
        const flags = readUleb(bytes, at);
        const min = readUleb(bytes, at);
        const max = flags & 1 ? readUleb(bytes, at) : null;
        memory = { min, max };
      }
    }
    at.i = end;
  }
  return { imports, memory };
}

function hookNumber(hook: HookName): number {
  return ABI_HOOK[hook];
}

function wasmBytes(implementation: HookCall["implementation"] | undefined): Uint8Array | undefined {
  const wasm = implementation && "wasm" in implementation ? implementation.wasm : undefined;
  return wasm instanceof Uint8Array ? wasm : undefined;
}

/**
 * Isolated WebAssembly backend.
 * Each module is one worker, one memory, and no filesystem, network, or OS imports.
 * A hook that exceeds the time limit is stopped with worker.terminate().
 * Memory with no maximum, or a maximum above the policy, is refused before instantiation.
 */
export function createWasmBackend(options?: {
  maxHookMs?: number;
  maxMemoryBytes?: number;
  allowCapabilities?: readonly string[];
}): ExecutionBackend & { dispose: () => void } {
  const limits: Limits = {
    maxHookMs: options?.maxHookMs ?? 1000,
    maxMemoryBytes: options?.maxMemoryBytes ?? PAGE,
    allow: new Set(options?.allowCapabilities ?? []),
  };
  const recentLogs: string[] = [];
  const guests = new Map<string, Guest>();
  let disposed = false;

  const backend: ExecutionBackend & { dispose: () => void } = {
    id: "wasm-isolate",
    grants: [],
    enforcesLimits: true,
    configure(policy: ExecutionPolicy) {
      if (policy.maxHookMs !== undefined) limits.maxHookMs = policy.maxHookMs;
      if (policy.maxMemoryBytes !== undefined) limits.maxMemoryBytes = policy.maxMemoryBytes;
      limits.allow = new Set(policy.allowCapabilities ?? []);
    },
    recognizesPayload: isAbiHandle,
    hasHook(implementation, hook) {
      void hook;
      return wasmBytes(implementation) !== undefined;
    },
    invoke(call) {
      return runGuest(call.moduleId, call.permissions ?? [], wasmBytes(call.implementation), hookNumber(call.hook), call.args);
    },
    callPayload(payload, arg) {
      if (!isAbiHandle(payload)) return { ok: false, code: "not-callable" };
      const guest = guests.get(payload.moduleId);
      if (!guest || guest.dead) {
        return { ok: false, code: "threw", error: new Error(`Module "${payload.moduleId}" is not an active isolate.`) };
      }
      const answered = callGuest(guest, ABI_HOOK.call, JSON.stringify({ contributionId: payload.contributionId, arg }));
      if (!answered.ok) return { ok: false, code: "threw", error: new Error(answered.error) };
      return { ok: true, value: answered.value };
    },
    dispose() {
      disposed = true;
      for (const guest of guests.values()) {
        guest.dead = true;
        void guest.worker.terminate();
      }
      guests.clear();
    },
    takeLogs() {
      return [...recentLogs];
    },
  };

  function runGuest(
    moduleId: string,
    permissions: readonly string[],
    bytes: Uint8Array | undefined,
    hook: number,
    args: readonly unknown[],
  ): HookResult {
    if (disposed) return { ok: false, error: new Error("The WASM backend has been disposed.") };
    if (!bytes) return { ok: false, error: new Error(`Module "${moduleId}" has no WebAssembly binary.`) };
    let guest = guests.get(moduleId);
    if (!guest) {
      const loaded = loadGuest(moduleId, permissions, bytes);
      if (!loaded.ok) return { ok: false, error: new Error(loaded.error) };
      guest = loaded.guest;
      guests.set(moduleId, guest);
    }
    if (guest.dead) return { ok: false, error: new Error(`Module "${moduleId}" was stopped and was not restarted.`) };
    const input = hook === ABI_HOOK.importState ? JSON.stringify(args[1] ?? null) : "{}";
    const answered = callGuest(guest, hook, input);
    if (!answered.ok) {
      guest.dead = true;
      void guest.worker.terminate();
      return { ok: false, error: new Error(answered.error) };
    }
    if (hook === ABI_HOOK.register) {
      try {
        applyContributions(moduleId, args[0], answered.value);
      } catch (error) {
        guest.dead = true;
        void guest.worker.terminate();
        return { ok: false, error: error instanceof Error ? error : new Error("Guest contributions were refused.") };
      }
    }
    return { ok: true, value: hook === ABI_HOOK.exportState ? answered.value : undefined };
  }

  function loadGuest(moduleId: string, permissions: readonly string[], bytes: Uint8Array): { ok: true; guest: Guest } | { ok: false; error: string } {
    let inspected: ReturnType<typeof inspectWasm>;
    try {
      inspected = inspectWasm(bytes);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Could not read the WebAssembly binary." };
    }
    if ("missing" in inspected.memory) return { ok: false, error: `Module "${moduleId}" exports no memory limit.` };
    if ("imported" in inspected.memory) return { ok: false, error: `Module "${moduleId}" imports memory. The host does not share memory.` };
    if (inspected.memory.max === null) {
      return { ok: false, error: `Module "${moduleId}" memory has no maximum. The host will not instantiate it.` };
    }
    if (inspected.memory.max * PAGE > limits.maxMemoryBytes) {
      return {
        ok: false,
        error: `Module "${moduleId}" memory maximum is ${inspected.memory.max * PAGE} bytes. The limit is ${limits.maxMemoryBytes}.`,
      };
    }
    for (const item of inspected.imports) {
      const allowed = item.module === "cgp.abi" && item.name === "log" && item.kind === "func";
      if (!allowed) return { ok: false, error: `Unauthorized import ${item.module}.${item.name}.` };
      if (!permissions.includes("cgp.log") || !limits.allow.has("cgp.log")) {
        return { ok: false, error: "Capability cgp.log is not granted." };
      }
    }
    const worker = new Worker(new URL("./wasm-worker.mjs", import.meta.url), {
      resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4, stackSizeMb: 1 },
    });
    worker.unref();
    const guest: Guest = { worker, dead: false };
    const loaded = callGuest(guest, -1, "", {
      op: "load",
      wasm: bytes,
      allowLog: permissions.includes("cgp.log") && limits.allow.has("cgp.log"),
    });
    if (!loaded.ok) {
      guest.dead = true;
      void worker.terminate();
      return { ok: false, error: loaded.error };
    }
    return { ok: true, guest };
  }

  function callGuest(
    guest: Guest,
    hook: number,
    json: string,
    load?: { op: "load"; wasm: Uint8Array; allowLog: boolean },
  ): { ok: true; value: unknown; logs: string[] } | { ok: false; error: string } {
    const sab = new SharedArrayBuffer(16 + Math.max(limits.maxMemoryBytes, 4096));
    const view = new Int32Array(sab);
    Atomics.store(view, 0, 0);
    guest.worker.postMessage(load ? { ...load, sab } : { op: "hook", hook, json, sab });
    const waited = Atomics.wait(view, 0, 0, limits.maxHookMs);
    if (Atomics.load(view, 0) !== 1) {
      guest.dead = true;
      void guest.worker.terminate();
      return {
        ok: false,
        error:
          waited === "timed-out"
            ? "Time limit exceeded. The isolate was stopped."
            : "The isolate stopped before it returned.",
      };
    }
    const length = Atomics.load(view, 1);
    const text = new TextDecoder().decode(new Uint8Array(sab, 16, length));
    if (Atomics.load(view, 2) !== 1) return { ok: false, error: text };
    if (load) return { ok: true, value: undefined, logs: [] };
    let parsed: { ok?: boolean; json?: string; error?: string; logs?: string[] };
    try {
      parsed = JSON.parse(text) as { ok?: boolean; json?: string; error?: string; logs?: string[] };
    } catch {
      return { ok: false, error: "Guest envelope was not JSON." };
    }
    if (!parsed.ok) return { ok: false, error: parsed.error || "Guest hook failed." };
    recentLogs.push(...(parsed.logs ?? []));
    if (!parsed.json) return { ok: true, value: undefined, logs: parsed.logs ?? [] };
    try {
      return { ok: true, value: JSON.parse(parsed.json) as unknown, logs: parsed.logs ?? [] };
    } catch {
      return { ok: false, error: "Guest result was not JSON." };
    }
  }

  return backend;
}

function applyContributions(moduleId: string, ctx: unknown, value: unknown) {
  const contribute = ctx && typeof ctx === "object" && "contribute" in ctx ? (ctx as { contribute?: unknown }).contribute : undefined;
  if (typeof contribute !== "function") return;
  const row = value && typeof value === "object" ? (value as { contributions?: unknown }).contributions : undefined;
  if (row === undefined) return;
  if (!Array.isArray(row)) throw new Error("Register result contributions must be an array.");
  for (const item of row) {
    const contribution = item as AbiContribution;
    if (!contribution || typeof contribution.slotId !== "string" || typeof contribution.id !== "string") {
      throw new Error("A guest contribution is missing a slot or an id.");
    }
    const payload = contribution.dispatch
      ? { abi: ABI_ID, moduleId, contributionId: contribution.id }
      : contribution.payload;
    contribute(contribution.slotId, { id: contribution.id, order: contribution.order, payload });
  }
}

void PAGE;
