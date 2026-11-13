import { Worker } from "node:worker_threads";
import { ABI_HOOK, isAbiHandle, guestContributions } from "./abi.ts";
import type { ExecutionBackend, ExecutionPolicy, ExecutionSession, HookCall, HookName, HookResult, PayloadResult } from "./backend.ts";

const PAGE = 65536;
const MAX_TABLE = 256;

type Limits = {
  maxHookMs: number;
  maxMemoryBytes: number;
  allow: Set<string>;
  maxGuests?: number;
  maxTotalMemoryBytes?: number;
  maxTotalBinaryBytes?: number;
  maxTotalHookMs?: number;
};

type Guest = {
  worker: Worker | null;
  dead: boolean;
};

export type WasmImport = { module: string; name: string; kind: "func" | "memory" | "table" | "global" };

export type WasmMemoryLimit =
  | { min: number; max: number | null }
  | { imported: true }
  | { missing: true }
  | { shared: true }
  | { memory64: true }
  | { count: number };

export type WasmTableLimit = { min: number; max: number | null; shared: boolean } | { count: number };

function readUleb(bytes: Uint8Array, at: { i: number }): number {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = bytes[at.i];
    if (byte === undefined) throw new Error("Truncated WebAssembly binary.");
    at.i += 1;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result >>> 0;
    shift += 7;
    if (shift > 35) throw new Error("Truncated WebAssembly binary.");
  }
}

function nameAt(bytes: Uint8Array, at: { i: number }): string {
  const length = readUleb(bytes, at);
  const end = at.i + length;
  if (end > bytes.length) throw new Error("Truncated WebAssembly binary.");
  const text = new TextDecoder().decode(bytes.subarray(at.i, end));
  at.i = end;
  return text;
}

function skipLimits(bytes: Uint8Array, at: { i: number }) {
  const flags = readUleb(bytes, at);
  readUleb(bytes, at);
  if (flags & 1) readUleb(bytes, at);
}

/** Reads import names and resource limits without compiling or instantiating. */
export function inspectWasm(bytes: Uint8Array): { imports: WasmImport[]; memory: WasmMemoryLimit; tables: WasmTableLimit[] } {
  if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error("Module bytes are not WebAssembly.");
  }
  const at = { i: 8 };
  const imports: WasmImport[] = [];
  let memory: WasmMemoryLimit = { missing: true };
  const tables: WasmTableLimit[] = [];
  while (at.i < bytes.length) {
    const id = bytes[at.i];
    at.i += 1;
    const size = readUleb(bytes, at);
    const end = at.i + size;
    if (end > bytes.length) throw new Error("Truncated WebAssembly binary.");
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
    } else if (id === 4) {
      const count = readUleb(bytes, at);
      if (count !== 1) {
        tables.push({ count });
      } else {
        at.i += 1;
        const flags = readUleb(bytes, at);
        const min = readUleb(bytes, at);
        const max = flags & 1 ? readUleb(bytes, at) : null;
        tables.push({ min, max, shared: (flags & 2) !== 0 });
      }
    } else if (id === 5) {
      const count = readUleb(bytes, at);
      if (count !== 1) {
        memory = { count };
      } else {
        const flags = readUleb(bytes, at);
        if (flags & 4) {
          memory = { memory64: true };
        } else if (flags & 2) {
          memory = { shared: true };
        } else {
          const min = readUleb(bytes, at);
          const max = flags & 1 ? readUleb(bytes, at) : null;
          memory = { min, max };
        }
      }
    }
    at.i = end;
  }
  return { imports, memory, tables };
}

function hookNumber(hook: HookName): number {
  return ABI_HOOK[hook];
}

function wasmBytes(implementation: HookCall["implementation"] | undefined): Uint8Array | undefined {
  const wasm = implementation && "wasm" in implementation ? implementation.wasm : undefined;
  return wasm instanceof Uint8Array ? wasm : undefined;
}

type GuestAnswer = { ok: true; value: unknown } | { ok: false; error: string };

export type WasmBackend = ExecutionBackend & {
  dispose: () => void;
  takeLogs: () => string[];
  /** Compositions whose guests have not been released. */
  openSessions: () => number;
};

/**
 * Isolated WebAssembly backend.
 * `open` starts one composition. Its workers and memories belong to that composition
 * and die on `release`. The host waits on a promise. It never calls `Atomics.wait`.
 */
export function createWasmBackend(options?: {
  maxHookMs?: number;
  maxMemoryBytes?: number;
  allowCapabilities?: readonly string[];
}): WasmBackend {
  const limits: Limits = {
    maxHookMs: options?.maxHookMs ?? 1000,
    maxMemoryBytes: options?.maxMemoryBytes ?? PAGE,
    allow: new Set(options?.allowCapabilities ?? []),
  };
  const recentLogs: string[] = [];
  const live = new Set<ExecutionSession>();
  let serial = 0;
  let messageSerial = 0;

  const backend: WasmBackend = {
    id: "wasm-isolate",
    grants: [],
    enforcesLimits: true,
    configure(policy: ExecutionPolicy) {
      if (policy.maxHookMs !== undefined) limits.maxHookMs = policy.maxHookMs;
      if (policy.maxMemoryBytes !== undefined) limits.maxMemoryBytes = policy.maxMemoryBytes;
      limits.allow = new Set(policy.allowCapabilities ?? []);
      limits.maxGuests = policy.maxGuests;
      limits.maxTotalMemoryBytes = policy.maxTotalMemoryBytes;
      limits.maxTotalBinaryBytes = policy.maxTotalBinaryBytes;
      limits.maxTotalHookMs = policy.maxTotalHookMs;
    },
    recognizesPayload: isAbiHandle,
    hasHook(implementation, hook) {
      void hook;
      return wasmBytes(implementation as HookCall["implementation"]) !== undefined;
    },
    open() {
      const captured: Limits = {
        maxHookMs: limits.maxHookMs,
        maxMemoryBytes: limits.maxMemoryBytes,
        allow: new Set(limits.allow),
        maxGuests: limits.maxGuests,
        maxTotalMemoryBytes: limits.maxTotalMemoryBytes,
        maxTotalBinaryBytes: limits.maxTotalBinaryBytes,
        maxTotalHookMs: limits.maxTotalHookMs,
      };
      const guests = new Map<string, Guest>();
      const cancelPending = new Set<() => void>();
      let guestCount = 0;
      let memoryUsed = 0;
      let binaryUsed = 0;
      let spentMs = 0;
      let released = false;
      const session: ExecutionSession = {
        id: `wasm-${++serial}`,
        invoke: (call) => runGuest(call),
        callPayload: (payload, args) => callHandle(payload, args),
        release: async () => {
          if (released) return;
          released = true;
          live.delete(session);
          for (const cancel of [...cancelPending]) cancel();
          cancelPending.clear();
          for (const guest of guests.values()) stopGuest(guest);
          guests.clear();
        },
      };
      live.add(session);

      function stopGuest(guest: Guest) {
        guest.dead = true;
        if (guest.worker) void guest.worker.terminate();
      }

      async function callHandle(payload: unknown, args: readonly unknown[]): Promise<PayloadResult> {
        if (released) return { ok: false, code: "threw", error: new Error("This composition has been released.") };
        if (!isAbiHandle(payload)) return { ok: false, code: "not-callable" };
        const guest = guests.get(payload.moduleId);
        if (!guest || guest.dead) {
          return { ok: false, code: "threw", error: new Error(`Module "${payload.moduleId}" is not an active isolate.`) };
        }
        const answered = await callGuest(guest, {
          op: "hook",
          hook: ABI_HOOK.call,
          json: JSON.stringify({ contributionId: payload.contributionId, arg: args[0], args }),
        });
        if (released) return { ok: false, code: "threw", error: new Error("This composition has been released.") };
        if (!answered.ok) return { ok: false, code: "threw", error: new Error(answered.error) };
        return { ok: true, value: answered.value };
      }

      async function runGuest(call: HookCall): Promise<HookResult> {
        if (released) return { ok: false, error: new Error("This composition has been released.") };
        const bytes = wasmBytes(call.implementation);
        if (!bytes) return { ok: false, error: new Error(`Module "${call.moduleId}" has no WebAssembly binary.`) };
        let guest = guests.get(call.moduleId);
        if (!guest) {
          const loaded = await loadGuest(call.moduleId, call.permissions ?? [], bytes);
          const remembered = loaded.guest ?? { worker: null, dead: true };
          if (!loaded.ok || released) {
            remembered.dead = true;
            if (loaded.ok) stopGuest(remembered);
            guests.set(call.moduleId, remembered);
            const message = !loaded.ok ? loaded.error : "This composition has been released.";
            return { ok: false, error: new Error(message) };
          }
          guest = remembered;
          guests.set(call.moduleId, guest);
        }
        if (guest.dead) return { ok: false, error: new Error(`Module "${call.moduleId}" was stopped and was not restarted.`) };
        const hook = hookNumber(call.hook);
        const input = hook === ABI_HOOK.importState ? JSON.stringify(call.args[1] ?? null) : "{}";
        const answered = await callGuest(guest, { op: "hook", hook, json: input });
        if (released) return { ok: false, error: new Error("This composition has been released.") };
        if (!answered.ok) {
          stopGuest(guest);
          return { ok: false, error: new Error(answered.error) };
        }
        if (hook === ABI_HOOK.register) {
          try {
            const rows = guestContributions(call.moduleId, answered.value);
            const contribute =
              call.args[0] && typeof call.args[0] === "object" && "contribute" in call.args[0]
                ? (call.args[0] as { contribute?: (slotId: string, contribution: { id: string; order?: number; payload: unknown }) => void })
                    .contribute
                : undefined;
            if (typeof contribute === "function") {
              for (const row of rows) contribute(row.slotId, { id: row.id, order: row.order, payload: row.payload });
            }
          } catch (error) {
            stopGuest(guest);
            return { ok: false, error: error instanceof Error ? error : new Error("Guest contributions were refused.") };
          }
        }
        return { ok: true, value: hook === ABI_HOOK.exportState ? answered.value : undefined };
      }

      async function loadGuest(
        moduleId: string,
        permissions: readonly string[],
        bytes: Uint8Array,
      ): Promise<{ ok: true; guest: Guest } | { ok: false; error: string; guest?: Guest }> {
        const refused = refuseBinary(moduleId, bytes, captured, permissions);
        if (refused) return { ok: false, error: refused };
        const inspected = inspectWasm(bytes);
        const memoryBytes =
          "max" in inspected.memory && typeof inspected.memory.max === "number"
            ? inspected.memory.max * PAGE
            : captured.maxMemoryBytes;
        const overBudget = reserve(moduleId, bytes.byteLength, memoryBytes);
        if (overBudget) return { ok: false, error: overBudget };
        const allowLog = permissions.includes("cgp.log") && captured.allow.has("cgp.log");
        const heapMb = Math.max(8, Math.ceil(captured.maxMemoryBytes / (1024 * 1024)) + 8);
        const worker = new Worker(new URL("./wasm-worker.mjs", import.meta.url), {
          resourceLimits: {
            maxOldGenerationSizeMb: heapMb,
            maxYoungGenerationSizeMb: Math.min(4, heapMb),
            codeRangeSizeMb: 8,
            stackSizeMb: 1,
          },
        });
        worker.unref();
        const guest: Guest = { worker, dead: false };
        worker.on("exit", () => {
          guest.dead = true;
        });
        const loaded = await callGuest(guest, { op: "load", wasm: bytes, allowLog });
        if (!loaded.ok) {
          refund(bytes.byteLength, memoryBytes);
          stopGuest(guest);
          return { ok: false, error: released ? "This composition has been released." : loaded.error, guest };
        }
        if (released) {
          refund(bytes.byteLength, memoryBytes);
          stopGuest(guest);
          return { ok: false, error: "This composition has been released.", guest };
        }
        return { ok: true, guest };
      }

      function reserve(moduleId: string, binaryBytes: number, memoryBytes: number): string | undefined {
        if (captured.maxGuests !== undefined && guestCount + 1 > captured.maxGuests) {
          return `Module "${moduleId}" exceeds the composition guest budget of ${captured.maxGuests}.`;
        }
        if (captured.maxTotalBinaryBytes !== undefined && binaryUsed + binaryBytes > captured.maxTotalBinaryBytes) {
          return `Module "${moduleId}" exceeds the composition binary budget of ${captured.maxTotalBinaryBytes} bytes.`;
        }
        if (captured.maxTotalMemoryBytes !== undefined && memoryUsed + memoryBytes > captured.maxTotalMemoryBytes) {
          return `Module "${moduleId}" exceeds the composition memory budget of ${captured.maxTotalMemoryBytes} bytes.`;
        }
        guestCount += 1;
        binaryUsed += binaryBytes;
        memoryUsed += memoryBytes;
        return undefined;
      }

      function refund(binaryBytes: number, memoryBytes: number) {
        guestCount -= 1;
        binaryUsed -= binaryBytes;
        memoryUsed -= memoryBytes;
      }

      function callGuest(guest: Guest, message: Record<string, unknown>): Promise<GuestAnswer> {
        if (released) return Promise.resolve({ ok: false, error: "This composition has been released." });
        if (guest.dead || !guest.worker) return Promise.resolve({ ok: false, error: "The isolate was stopped." });
        if (captured.maxTotalHookMs !== undefined && spentMs >= captured.maxTotalHookMs) {
          return Promise.resolve({ ok: false, error: "Composition hook budget exceeded." });
        }
        const worker = guest.worker;
        const id = ++messageSerial;
        const started = Date.now();
        return new Promise((resolve) => {
          let settled = false;
          const finish = (answer: GuestAnswer) => {
            if (settled) return;
            settled = true;
            if (captured.maxTotalHookMs !== undefined) spentMs += Math.max(0, Date.now() - started);
            clearTimeout(timer);
            cancelPending.delete(cancel);
            worker.off("message", onMessage);
            worker.off("error", onError);
            resolve(answer);
          };
          const cancel = () => finish({ ok: false, error: "This composition has been released." });
          cancelPending.add(cancel);
          const timer = setTimeout(() => {
            stopGuest(guest);
            finish({ ok: false, error: "Time limit exceeded. The isolate was stopped." });
          }, captured.maxHookMs);
          const onMessage = (msg: { id?: number; ok?: boolean; text?: string }) => {
            if (msg.id !== id) return;
            if (!msg.ok) {
              finish({ ok: false, error: msg.text || "Guest failed." });
              return;
            }
            finish(parseGuest(message.op === "load", msg.text ?? "", recentLogs));
          };
          const onError = (error: Error) => finish({ ok: false, error: error.message });
          worker.on("message", onMessage);
          worker.on("error", onError);
          worker.postMessage({ ...message, id, maxBytes: captured.maxMemoryBytes });
        });
      }

      return session;
    },
    dispose() {
      for (const session of [...live]) void session.release();
    },
    takeLogs() {
      const logs = [...recentLogs];
      recentLogs.length = 0;
      return logs;
    },
    openSessions() {
      return live.size;
    },
  };

  return backend;
}

function parseGuest(load: boolean, text: string, sink: string[]): GuestAnswer {
  if (load) return { ok: true, value: undefined };
  let parsed: { ok?: boolean; json?: string; error?: string; logs?: string[] };
  try {
    parsed = JSON.parse(text) as { ok?: boolean; json?: string; error?: string; logs?: string[] };
  } catch {
    return { ok: false, error: "Guest envelope was not JSON." };
  }
  sink.push(...(parsed.logs ?? []));
  if (!parsed.ok) return { ok: false, error: parsed.error || "Guest hook failed." };
  if (!parsed.json) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(parsed.json) as unknown };
  } catch {
    return { ok: false, error: "Guest result was not JSON." };
  }
}

function refuseBinary(
  moduleId: string,
  bytes: Uint8Array,
  captured: Limits,
  permissions: readonly string[],
): string | undefined {
  if (bytes.byteLength > captured.maxMemoryBytes) {
    return `Module "${moduleId}" binary is ${bytes.byteLength} bytes. The limit is ${captured.maxMemoryBytes}.`;
  }
  let inspected: ReturnType<typeof inspectWasm>;
  try {
    inspected = inspectWasm(bytes);
  } catch (error) {
    return error instanceof Error ? error.message : "Could not read the WebAssembly binary.";
  }
  if ("missing" in inspected.memory) return `Module "${moduleId}" exports no memory limit.`;
  if ("imported" in inspected.memory) return `Module "${moduleId}" imports memory. The host does not share memory.`;
  if ("shared" in inspected.memory) return `Module "${moduleId}" uses shared memory. The host refuses it.`;
  if ("memory64" in inspected.memory) return `Module "${moduleId}" uses 64-bit memory. The host refuses it.`;
  if ("count" in inspected.memory) return `Module "${moduleId}" must declare exactly one memory.`;
  if (inspected.memory.max === null) {
    return `Module "${moduleId}" memory has no maximum. The host will not instantiate it.`;
  }
  if (inspected.memory.min * PAGE > captured.maxMemoryBytes || inspected.memory.max * PAGE > captured.maxMemoryBytes) {
    return `Module "${moduleId}" memory maximum is ${inspected.memory.max * PAGE} bytes. The limit is ${captured.maxMemoryBytes}.`;
  }
  if (inspected.tables.length > 1) return `Module "${moduleId}" must declare at most one table.`;
  const table = inspected.tables[0];
  if (table && "count" in table) return `Module "${moduleId}" must declare at most one table.`;
  if (table && "shared" in table && table.shared) return `Module "${moduleId}" uses a shared table. The host refuses it.`;
  if (table && "max" in table && table.max === null) return `Module "${moduleId}" table has no maximum.`;
  if (table && "max" in table && table.max !== null && (table.max > MAX_TABLE || table.min > MAX_TABLE)) {
    return `Module "${moduleId}" table maximum is ${table.max} entries. The limit is ${MAX_TABLE}.`;
  }
  for (const item of inspected.imports) {
    const allowed = item.module === "cgp.abi" && item.name === "log" && item.kind === "func";
    if (!allowed) return `Unauthorized import ${item.module}.${item.name}.`;
    if (!permissions.includes("cgp.log") || !captured.allow.has("cgp.log")) {
      return "Capability cgp.log is not granted.";
    }
  }
  return undefined;
}
