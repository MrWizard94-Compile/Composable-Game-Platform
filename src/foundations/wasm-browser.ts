import { ABI_HOOK, guestContributions, isAbiHandle } from "./abi.ts";
import type { ExecutionBackend, ExecutionPolicy, ExecutionSession, HookCall, HookName, HookResult, PayloadResult } from "./backend.ts";

const PAGE = 65536;

type Limits = {
  maxHookMs: number;
  maxMemoryBytes: number;
  allow: Set<string>;
};

type Guest = { worker: Worker | null; dead: boolean };
type GuestAnswer = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Browser isolate. Same ABI and composition ownership as `wasm-isolate`.
 * The Node backend is the one that refuses a binary before instantiation and enforces aggregate budgets.
 * This one is what the console uses, because a page cannot open a Node worker.
 */
export function createBrowserWasmBackend(options?: {
  maxHookMs?: number;
  maxMemoryBytes?: number;
  allowCapabilities?: readonly string[];
}): ExecutionBackend & { dispose: () => void } {
  const limits: Limits = {
    maxHookMs: options?.maxHookMs ?? 1000,
    maxMemoryBytes: options?.maxMemoryBytes ?? PAGE,
    allow: new Set(options?.allowCapabilities ?? []),
  };
  const live = new Set<ExecutionSession>();
  let serial = 0;
  let messageSerial = 0;

  return {
    id: "wasm-browser",
    grants: [],
    enforcesLimits: true,
    configure(policy: ExecutionPolicy) {
      if (policy.maxHookMs !== undefined) limits.maxHookMs = policy.maxHookMs;
      if (policy.maxMemoryBytes !== undefined) limits.maxMemoryBytes = policy.maxMemoryBytes;
      limits.allow = new Set(policy.allowCapabilities ?? []);
    },
    recognizesPayload: isAbiHandle,
    hasHook(implementation) {
      const wasm = implementation && typeof implementation === "object" ? (implementation as { wasm?: unknown }).wasm : undefined;
      return wasm instanceof Uint8Array;
    },
    open() {
      const captured: Limits = {
        maxHookMs: limits.maxHookMs,
        maxMemoryBytes: limits.maxMemoryBytes,
        allow: new Set(limits.allow),
      };
      const guests = new Map<string, Guest>();
      const cancelPending = new Set<() => void>();
      let released = false;
      const session: ExecutionSession = {
        id: `wasm-browser-${++serial}`,
        invoke: (call) => runGuest(call),
        callPayload: (payload, args) => callHandle(payload, args),
        release: async () => {
          if (released) return;
          released = true;
          live.delete(session);
          for (const cancel of [...cancelPending]) cancel();
          cancelPending.clear();
          for (const guest of guests.values()) stop(guest);
          guests.clear();
        },
      };
      live.add(session);

      function stop(guest: Guest) {
        guest.dead = true;
        guest.worker?.terminate();
      }

      function wasmBytes(call: HookCall): Uint8Array | undefined {
        const wasm = call.implementation && "wasm" in call.implementation ? call.implementation.wasm : undefined;
        return wasm instanceof Uint8Array ? wasm : undefined;
      }

      async function callHandle(payload: unknown, args: readonly unknown[]): Promise<PayloadResult> {
        if (released) return { ok: false, code: "threw", error: new Error("This composition has been released.") };
        if (!isAbiHandle(payload)) return { ok: false, code: "not-callable" };
        const guest = guests.get(payload.moduleId);
        if (!guest || guest.dead) return { ok: false, code: "threw", error: new Error(`Module "${payload.moduleId}" is not an active isolate.`) };
        const answered = await callGuest(guest, {
          op: "hook",
          hook: ABI_HOOK.call,
          json: JSON.stringify({ contributionId: payload.contributionId, arg: args[0], args }),
        });
        if (!answered.ok) return { ok: false, code: "threw", error: new Error(answered.error) };
        return { ok: true, value: answered.value };
      }

      async function runGuest(call: HookCall): Promise<HookResult> {
        if (released) return { ok: false, error: new Error("This composition has been released.") };
        const bytes = wasmBytes(call);
        if (!bytes) return { ok: false, error: new Error(`Module "${call.moduleId}" has no WebAssembly binary.`) };
        let guest = guests.get(call.moduleId);
        if (!guest) {
          const loaded = await loadGuest(call.moduleId, call.permissions ?? [], bytes);
          if (!loaded.ok) {
            guests.set(call.moduleId, loaded.guest ?? { worker: null, dead: true });
            return { ok: false, error: new Error(loaded.error) };
          }
          guest = loaded.guest;
          guests.set(call.moduleId, guest);
        }
        if (guest.dead) return { ok: false, error: new Error(`Module "${call.moduleId}" was stopped and was not restarted.`) };
        const hook = ABI_HOOK[call.hook as HookName];
        const input = hook === ABI_HOOK.importState ? JSON.stringify(call.args[1] ?? null) : "{}";
        const answered = await callGuest(guest, { op: "hook", hook, json: input });
        if (!answered.ok) {
          stop(guest);
          return { ok: false, error: new Error(answered.error) };
        }
        if (hook === ABI_HOOK.register) {
          try {
            const rows = guestContributions(call.moduleId, answered.value);
            const contribute =
              call.args[0] && typeof call.args[0] === "object" && "contribute" in call.args[0]
                ? (call.args[0] as { contribute?: (slotId: string, contribution: { id: string; order?: number; payload: unknown }) => void }).contribute
                : undefined;
            if (typeof contribute === "function") {
              for (const row of rows) contribute(row.slotId, { id: row.id, order: row.order, payload: row.payload });
            }
          } catch (error) {
            stop(guest);
            return { ok: false, error: error instanceof Error ? error : new Error("Guest contributions were refused.") };
          }
        }
        return { ok: true, value: undefined };
      }

      async function loadGuest(
        moduleId: string,
        permissions: readonly string[],
        bytes: Uint8Array,
      ): Promise<{ ok: true; guest: Guest } | { ok: false; error: string; guest?: Guest }> {
        if (bytes.byteLength > captured.maxMemoryBytes) {
          return { ok: false, error: `Module "${moduleId}" binary is ${bytes.byteLength} bytes. The limit is ${captured.maxMemoryBytes}.` };
        }
        const allowLog = permissions.includes("cgp.log") && captured.allow.has("cgp.log");
        const worker = new Worker(new URL("./wasm-worker-browser.ts", import.meta.url), { type: "module" });
        const guest: Guest = { worker, dead: false };
        worker.addEventListener("error", () => {
          guest.dead = true;
        });
        const loaded = await callGuest(guest, { op: "load", wasm: bytes, allowLog });
        if (!loaded.ok) {
          stop(guest);
          return { ok: false, error: loaded.error, guest };
        }
        return { ok: true, guest };
      }

      function callGuest(guest: Guest, message: Record<string, unknown>): Promise<GuestAnswer> {
        if (released || guest.dead || !guest.worker) {
          return Promise.resolve({ ok: false, error: released ? "This composition has been released." : "The isolate was stopped." });
        }
        const worker = guest.worker;
        const id = ++messageSerial;
        return new Promise((resolve) => {
          let settled = false;
          const finish = (answer: GuestAnswer) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            cancelPending.delete(cancel);
            worker.removeEventListener("message", onMessage);
            resolve(answer);
          };
          const cancel = () => finish({ ok: false, error: "This composition has been released." });
          cancelPending.add(cancel);
          const timer = setTimeout(() => {
            stop(guest);
            finish({ ok: false, error: "Time limit exceeded. The isolate was stopped." });
          }, captured.maxHookMs);
          const onMessage = (event: MessageEvent) => {
            const msg = event.data as { id?: number; ok?: boolean; text?: string };
            if (msg.id !== id) return;
            if (!msg.ok) {
              finish({ ok: false, error: msg.text || "Guest failed." });
              return;
            }
            finish(parseGuest(message.op === "load", msg.text ?? ""));
          };
          worker.addEventListener("message", onMessage);
          worker.postMessage({ ...message, id, maxBytes: captured.maxMemoryBytes });
        });
      }

      return session;
    },
    dispose() {
      for (const session of [...live]) void session.release();
    },
  };
}

function parseGuest(load: boolean, text: string): GuestAnswer {
  if (load) return { ok: true, value: undefined };
  let parsed: { ok?: boolean; json?: string; error?: string };
  try {
    parsed = JSON.parse(text) as { ok?: boolean; json?: string; error?: string };
  } catch {
    return { ok: false, error: "Guest envelope was not JSON." };
  }
  if (!parsed.ok) return { ok: false, error: parsed.error || "Guest hook failed." };
  if (!parsed.json) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(parsed.json) as unknown };
  } catch {
    return { ok: false, error: "Guest result was not JSON." };
  }
}
