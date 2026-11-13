import { ABI_HOOK, guestContributions, isAbiHandle } from "./abi.ts";
import type {
  ExecutionBackend,
  ExecutionPolicy,
  ExecutionSession,
  HookCall,
  HookName,
  HookResult,
  PayloadResult,
} from "./backend.ts";

const PAGE = 65536;
const MAX_TABLE = 256;

export type HostBudget = {
  /** Open guests across every composition on this backend, including a load still in flight. */
  maxGuests?: number;
  /**
   * Sum of declared guest linear-memory maxima (maximum pages times 65536) across every
   * composition on this backend, including a load that has reserved a worker but not finished.
   * This is the address space the host agreed to instantiate. It is not process RSS, and it
   * does not include `isolateHeapMb`. That field is a separate Node worker cap.
   */
  maxMemoryBytes?: number;
  /** Sum of guest binary sizes, including a load still in flight. */
  maxBinaryBytes?: number;
  /**
   * Cumulative host-side hook time for this backend.
   * It is not refunded when a composition closes.
   * See the admission rule on `maxTotalHookMs`.
   */
  maxHookMs?: number;
};

export type LogBudget = {
  /** UTF-8 bytes of stored lines, including the module prefix. */
  maxBytes: number;
  maxLines: number;
  /** UTF-8 bytes of one log message, before the module prefix. */
  maxLine: number;
  /** Completed compositions whose logs stay readable. Live sessions are outside this cap. */
  maxRetainedSessions?: number;
  /** UTF-8 bytes retained after release. Live sessions are outside this sum. */
  maxRetainedBytes?: number;
};

export type ResourceUsage = {
  guests: number;
  memoryBytes: number;
  binaryBytes: number;
  hookMs: number;
  retainedLogSessions: number;
  retainedLogBytes: number;
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

type IsolateLimits = {
  maxHookMs: number;
  maxMemoryBytes: number;
  /** Per-module binary cap. Independent of `maxMemoryBytes`. */
  maxBinaryBytes: number;
  allow: Set<string>;
  maxGuests?: number;
  maxTotalMemoryBytes?: number;
  maxTotalBinaryBytes?: number;
  maxTotalHookMs?: number;
  isolateHeapMb?: number;
};

type WorkerMessage = { id?: number; ok?: boolean; text?: string };

/** A worker the session can terminate and then wait on. */
export type GuestProcess = {
  postMessage(message: Record<string, unknown>): void;
  addMessageListener(listener: (message: WorkerMessage) => void): void;
  removeMessageListener(listener: (message: WorkerMessage) => void): void;
  addErrorListener(listener: (error: Error) => void): void;
  removeErrorListener(listener: (error: Error) => void): void;
  terminate(): Promise<void>;
};

export type IsolateBackend = ExecutionBackend & {
  dispose(): Promise<void>;
  /** Drain one composition, or every composition still retained when `sessionId` is omitted. */
  takeLogs(sessionId?: string): string[];
  openSessions(): number;
  /** Host ledger. Memory is declared linear-memory maxima, not process RSS. */
  resourceUsage(): ResourceUsage;
};

type Guest = {
  worker: GuestProcess | null;
  dead: boolean;
  stopped?: Promise<void>;
};

type GuestAnswer = { ok: true; value: unknown } | { ok: false; error: string };

type LogBuffer = {
  push(moduleId: string, line: string): void;
  drain(): string[];
  byteLength(): number;
};

type Hold = {
  binary: number;
  memory: number;
  open: boolean;
};

type HostLedger = {
  guests: number;
  memory: number;
  binary: number;
  hookMs: number;
  budget: HostBudget;
  admit<T>(job: () => Promise<T>): Promise<T>;
};

const DEFAULT_LOG: LogBudget = {
  maxBytes: 4096,
  maxLines: 32,
  maxLine: 240,
  maxRetainedSessions: 8,
  maxRetainedBytes: 16384,
};

const textEncode = new TextEncoder();
const textDecode = new TextDecoder();

/** UTF-8 size of a stored log line. JavaScript string length is not byte size. */
export function utf8Bytes(text: string): number {
  return textEncode.encode(text).byteLength;
}

/** Cuts a string to a UTF-8 budget without splitting a code point. */
export function clipUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const encoded = textEncode.encode(text);
  if (encoded.byteLength <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return textDecode.decode(encoded.subarray(0, end));
}

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

export function createLogBuffer(budget: LogBudget): LogBuffer {
  const lines: string[] = [];
  let bytes = 0;
  let dropped = false;
  const noteDrop = () => {
    dropped = true;
    const marker = "[log dropped]";
    const markerSize = utf8Bytes(marker);
    if (markerSize > budget.maxBytes) return;
    while (lines.length > 0 && bytes + markerSize > budget.maxBytes) {
      const removed = lines.shift();
      if (removed !== undefined) bytes -= utf8Bytes(removed);
    }
    if (bytes + markerSize <= budget.maxBytes) {
      lines.push(marker);
      bytes += markerSize;
    }
  };
  return {
    push(moduleId, line) {
      const clipped = clipUtf8(line, budget.maxLine);
      const stored = `[${moduleId}] ${clipped}`;
      const size = utf8Bytes(stored);
      if (dropped || lines.length >= budget.maxLines || bytes + size > budget.maxBytes) {
        if (!dropped) noteDrop();
        return;
      }
      lines.push(stored);
      bytes += size;
    },
    drain() {
      const out = lines.splice(0, lines.length);
      bytes = 0;
      dropped = false;
      return out;
    },
    byteLength() {
      return bytes;
    },
  };
}

function queue(): <T>(job: () => Promise<T>) => Promise<T> {
  let chain = Promise.resolve();
  return (job) => {
    const run = chain.then(job, job);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

function createHostLedger(budget: HostBudget): HostLedger {
  const admit = budget.maxHookMs !== undefined ? queue() : <T>(job: () => Promise<T>) => job();
  return { guests: 0, memory: 0, binary: 0, hookMs: 0, budget, admit };
}

function applyPolicy(limits: IsolateLimits, policy: ExecutionPolicy, binaryDefault: number) {
  if (policy.maxHookMs !== undefined) limits.maxHookMs = policy.maxHookMs;
  if (policy.maxMemoryBytes !== undefined) limits.maxMemoryBytes = policy.maxMemoryBytes;
  limits.maxBinaryBytes = policy.maxBinaryBytes ?? binaryDefault;
  limits.allow = new Set(policy.allowCapabilities ?? []);
  limits.maxGuests = policy.maxGuests;
  limits.maxTotalMemoryBytes = policy.maxTotalMemoryBytes;
  limits.maxTotalBinaryBytes = policy.maxTotalBinaryBytes;
  limits.maxTotalHookMs = policy.maxTotalHookMs;
  limits.isolateHeapMb = policy.isolateHeapMb;
}

function wasmBytes(implementation: HookCall["implementation"] | undefined): Uint8Array | undefined {
  const wasm = implementation && "wasm" in implementation ? implementation.wasm : undefined;
  return wasm instanceof Uint8Array ? wasm : undefined;
}

/**
 * One implementation of the isolating session.
 * Node and the browser both use it. The only difference is `spawn` and whether a worker heap cap can be applied.
 */
export function createIsolateBackend(options: {
  id: string;
  /** True only when `spawn` can apply `isolateHeapMb` to the worker process. */
  supportsHeap: boolean;
  spawn: (heapMb: number) => GuestProcess;
  maxHookMs?: number;
  maxMemoryBytes?: number;
  maxBinaryBytes?: number;
  allowCapabilities?: readonly string[];
  host?: HostBudget;
  log?: Partial<LogBudget>;
}): IsolateBackend {
  const binaryDefault = options.maxBinaryBytes ?? PAGE;
  const limits: IsolateLimits = {
    maxHookMs: options.maxHookMs ?? 1000,
    maxMemoryBytes: options.maxMemoryBytes ?? PAGE,
    maxBinaryBytes: binaryDefault,
    allow: new Set(options.allowCapabilities ?? []),
  };
  const logBudget: LogBudget = {
    maxBytes: options.log?.maxBytes ?? DEFAULT_LOG.maxBytes,
    maxLines: options.log?.maxLines ?? DEFAULT_LOG.maxLines,
    maxLine: options.log?.maxLine ?? DEFAULT_LOG.maxLine,
  };
  const retention = {
    sessions: options.log?.maxRetainedSessions ?? DEFAULT_LOG.maxRetainedSessions ?? 8,
    bytes: options.log?.maxRetainedBytes ?? DEFAULT_LOG.maxRetainedBytes ?? 16384,
  };
  const host = createHostLedger(options.host ?? {});
  const logs = new Map<string, LogBuffer>();
  const retained: string[] = [];
  const live = new Set<ExecutionSession>();
  let serial = 0;
  let messageSerial = 0;
  let disposed = false;
  let disposing: Promise<void> | undefined;

  function retain(sessionId: string) {
    retained.push(sessionId);
    const size = () => retained.reduce((sum, id) => sum + (logs.get(id)?.byteLength() ?? 0), 0);
    while (retained.length > retention.sessions || (retained.length > 0 && size() > retention.bytes)) {
      const id = retained.shift();
      if (!id) break;
      logs.delete(id);
    }
  }

  function closedSession(): ExecutionSession {
    return {
      id: `${options.id}-disposed`,
      async invoke() {
        return { ok: false, error: new Error("This backend has been disposed.") };
      },
      async callPayload() {
        return { ok: false, code: "threw", error: new Error("This backend has been disposed.") };
      },
      async release() {},
    };
  }

  const backend: IsolateBackend = {
    id: options.id,
    grants: [],
    enforcesLimits: true,
    unsupportedPolicy(policy) {
      if (!options.supportsHeap && policy.isolateHeapMb !== undefined) {
        return {
          code: "trust.limits",
          message: `Backend "${options.id}" cannot enforce isolateHeapMb. No module code ran.`,
        };
      }
      return undefined;
    },
    configure(policy) {
      applyPolicy(limits, policy, binaryDefault);
    },
    recognizesPayload: isAbiHandle,
    hasHook(implementation) {
      return wasmBytes(implementation as HookCall["implementation"]) !== undefined;
    },
    open() {
      if (disposed) return closedSession();
      const captured: IsolateLimits = {
        maxHookMs: limits.maxHookMs,
        maxMemoryBytes: limits.maxMemoryBytes,
        maxBinaryBytes: limits.maxBinaryBytes,
        allow: new Set(limits.allow),
        maxGuests: limits.maxGuests,
        maxTotalMemoryBytes: limits.maxTotalMemoryBytes,
        maxTotalBinaryBytes: limits.maxTotalBinaryBytes,
        maxTotalHookMs: limits.maxTotalHookMs,
        isolateHeapMb: limits.isolateHeapMb,
      };
      const guests = new Map<string, Guest>();
      const holds = new Set<Hold>();
      const cancelPending = new Set<() => void>();
      const idleWaiters: Array<() => void> = [];
      const sessionLogs = createLogBuffer(logBudget);
      const admitComposition = captured.maxTotalHookMs !== undefined ? queue() : <T>(job: () => Promise<T>) => job();
      let guestCount = 0;
      let memoryUsed = 0;
      let binaryUsed = 0;
      let spentMs = 0;
      let pendingWork = 0;
      let released = false;
      let releasing: Promise<void> | undefined;
      const session: ExecutionSession = {
        id: `${options.id}-${++serial}`,
        invoke: (call) => track(() => runGuest(call)),
        callPayload: (payload, args) => track(() => callHandle(payload, args)),
        release,
      };
      logs.set(session.id, sessionLogs);
      live.add(session);

      function track<T>(start: () => Promise<T>): Promise<T> {
        pendingWork += 1;
        return start().finally(() => {
          pendingWork -= 1;
          if (pendingWork === 0) {
            for (const wake of idleWaiters.splice(0)) wake();
          }
        });
      }

      function stopGuest(guest: Guest): Promise<void> {
        if (guest.stopped) return guest.stopped;
        guest.dead = true;
        guest.stopped = guest.worker ? guest.worker.terminate() : Promise.resolve();
        return guest.stopped;
      }

      function release(): Promise<void> {
        if (releasing) return releasing;
        released = true;
        for (const cancel of [...cancelPending]) cancel();
        cancelPending.clear();
        releasing = (async () => {
          while (pendingWork > 0) {
            await new Promise<void>((resolve) => idleWaiters.push(resolve));
          }
          await Promise.all([...guests.values()].map((guest) => stopGuest(guest)));
          for (const hold of [...holds]) refund(hold);
          guests.clear();
          live.delete(session);
          retain(session.id);
        })();
        return releasing;
      }

      function callHandle(payload: unknown, args: readonly unknown[]): Promise<PayloadResult> {
        if (released) return Promise.resolve({ ok: false, code: "threw", error: new Error("This composition has been released.") });
        if (!isAbiHandle(payload)) return Promise.resolve({ ok: false, code: "not-callable" });
        const guest = guests.get(payload.moduleId);
        if (!guest || guest.dead) {
          return Promise.resolve({ ok: false, code: "threw", error: new Error(`Module "${payload.moduleId}" is not an active isolate.`) });
        }
        return callGuest(guest, payload.moduleId, {
          op: "hook",
          hook: ABI_HOOK.call,
          json: JSON.stringify({ contributionId: payload.contributionId, arg: args[0], args }),
        }).then((answered) => {
          if (released) return { ok: false, code: "threw", error: new Error("This composition has been released.") };
          if (!answered.ok) return { ok: false, code: "threw", error: new Error(answered.error) };
          return { ok: true, value: answered.value };
        });
      }

      function runGuest(call: HookCall): Promise<HookResult> {
        if (released) return Promise.resolve({ ok: false, error: new Error("This composition has been released.") });
        if (!options.supportsHeap && captured.isolateHeapMb !== undefined) {
          return Promise.resolve({ ok: false, error: new Error(`Backend "${options.id}" cannot enforce isolateHeapMb. No module code ran.`) });
        }
        const bytes = wasmBytes(call.implementation);
        if (!bytes) return Promise.resolve({ ok: false, error: new Error(`Module "${call.moduleId}" has no WebAssembly binary.`) });
        const existing = guests.get(call.moduleId);
        if (!existing) return loadAndRun(call, bytes);
        if (existing.dead) {
          return Promise.resolve({ ok: false, error: new Error(`Module "${call.moduleId}" was stopped and was not restarted.`) });
        }
        return runHook(existing, call);
      }

      async function loadAndRun(call: HookCall, bytes: Uint8Array): Promise<HookResult> {
        const loaded = await loadGuest(call.moduleId, call.permissions ?? [], bytes);
        const remembered = loaded.guest ?? { worker: null, dead: true };
        if (!loaded.ok || released) {
          remembered.dead = true;
          if (loaded.ok) await stopGuest(remembered);
          guests.set(call.moduleId, remembered);
          const message = !loaded.ok ? loaded.error : "This composition has been released.";
          return { ok: false, error: new Error(message) };
        }
        guests.set(call.moduleId, loaded.guest);
        return runHook(loaded.guest, call);
      }

      async function runHook(guest: Guest, call: HookCall): Promise<HookResult> {
        if (guest.dead) return { ok: false, error: new Error(`Module "${call.moduleId}" was stopped and was not restarted.`) };
        const hook = ABI_HOOK[call.hook as HookName];
        const input = hook === ABI_HOOK.importState ? JSON.stringify(call.args[1] ?? null) : "{}";
        const answered = await callGuest(guest, call.moduleId, { op: "hook", hook, json: input });
        if (released) return { ok: false, error: new Error("This composition has been released.") };
        if (!answered.ok) {
          await stopGuest(guest);
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
            await stopGuest(guest);
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
        const memoryBytes = declaredMemory(inspectWasm(bytes), captured);
        const reserved = reserve(moduleId, bytes.byteLength, memoryBytes);
        if (typeof reserved === "string") return { ok: false, error: reserved };
        const allowLog = permissions.includes("cgp.log") && captured.allow.has("cgp.log");
        const heapMb = captured.isolateHeapMb ?? Math.max(8, Math.ceil(captured.maxMemoryBytes / (1024 * 1024)) + 8);
        let worker: GuestProcess;
        try {
          worker = options.spawn(heapMb);
        } catch (error) {
          refund(reserved);
          return { ok: false, error: error instanceof Error ? error.message : "Could not start the isolate." };
        }
        const guest: Guest = { worker, dead: false };
        guests.set(moduleId, guest);
        const loaded = await callGuest(guest, moduleId, { op: "load", wasm: bytes, allowLog });
        if (!loaded.ok || released) {
          refund(reserved);
          await stopGuest(guest);
          const message = !loaded.ok ? loaded.error : "This composition has been released.";
          return { ok: false, error: message, guest };
        }
        return { ok: true, guest };
      }

      function reserve(moduleId: string, binaryBytes: number, memoryBytes: number): Hold | string {
        if (captured.maxGuests !== undefined && guestCount + 1 > captured.maxGuests) {
          return `Module "${moduleId}" exceeds the composition guest budget of ${captured.maxGuests}.`;
        }
        if (host.budget.maxGuests !== undefined && host.guests + 1 > host.budget.maxGuests) {
          return `Module "${moduleId}" exceeds the host guest budget of ${host.budget.maxGuests}.`;
        }
        if (captured.maxTotalBinaryBytes !== undefined && binaryUsed + binaryBytes > captured.maxTotalBinaryBytes) {
          return `Module "${moduleId}" exceeds the composition binary budget of ${captured.maxTotalBinaryBytes} bytes.`;
        }
        if (host.budget.maxBinaryBytes !== undefined && host.binary + binaryBytes > host.budget.maxBinaryBytes) {
          return `Module "${moduleId}" exceeds the host binary budget of ${host.budget.maxBinaryBytes} bytes.`;
        }
        if (captured.maxTotalMemoryBytes !== undefined && memoryUsed + memoryBytes > captured.maxTotalMemoryBytes) {
          return `Module "${moduleId}" exceeds the composition memory budget of ${captured.maxTotalMemoryBytes} bytes.`;
        }
        if (host.budget.maxMemoryBytes !== undefined && host.memory + memoryBytes > host.budget.maxMemoryBytes) {
          return `Module "${moduleId}" exceeds the host memory budget of ${host.budget.maxMemoryBytes} bytes.`;
        }
        const hold: Hold = { binary: binaryBytes, memory: memoryBytes, open: true };
        guestCount += 1;
        memoryUsed += memoryBytes;
        binaryUsed += binaryBytes;
        host.guests += 1;
        host.memory += memoryBytes;
        host.binary += binaryBytes;
        holds.add(hold);
        return hold;
      }

      function refund(hold: Hold) {
        if (!hold.open) return;
        hold.open = false;
        holds.delete(hold);
        guestCount -= 1;
        memoryUsed -= hold.memory;
        binaryUsed -= hold.binary;
        host.guests -= 1;
        host.memory -= hold.memory;
        host.binary -= hold.binary;
        if (guestCount < 0 || memoryUsed < 0 || binaryUsed < 0 || host.guests < 0 || host.memory < 0 || host.binary < 0) {
          throw new Error("Host resource ledger went negative.");
        }
      }

      function callGuest(guest: Guest, moduleId: string, message: Record<string, unknown>): Promise<GuestAnswer> {
        const perform = () => performCall(guest, moduleId, message);
        if (host.budget.maxHookMs !== undefined && captured.maxTotalHookMs !== undefined) {
          return host.admit(() => admitComposition(perform));
        }
        if (host.budget.maxHookMs !== undefined) return host.admit(perform);
        if (captured.maxTotalHookMs !== undefined) return admitComposition(perform);
        return perform();
      }

      function performCall(guest: Guest, moduleId: string, message: Record<string, unknown>): Promise<GuestAnswer> {
        if (released) return Promise.resolve({ ok: false, error: "This composition has been released." });
        if (guest.dead || !guest.worker) return Promise.resolve({ ok: false, error: "The isolate was stopped." });
        if (captured.maxTotalHookMs !== undefined && spentMs >= captured.maxTotalHookMs) {
          return Promise.resolve({ ok: false, error: "Composition hook budget exceeded." });
        }
        if (host.budget.maxHookMs !== undefined && host.hookMs >= host.budget.maxHookMs) {
          return Promise.resolve({ ok: false, error: "Host hook budget exceeded." });
        }
        const worker = guest.worker;
        const id = ++messageSerial;
        const started = Date.now();
        const answer = new Promise<GuestAnswer>((resolve) => {
          let settled = false;
          const finish = (next: GuestAnswer) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            cancelPending.delete(cancel);
            worker.removeMessageListener(onMessage);
            worker.removeErrorListener(onError);
            resolve(next);
          };
          const cancel = () => finish({ ok: false, error: "This composition has been released." });
          cancelPending.add(cancel);
          const timer = setTimeout(() => {
            void stopGuest(guest);
            finish({ ok: false, error: "Time limit exceeded. The isolate was stopped." });
          }, captured.maxHookMs);
          const onMessage = (msg: WorkerMessage) => {
            if (msg.id !== id) return;
            if (!msg.ok) {
              finish({ ok: false, error: msg.text || "Guest failed." });
              return;
            }
            finish(parseGuest(message.op === "load", msg.text ?? "", sessionLogs, moduleId));
          };
          const onError = (error: Error) => finish({ ok: false, error: error.message });
          worker.addMessageListener(onMessage);
          worker.addErrorListener(onError);
          worker.postMessage({
            ...message,
            id,
            maxBytes: captured.maxMemoryBytes,
            maxBinaryBytes: captured.maxBinaryBytes,
            maxLogBytes: logBudget.maxBytes,
            maxLogLines: logBudget.maxLines,
            maxLogLine: logBudget.maxLine,
          });
        });
        return answer.finally(() => {
          const elapsed = Math.max(0, Date.now() - started);
          spentMs += elapsed;
          host.hookMs += elapsed;
        });
      }

      return session;
    },
    dispose() {
      if (disposing) return disposing;
      disposed = true;
      disposing = Promise.all([...live].map((session) => session.release())).then(() => undefined);
      return disposing;
    },
    takeLogs(sessionId) {
      if (sessionId !== undefined) return logs.get(sessionId)?.drain() ?? [];
      const out: string[] = [];
      for (const buffer of logs.values()) out.push(...buffer.drain());
      return out;
    },
    openSessions() {
      return live.size;
    },
    resourceUsage() {
      let retainedLogBytes = 0;
      for (const id of retained) retainedLogBytes += logs.get(id)?.byteLength() ?? 0;
      return {
        guests: host.guests,
        memoryBytes: host.memory,
        binaryBytes: host.binary,
        hookMs: host.hookMs,
        retainedLogSessions: retained.length,
        retainedLogBytes,
      };
    },
  };

  return backend;
}

function parseGuest(load: boolean, text: string, sink: LogBuffer, moduleId: string): GuestAnswer {
  if (load) return { ok: true, value: undefined };
  let parsed: { ok?: boolean; json?: string; error?: string; logs?: unknown };
  try {
    parsed = JSON.parse(text) as { ok?: boolean; json?: string; error?: string; logs?: unknown };
  } catch {
    return { ok: false, error: "Guest envelope was not JSON." };
  }
  if (Array.isArray(parsed.logs)) {
    for (const line of parsed.logs) {
      if (typeof line === "string") sink.push(moduleId, line);
    }
  }
  if (!parsed.ok) return { ok: false, error: parsed.error || "Guest hook failed." };
  if (!parsed.json) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(parsed.json) as unknown };
  } catch {
    return { ok: false, error: "Guest result was not JSON." };
  }
}

function declaredMemory(inspected: ReturnType<typeof inspectWasm>, captured: IsolateLimits): number {
  if ("max" in inspected.memory && typeof inspected.memory.max === "number") return inspected.memory.max * PAGE;
  return captured.maxMemoryBytes;
}

function refuseBinary(
  moduleId: string,
  bytes: Uint8Array,
  captured: IsolateLimits,
  permissions: readonly string[],
): string | undefined {
  if (bytes.byteLength > captured.maxBinaryBytes) {
    return `Module "${moduleId}" binary is ${bytes.byteLength} bytes. The binary limit is ${captured.maxBinaryBytes}.`;
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
