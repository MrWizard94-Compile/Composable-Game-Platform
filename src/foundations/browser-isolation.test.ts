import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { describe, it } from "node:test";
import { createWasmBackend } from "./wasm-backend.ts";
import { createBrowserWasmBackend } from "./wasm-browser.ts";
import { createLogBuffer, clipUtf8, utf8Bytes, type GuestProcess } from "./wasm-isolate.ts";
import { attachBrowserGuest } from "./wasm-worker-browser.ts";
import { compose, sessionOf, type ModulePackage } from "./host.ts";
import type { ExecutionPolicy } from "./backend.ts";
import { logGuest, storeGuest, wasiGuest } from "./wasm-build.ts";

function manifest(moduleId: string, extra: Record<string, unknown> = {}) {
  return {
    moduleId,
    name: moduleId.split(".").at(-1) ?? moduleId,
    version: "1.0.0",
    moduleApi: ">=1.0.0 <2.0.0",
    ...extra,
  };
}

function wasmPolicy(extra: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  return { allowGrants: [], maxHookMs: 1000, maxMemoryBytes: 65536, ...extra };
}

function pkg(moduleId: string, wasm: Uint8Array, extra: Record<string, unknown> = {}): ModulePackage {
  return { manifest: manifest(moduleId, extra), implementation: { wasm } };
}

function messages(result: { diagnostics: Array<{ message: string }> }): string {
  return result.diagnostics.map((item) => item.message).join("\n");
}

type WorkerMessage = { id?: number; ok?: boolean; text?: string };

function immediateProcess(): GuestProcess {
  const listeners = new Set<(message: WorkerMessage) => void>();
  return {
    postMessage(message) {
      const id = typeof message.id === "number" ? message.id : -1;
      const text = message.op === "load" ? "loaded" : JSON.stringify({ ok: true, json: "", logs: [] });
      queueMicrotask(() => {
        for (const listener of [...listeners]) listener({ id, ok: true, text });
      });
    },
    addMessageListener(listener) {
      listeners.add(listener);
    },
    removeMessageListener(listener) {
      listeners.delete(listener);
    },
    addErrorListener() {},
    removeErrorListener() {},
    terminate() {
      return Promise.resolve();
    },
  };
}

describe("browser isolate policy", () => {
  it("rejects a worker heap cap the page cannot apply", async () => {
    const browser = createBrowserWasmBackend({ spawn: () => immediateProcess() });
    const refused = await compose([pkg("org.example.one", storeGuest("{}"))], {
      backend: browser,
      policy: wasmPolicy({ isolateHeapMb: 64 }),
    });
    assert.equal(refused.runtimeActive, false);
    assert.match(messages(refused), /cannot enforce isolateHeapMb/);
    assert.equal(browser.openSessions(), 0);

    const node = createWasmBackend();
    const accepted = await compose([pkg("org.example.one", storeGuest("{}"))], {
      backend: node,
      policy: wasmPolicy({ isolateHeapMb: 64 }),
    });
    assert.equal(accepted.runtimeActive, true, messages(accepted));
    await accepted.shutdown();
    await node.dispose();
  });

  it("refuses a forbidden import before starting a worker", async () => {
    let spawned = 0;
    const backend = createBrowserWasmBackend({
      spawn() {
        spawned += 1;
        return immediateProcess();
      },
    });
    const refused = await compose([pkg("org.example.wasi", wasiGuest())], { backend, policy: wasmPolicy() });
    assert.equal(refused.runtimeActive, false);
    assert.match(messages(refused), /Unauthorized import wasi_snapshot_preview1/);
    assert.equal(spawned, 0);
  });

  it("enforces a host guest ceiling and returns it when the composition releases", async () => {
    const backend = createBrowserWasmBackend({
      host: { maxGuests: 1 },
      spawn: () => immediateProcess(),
    });
    const bytes = storeGuest("{}");
    const first = await compose([pkg("org.example.one", bytes)], { backend, policy: wasmPolicy() });
    assert.equal(first.runtimeActive, true, messages(first));
    const second = await compose([pkg("org.example.two", bytes)], { backend, policy: wasmPolicy() });
    assert.match(messages(second), /exceeds the host guest budget of 1/);
    await first.shutdown();
    const third = await compose([pkg("org.example.three", bytes)], { backend, policy: wasmPolicy() });
    assert.equal(third.runtimeActive, true, messages(third));
    await third.shutdown();
    assert.equal(backend.openSessions(), 0);
  });

  it("admits one budgeted hook at a time and overlaps hooks when the budget is unset", async () => {
    const observed = await overlap(true);
    assert.equal(observed, 1);
    const open = await overlap(false);
    assert.equal(open, 2);
  });

  it("waits for worker termination before release resolves", async () => {
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const backend = createBrowserWasmBackend({
      spawn: () => ({
        ...immediateProcess(),
        terminate: () => gate,
      }),
    });
    const result = await compose([pkg("org.example.held", storeGuest("{}"))], { backend, policy: wasmPolicy() });
    assert.equal(result.runtimeActive, true, messages(result));
    let finished = false;
    const pending = result.shutdown();
    void pending.then(() => {
      finished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(finished, false);
    assert.equal(backend.openSessions(), 1);
    openGate();
    await pending;
    assert.equal(finished, true);
    assert.equal(backend.openSessions(), 0);
  });

  it("keeps each composition's log and drops lines past the bound", async () => {
    const backend = createBrowserWasmBackend({
      log: { maxBytes: 4096, maxLines: 4, maxLine: 2 },
      spawn(heapMb) {
        void heapMb;
        return nodeSpawn();
      },
    });
    const left = await compose([pkg("org.example.left", logGuest(), { permissions: ["cgp.log"] })], {
      backend,
      policy: wasmPolicy({ allowCapabilities: ["cgp.log"] }),
    });
    const right = await compose([pkg("org.example.right", logGuest(), { permissions: ["cgp.log"] })], {
      backend,
      policy: wasmPolicy({ allowCapabilities: ["cgp.log"] }),
    });
    assert.equal(left.runtimeActive, true, messages(left));
    assert.equal(right.runtimeActive, true, messages(right));
    const leftLogs = backend.takeLogs(sessionOf(left).id);
    const rightLogs = backend.takeLogs(sessionOf(right).id);
    assert.ok(leftLogs.some((line) => line.startsWith("[org.example.left] ") && line.endsWith(" pi")));
    assert.equal(leftLogs.some((line) => line.includes("ping") || line.includes("right")), false);
    assert.ok(rightLogs.some((line) => line.startsWith("[org.example.right] ")));
    await left.shutdown();
    await right.shutdown();
  });

  it("refunds a pending worker once and waits for it to exit", async () => {
    let spawned = 0;
    let terminated = 0;
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const bytes = storeGuest("{}");
    const backend = createBrowserWasmBackend({
      host: { maxMemoryBytes: 65536 },
      spawn() {
        spawned += 1;
        if (spawned === 1) return holdingProcess(gate, () => {
          terminated += 1;
        });
        return immediateProcess();
      },
    });
    const session = backend.open();
    const pending = session.invoke({
      moduleId: "org.example.pending",
      hook: "register",
      implementation: { wasm: bytes },
      args: [],
    });
    await waitFor(() => spawned === 1 && backend.resourceUsage().guests === 1);
    assert.equal(backend.resourceUsage().guests, 1);
    assert.equal(backend.resourceUsage().memoryBytes, 65536);
    const other = backend.open();
    const blocked = await other.invoke({
      moduleId: "org.example.blocked",
      hook: "register",
      implementation: { wasm: bytes },
      args: [],
    });
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    assert.match(String(blocked.error), /host memory budget of 65536/);
    assert.equal(spawned, 1);
    await other.release();
    let finished = false;
    const done = session.release();
    void done.then(() => {
      finished = true;
    });
    await waitFor(() => terminated === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(finished, false);
    const again = session.release();
    assert.equal(again, done);
    openGate();
    await done;
    await pending;
    assert.equal(finished, true);
    assert.equal(backend.resourceUsage().guests, 0);
    assert.equal(backend.resourceUsage().memoryBytes, 0);
    assert.equal(backend.resourceUsage().binaryBytes, 0);
    const third = backend.open();
    const accepted = await third.invoke({
      moduleId: "org.example.third",
      hook: "register",
      implementation: { wasm: bytes },
      args: [],
    });
    assert.equal(accepted.ok, true);
    await third.release();
    assert.equal(backend.resourceUsage().guests, 0);
    assert.equal(backend.resourceUsage().memoryBytes, 0);
    assert.equal(backend.openSessions(), 0);
  });

  it("forgets completed logs past the retention cap", async () => {
    const backend = createBrowserWasmBackend({
      log: { maxBytes: 200, maxLines: 4, maxLine: 40, maxRetainedSessions: 1, maxRetainedBytes: 200 },
      spawn: () => loggingProcess("alpha"),
    });
    const first = await compose([pkg("org.example.old", storeGuest("{}"))], { backend, policy: wasmPolicy() });
    const second = await compose([pkg("org.example.new", storeGuest("{}"))], { backend, policy: wasmPolicy() });
    assert.equal(first.runtimeActive, true, messages(first));
    assert.equal(second.runtimeActive, true, messages(second));
    const firstId = sessionOf(first).id;
    const secondId = sessionOf(second).id;
    await first.shutdown();
    await second.shutdown();
    assert.deepEqual(backend.takeLogs(firstId), []);
    assert.ok(backend.takeLogs(secondId).some((line) => line.includes("alpha")));
    assert.equal(backend.resourceUsage().guests, 0);
  });
});

describe("log bounds", () => {
  it("records one drop marker and then discards", () => {
    const buffer = createLogBuffer({ maxBytes: 100, maxLines: 1, maxLine: 20 });
    buffer.push("org.example.a", "one");
    buffer.push("org.example.a", "two");
    buffer.push("org.example.a", "three");
    assert.deepEqual(buffer.drain(), ["[org.example.a] one", "[log dropped]"]);
  });

  it("counts UTF-8 bytes and keeps the drop marker inside the byte cap", () => {
    assert.equal(clipUtf8("éé", 2), "é");
    assert.equal(clipUtf8("😀", 3), "");
    const tight = createLogBuffer({ maxBytes: 12, maxLines: 8, maxLine: 8 });
    tight.push("m", "éééé");
    tight.push("m", "éééé");
    const kept = tight.drain();
    assert.deepEqual(kept, ["[m] éééé"]);
    assert.ok(kept.reduce((sum, line) => sum + utf8Bytes(line), 0) <= 12);

    const replaced = createLogBuffer({ maxBytes: 20, maxLines: 8, maxLine: 8 });
    replaced.push("m", "éééé");
    replaced.push("m", "éééé");
    const marker = replaced.drain();
    assert.deepEqual(marker, ["[log dropped]"]);
    assert.ok(marker.reduce((sum, line) => sum + utf8Bytes(line), 0) <= 20);

    const both = createLogBuffer({ maxBytes: 25, maxLines: 8, maxLine: 32 });
    both.push("m", "éééé");
    both.push("m", "éééééééé");
    const pair = both.drain();
    assert.deepEqual(pair, ["[m] éééé", "[log dropped]"]);
    assert.equal(pair.reduce((sum, line) => sum + utf8Bytes(line), 0), 25);
  });
});

describe("browser guest runtime", () => {
  it("refuses a forbidden import inside the browser worker before the hook runs", async () => {
    const sent: unknown[] = [];
    const slot: { handler: ((event: MessageEvent) => void) | null } = { handler: null };
    attachBrowserGuest({
      postMessage(data) {
        sent.push(data);
      },
      set onmessage(value) {
        slot.handler = value;
      },
      get onmessage() {
        return slot.handler;
      },
    });
    assert.equal(typeof slot.handler, "function");
    slot.handler?.({ data: { id: 7, op: "load", wasm: wasiGuest(), allowLog: false, maxBytes: 65536 } } as MessageEvent);
    const reply = sent[0] as { id?: number; ok?: boolean; text?: string };
    assert.equal(reply.id, 7);
    assert.equal(reply.ok, false);
    assert.match(reply.text ?? "", /Unauthorized import wasi_snapshot_preview1/);
  });
});

async function overlap(budget: boolean): Promise<number> {
  let active = 0;
  let maxActive = 0;
  const held: Array<() => void> = [];
  let n = 0;
  const backend = createBrowserWasmBackend({
    spawn: () =>
      stallingProcess(`s${++n}`, held, () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        return () => {
          active -= 1;
        };
      }),
  });
  const bytes = storeGuest("{}");
  const link = { connectsTo: [{ slot: "platform.systems", contract: "platform.system/1" }] };
  const result = await compose([pkg("org.example.a", bytes, link), pkg("org.example.b", bytes, link)], {
    backend,
    policy: wasmPolicy(budget ? { maxTotalHookMs: 60_000 } : {}),
  });
  assert.equal(result.runtimeActive, true, messages(result));
  const session = sessionOf(result);
  const handles = result.contributions.filter((item) => item.slotId === "platform.systems");
  assert.equal(handles.length, 2);
  const first = session.callPayload(handles[0]?.payload, [{}]);
  const second = session.callPayload(handles[1]?.payload, [{}]);
  await waitFor(() => held.length === (budget ? 1 : 2));
  assert.equal(maxActive, budget ? 1 : 2);
  if (budget) {
    held[0]?.();
    await waitFor(() => held.length === 1);
    assert.equal(maxActive, 1);
  }
  for (const release of [...held]) release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  await result.shutdown();
  return maxActive;
}

function stallingProcess(registerId: string, held: Array<() => void>, enter: () => () => void): GuestProcess {
  const listeners = new Set<(message: WorkerMessage) => void>();
  const register = JSON.stringify({
    contributions: [{ slotId: "platform.systems", id: registerId, dispatch: true }],
  });
  const emit = (id: number, text: string) => {
    for (const listener of [...listeners]) listener({ id, ok: true, text });
  };
  return {
    postMessage(message) {
      const id = typeof message.id === "number" ? message.id : -1;
      if (message.op === "load") {
        emit(id, "loaded");
        return;
      }
      if (message.hook !== 5) {
        emit(id, JSON.stringify({ ok: true, json: message.hook === 0 ? register : "", logs: [] }));
        return;
      }
      const leave = enter();
      const release = () => {
        leave();
        const index = held.indexOf(release);
        if (index >= 0) held.splice(index, 1);
        emit(id, JSON.stringify({ ok: true, json: "1", logs: [] }));
      };
      held.push(release);
    },
    addMessageListener(listener) {
      listeners.add(listener);
    },
    removeMessageListener(listener) {
      listeners.delete(listener);
    },
    addErrorListener() {},
    removeErrorListener() {},
    terminate() {
      return Promise.resolve();
    },
  };
}

function loggingProcess(line: string): GuestProcess {
  const listeners = new Set<(message: WorkerMessage) => void>();
  return {
    postMessage(message) {
      const id = typeof message.id === "number" ? message.id : -1;
      const text = message.op === "load" ? "loaded" : JSON.stringify({ ok: true, json: "{}", logs: [line] });
      queueMicrotask(() => {
        for (const listener of [...listeners]) listener({ id, ok: true, text });
      });
    },
    addMessageListener(listener) {
      listeners.add(listener);
    },
    removeMessageListener(listener) {
      listeners.delete(listener);
    },
    addErrorListener() {},
    removeErrorListener() {},
    terminate() {
      return Promise.resolve();
    },
  };
}

function holdingProcess(gate: Promise<void>, onTerminate: () => void): GuestProcess {
  const listeners = new Set<(message: WorkerMessage) => void>();
  let started = false;
  return {
    postMessage() {},
    addMessageListener(listener) {
      listeners.add(listener);
    },
    removeMessageListener(listener) {
      listeners.delete(listener);
    },
    addErrorListener() {},
    removeErrorListener() {},
    terminate() {
      if (!started) {
        started = true;
        onTerminate();
      }
      return gate;
    },
  };
}

function nodeSpawn(): GuestProcess {
  const worker = new Worker(new URL("./wasm-worker.mjs", import.meta.url));
  worker.unref();
  const listeners = new Set<(message: WorkerMessage) => void>();
  const errors = new Set<(error: Error) => void>();
  worker.on("message", (incoming: WorkerMessage) => {
    for (const listener of [...listeners]) listener(incoming);
  });
  worker.on("error", (error) => {
    for (const listener of [...errors]) listener(error);
  });
  return {
    postMessage(message) {
      worker.postMessage(message);
    },
    addMessageListener(listener) {
      listeners.add(listener);
    },
    removeMessageListener(listener) {
      listeners.delete(listener);
    },
    addErrorListener(listener) {
      errors.add(listener);
    },
    removeErrorListener(listener) {
      errors.delete(listener);
    },
    terminate() {
      return Promise.resolve(worker.terminate()).then(() => undefined);
    },
  };
}

async function waitFor(ready: () => boolean) {
  const started = Date.now();
  while (!ready()) {
    if (Date.now() - started > 1000) throw new Error("timed out waiting for the isolate");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
