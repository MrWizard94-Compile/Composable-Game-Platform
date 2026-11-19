import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Worker, MessageChannel, isMarkedAsUntransferable } from "node:worker_threads";
import { compose, type ModulePackage } from "./host.ts";
import type { ExecutionPolicy, HookCall } from "./backend.ts";
import { createWasmBackend, inspectWasm } from "./wasm-backend.ts";
import { createBrowserWasmBackend } from "./wasm-browser.ts";
import { acceptResourceIndex, createGuestRuntime, packPackageFiles, resourceFunctionType } from "./wasm-guest-runtime.mjs";
import {
  abiSupportFuncs,
  compileWasm,
  resourceGuest,
  resourceProbeGuest,
  resourceSignatureGuest,
  storeGuest,
  type ResourceScenario,
} from "./wasm-build.ts";
import type { GuestProcess } from "./wasm-isolate.ts";

const text = new TextEncoder();
const NOTE = text.encode("hello-note");
const END = text.encode("abcd");
const PROTO = text.encode("proto");

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
  return { allowGrants: [], maxHookMs: 1000, maxMemoryBytes: 131072, maxBinaryBytes: 262144, ...extra };
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((item) => item.toString(16).padStart(2, "0")).join("");
}

function le(value: number): string {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return hex(bytes);
}

function filesFor(wasm: Uint8Array, extra: { path: string; bytes: Uint8Array }[] = []) {
  return [
    { path: "module.wasm", bytes: wasm },
    { path: "note.txt", bytes: NOTE },
    { path: "empty.txt", bytes: new Uint8Array() },
    { path: "__proto__", bytes: PROTO },
    { path: "end.txt", bytes: END },
    ...extra,
  ];
}

function probe() {
  return resourceProbeGuest();
}

type Report = { status: number; written: string; watch: string; before: string; after: string };

function runScenario(id: number, files: { path: string; bytes: Uint8Array }[], wasm: Uint8Array): Report {
  const packed = packPackageFiles(files, wasm, { maxSnapshotBytes: 8 * 1024 * 1024 });
  const sent: Array<{ id?: number; ok?: boolean; text?: string }> = [];
  const runtime = createGuestRuntime((replyId, ok, text) => {
    sent.push({ id: replyId, ok, text });
  });
  runtime.onMessage({
    id: 1,
    op: "load",
    pack: packed.pack,
    index: packed.index,
    allowResource: true,
    maxBytes: 131072,
    maxBinaryBytes: 262144,
  });
  assert.equal(sent[0]?.ok, true, sent[0]?.text);
  runtime.onMessage({ id: 2, op: "hook", hook: 1, json: String.fromCharCode(id), maxBytes: 131072 });
  assert.equal(sent[1]?.ok, true, sent[1]?.text);
  const body = (JSON.parse(sent[1]?.text ?? "{}") as { json?: string }).json ?? "";
  assert.equal(body.length, 45, body);
  return {
    status: body.charCodeAt(0) - 48,
    written: body.slice(1, 9),
    watch: body.slice(9, 41),
    before: body.slice(41, 43),
    after: body.slice(43, 45),
  };
}

function byName(scenarios: readonly ResourceScenario[], name: string): ResourceScenario {
  const found = scenarios.find((item) => item.name === name);
  if (!found) throw new Error(`missing scenario ${name}`);
  return found;
}

describe("package resource pack", () => {
  it("packs one exact buffer in path order and leaves the scanner bytes attached", () => {
    const dir = mkdtempSync(join(tmpdir(), "cgp-pack-"));
    writeFileSync(join(dir, "small.txt"), "hi");
    const pooled = readFileSync(join(dir, "small.txt"));
    const { wasm } = probe();
    const unrelated = text.encode("other");
    const first = filesFor(wasm, [{ path: "small.txt", bytes: pooled }]);
    const reversed = [...first].reverse();
    const packed = packPackageFiles(reversed, wasm, { maxSnapshotBytes: 8 * 1024 * 1024 });
    const again = packPackageFiles(first, wasm, { maxSnapshotBytes: 8 * 1024 * 1024 });
    assert.deepEqual(again.index, packed.index);
    const total = first.reduce((sum, file) => sum + file.bytes.byteLength, 0);
    assert.equal(packed.pack.byteLength, total);
    assert.equal(packed.bytes, total);
    assert.equal(packed.index.reduce((sum, record) => sum + record.length, 0), total);
    let cursor = 0;
    for (const record of [...packed.index].sort((a, b) => a.offset - b.offset)) {
      assert.equal(record.offset, cursor);
      cursor += record.length;
    }
    const wasmRecord = packed.index.find((record) => record.path === "module.wasm");
    assert.ok(wasmRecord);
    assert.deepEqual(new Uint8Array(packed.pack, wasmRecord.offset, wasmRecord.length), wasm);
    const empty = packed.index.find((record) => record.path === "empty.txt");
    assert.equal(empty?.length, 0);
    assert.equal(pooled.byteLength, 2);
    assert.equal(Buffer.from(pooled).toString(), "hi");
    assert.notEqual(packed.pack, pooled.buffer);
    assert.equal(isMarkedAsUntransferable(pooled.buffer), true);
    assert.equal(packed.index.some((record) => record.path === "nope.txt"), false);
    assert.equal(unrelated.byteLength, 5);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a pack that would pass the snapshot budget and an allocation that throws", () => {
    const { wasm } = probe();
    const files = filesFor(wasm);
    const size = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
    assert.throws(
      () => packPackageFiles(files, wasm, { maxSnapshotBytes: size - 1 }),
      /Resource pack exceeds the snapshot budget/,
    );
    let allocated = false;
    assert.throws(
      () => packPackageFiles(files, wasm, {
        maxSnapshotBytes: size - 1,
        allocate() {
          allocated = true;
          return new ArrayBuffer(0);
        },
      }),
      /Resource pack exceeds the snapshot budget/,
    );
    assert.equal(allocated, false);
    assert.throws(
      () => packPackageFiles(
        [{ path: "../secret", bytes: wasm }, { path: "module.wasm", bytes: wasm }],
        wasm,
        {
          maxSnapshotBytes: size,
          allocate() {
            allocated = true;
            return new ArrayBuffer(0);
          },
        },
      ),
      /Resource index is malformed/,
    );
    assert.equal(allocated, false);
    assert.equal(wasm.byteLength > 0, true);
    assert.throws(
      () => packPackageFiles(files, wasm, {
        maxSnapshotBytes: size,
        allocate() {
          throw new Error("allocation failed");
        },
      }),
      /allocation failed/,
    );
    assert.equal(Buffer.from(NOTE).toString(), "hello-note");
  });

  it("rejects every malformed index shape before a module is instantiated", () => {
    const pack = new ArrayBuffer(8);
    const wasmBytes = new Uint8Array(pack);
    wasmBytes.set([1, 2, 3, 4, 5, 6, 7, 8]);
    const good = [{ path: "module.wasm", offset: 0, length: 8 }];
    assert.equal(acceptResourceIndex(pack, good), undefined);
    const half = [
      { path: "module.wasm", offset: 0, length: 4 },
      { path: "a.txt", offset: 4, length: 4 },
    ];
    assert.equal(acceptResourceIndex(pack, half), undefined);
    const badPath = (path: string) => [{ path: "module.wasm", offset: 0, length: 4 }, { path, offset: 4, length: 4 }];
    const cases: unknown[] = [
      { index: null },
      { index: "module.wasm" },
      { index: [null] },
      { index: ["module.wasm"] },
      { index: Array.from({ length: 4097 }, () => ({ path: "module.wasm", offset: 0, length: 0 })), pack: new ArrayBuffer(0) },
      { index: badPath("../x") },
      { index: badPath("a\\b") },
      { index: badPath("/abs") },
      { index: badPath("a//b") },
      { index: badPath("a/./b") },
      { index: badPath("a/%2e") },
      { index: badPath("has space") },
      { index: badPath("a".repeat(241)) },
      { index: badPath(Array.from({ length: 17 }, () => "a").join("/")) },
      { index: badPath("CON") },
      { index: badPath("node_modules/x") },
      { index: badPath("package.json") },
      { index: badPath("dir/module.ts") },
      { index: badPath("file.") },
      { index: [{ path: "module.wasm", offset: 0, length: 4 }, { path: "A.txt", offset: 4, length: 2 }, { path: "a.txt", offset: 6, length: 2 }] },
      { index: [{ path: "module.wasm", offset: 0, length: 4 }, { path: "Foo/a.txt", offset: 4, length: 2 }, { path: "foo/b.txt", offset: 6, length: 2 }] },
      { index: [{ path: "module.wasm", offset: 0, length: 4 }, { path: "module.wasm", offset: 4, length: 4 }] },
      { index: [{ path: "module.wasm", offset: -1, length: 8 }] },
      { index: [{ path: "module.wasm", offset: 0, length: -1 }] },
      { index: [{ path: "module.wasm", offset: "0", length: 8 }] },
      { index: [{ path: "module.wasm", offset: 0, length: 1.5 }] },
      { index: [{ path: "module.wasm", offset: 0, length: Number.MAX_SAFE_INTEGER }] },
      { index: [{ path: "module.wasm", offset: 5, length: 4 }] },
      { index: [{ path: "module.wasm", offset: 0, length: 5 }, { path: "a.txt", offset: 4, length: 4 }] },
      { index: [{ path: "module.wasm", offset: 0, length: 4 }, { path: "a.txt", offset: 6, length: 2 }] },
      { index: [{ path: "module.wasm", offset: 0, length: 4 }] },
      { index: half.slice(0, 1) },
      { index: [{ path: "a.txt", offset: 0, length: 8 }] },
      { index: [{ path: "__proto__", offset: 0, length: 4 }, { path: "constructor", offset: 4, length: 4 }] },
    ];
    for (const item of cases) {
      const row = item as { index: unknown; pack?: ArrayBuffer };
      const body = row.pack ?? pack;
      assert.equal(typeof acceptResourceIndex(body, row.index), "string");
    }
    const sent: Array<{ ok?: boolean; text?: string }> = [];
    const runtime = createGuestRuntime((_id, ok, text) => sent.push({ ok, text }));
    runtime.onMessage({
      id: 1,
      op: "load",
      pack,
      index: [{ path: "module.wasm", offset: 0, length: 4 }, { path: "module.wasm", offset: 4, length: 4 }],
      wasm: storeGuest("{}"),
      allowResource: true,
      maxBytes: 65536,
      maxBinaryBytes: 65536,
    });
    assert.equal(sent[0]?.ok, false);
    assert.match(sent[0]?.text ?? "", /Resource index is malformed/);
    assert.doesNotMatch(sent[0]?.text ?? "", /loaded/);
  });
});

describe("resource_read", () => {
  const built = probe();
  const files = filesFor(built.wasm);
  const run = (name: string) => runScenario(byName(built.scenarios, name).id, files, built.wasm);
  const a5 = "a5".repeat(16);
  const ff = "ffffffff";

  it("copies a file, an empty file, and module.wasm without growing host memory", () => {
    const note = run("note");
    assert.equal(note.status, 0);
    assert.equal(note.written, le(NOTE.byteLength));
    assert.equal(note.watch.startsWith(hex(NOTE)), true);
    assert.equal(note.before, "01");
    assert.equal(note.after, "01");

    const empty = run("empty");
    assert.equal(empty.status, 0);
    assert.equal(empty.written, le(0));
    assert.equal(empty.watch, a5);

    const overlap = run("empty-overlap");
    assert.equal(overlap.status, 0);
    assert.equal(overlap.written, le(0));

    const whole = run("wasm");
    assert.equal(whole.status, 0);
    assert.equal(whole.written, le(built.wasm.byteLength));
    assert.equal(whole.watch.startsWith(hex(built.wasm.subarray(0, 16))), true);

    const proto = run("proto");
    assert.equal(proto.status, 0);
    assert.equal(proto.watch.startsWith(hex(PROTO)), true);
    assert.equal(run("constructor").status, 2);
  });

  it("returns the status codes without partial writes", () => {
    const missing = run("missing");
    assert.equal(missing.status, 2);
    assert.equal(missing.written, ff);
    assert.equal(missing.watch, a5);
    assert.equal(run("case").status, 2);
    assert.equal(run("other").status, 2);
    assert.equal(run("deep16").status, 2);

    for (const name of ["utf8", "dotdot", "slash", "absolute", "percent", "deep17", "long", "empty-name", "dot"]) {
      const report = run(name);
      assert.equal(report.status, 3, name);
      assert.equal(report.written, ff, name);
      assert.equal(report.watch, a5, name);
    }

    const tooSmall = run("too-small");
    assert.equal(tooSmall.status, 1);
    assert.equal(tooSmall.written, le(NOTE.byteLength));
    assert.equal(tooSmall.watch, a5);
    const short = run("short");
    assert.equal(short.status, 1);
    assert.equal(short.written, le(NOTE.byteLength));
    assert.equal(short.watch, a5);

    const collided = run("overlap");
    assert.equal(collided.status, 4);
    assert.equal(collided.written, "a5a5a5a5");
    assert.equal(collided.watch, a5);

    const adjacent = run("adjacent");
    assert.equal(adjacent.status, 0);
    assert.equal(adjacent.written, le(END.byteLength));
    assert.equal(adjacent.watch.startsWith(hex(END) + le(END.byteLength)), true);

    const end = run("end");
    assert.equal(end.status, 0);
    assert.equal(end.written, le(END.byteLength));
    assert.equal(end.watch.slice(24), hex(END));

    for (const name of ["high-written", "high-out", "high-length", "path-range", "written-range", "out-range"]) {
      const report = run(name);
      assert.equal(report.status, name === "high-length" ? 3 : 4, name);
    }
    assert.equal(run("high-out").watch, a5);
    assert.equal(run("high-out").written, ff);
    assert.equal(run("path-range").written, ff);
  });

  it("reads the grown memory and still reads during shutdown", async () => {
    const grown = run("grow");
    assert.equal(grown.status, 0);
    assert.equal(grown.before, "01");
    assert.equal(grown.after, "02");
    assert.equal(grown.watch.startsWith(hex(NOTE)), true);

    const backend = createWasmBackend();
    const wasm = built.wasm;
    const result = await compose(
      [pkg("org.example.read", wasm, ["cgp.resource.read"])],
      { backend, policy: wasmPolicy({ allowCapabilities: ["cgp.resource.read"] }) },
    );
    assert.equal(result.runtimeActive, true, result.diagnostics.map((item) => item.message).join("\n"));
    assert.equal(backend.resourceUsage().memoryBytes, 131072);
    await result.shutdown();
    assert.equal(backend.openSessions(), 0);
    backend.dispose();
  });

  it("transfers only the pack, detaches it, and keeps the parent snapshot readable", async () => {
    const { wasm } = built;
    const files = filesFor(wasm);
    const before = files.map((file) => Uint8Array.from(file.bytes));
    let staged: ArrayBuffer | undefined;
    let posted: Record<string, unknown> | undefined;
    let transfers: readonly ArrayBuffer[] = [];
    const backend = createBrowserWasmBackend({
      spawn() {
        const worker = new Worker(new URL("./wasm-worker.mjs", import.meta.url));
        worker.unref();
        const listeners = new Set<(message: { id?: number; ok?: boolean; text?: string }) => void>();
        const process: GuestProcess = {
          postMessage(message, transfer) {
            if (message.op === "load") {
              posted = message;
              transfers = transfer ? [...transfer] : [];
            }
            worker.postMessage(message, transfer ? [...transfer] : []);
          },
          addMessageListener(listener) {
            listeners.add(listener);
          },
          removeMessageListener(listener) {
            listeners.delete(listener);
          },
          addErrorListener(listener) {
            worker.on("error", listener);
          },
          removeErrorListener(listener) {
            worker.off("error", listener);
          },
          terminate() {
            return worker.terminate().then(() => undefined);
          },
        };
        worker.on("message", (message: { id?: number; ok?: boolean; text?: string }) => {
          for (const listener of listeners) listener(message);
        });
        return process;
      },
    });
    const result = await compose([pkg("org.example.read", wasm, ["cgp.resource.read"], {
      packageFiles: files,
      allocatePack(size: number) {
        staged = new ArrayBuffer(size);
        return staged;
      },
    })], { backend, policy: wasmPolicy({ allowCapabilities: ["cgp.resource.read"] }) });
    assert.equal(result.runtimeActive, true, result.diagnostics.map((item) => item.message).join("\n"));
    assert.equal(staged?.byteLength, 0);
    assert.equal(posted?.wasm, undefined);
    assert.ok(posted?.pack instanceof ArrayBuffer);
    assert.equal(transfers.length, 1);
    assert.equal(transfers[0], staged);
    const sourceBuffers = new Set(files.map((file) => file.bytes.buffer));
    for (const item of transfers) assert.equal(sourceBuffers.has(item), false);
    files.forEach((file, index) => {
      assert.deepEqual(file.bytes, before[index]);
      assert.doesNotThrow(() => new Uint8Array(file.bytes.buffer));
    });
    await result.shutdown();
    backend.dispose();
  });
});

function pkg(
  moduleId: string,
  wasm: Uint8Array,
  permissions: string[],
  implementationExtra: Record<string, unknown> = {},
): ModulePackage {
  const { wasm: bytes } = { wasm };
  return {
    manifest: manifest(moduleId, { permissions }),
    implementation: {
      wasm: bytes,
      packageFiles: filesFor(bytes),
      maxSnapshotBytes: 8 * 1024 * 1024,
      ...implementationExtra,
    } as ModulePackage["implementation"],
  };
}

describe("resource pack failures", () => {
  it("does not spawn when the budget or the allocator fails, and a later failure still leaves the snapshot readable", async () => {
    const { wasm } = probe();
    const owned = filesFor(wasm).map((file) => ({ path: file.path, bytes: Uint8Array.from(file.bytes) }));
    let spawned = false;
    const budget = createBrowserWasmBackend({
      spawn() {
        spawned = true;
        throw new Error("spawned");
      },
    });
    const tight = await compose([pkg("org.example.read", wasm, ["cgp.resource.read"], { maxSnapshotBytes: 1 })], {
      backend: budget,
      policy: wasmPolicy({ allowCapabilities: ["cgp.resource.read"] }),
    });
    assert.equal(tight.runtimeActive, false);
    assert.match(tight.diagnostics.map((item) => item.message).join("\n"), /Resource pack exceeds the snapshot budget/);
    assert.equal(spawned, false);
    budget.dispose();

    const alloc = createBrowserWasmBackend({
      spawn() {
        spawned = true;
        throw new Error("spawned");
      },
    });
    const failedAlloc = await compose([pkg("org.example.read", wasm, ["cgp.resource.read"], {
      allocatePack() {
        throw new Error("allocation failed");
      },
    })], { backend: alloc, policy: wasmPolicy({ allowCapabilities: ["cgp.resource.read"] }) });
    assert.match(failedAlloc.diagnostics.map((item) => item.message).join("\n"), /allocation failed/);
    assert.equal(spawned, false);
    alloc.dispose();

    let staged: ArrayBuffer | undefined;
    let terminated = 0;
    const postedFiles = filesFor(wasm);
    const postedBefore = postedFiles.map((file) => Uint8Array.from(file.bytes));
    const deliver = createBrowserWasmBackend({
      spawn() {
        return {
          postMessage() {
            throw new Error("post failed");
          },
          addMessageListener() {},
          removeMessageListener() {},
          addErrorListener() {},
          removeErrorListener() {},
          terminate() {
            terminated += 1;
            return Promise.resolve();
          },
        };
      },
    });
    const undelivered = await compose([pkg("org.example.read", wasm, ["cgp.resource.read"], {
      packageFiles: postedFiles,
      allocatePack(size: number) {
        staged = new ArrayBuffer(size);
        return staged;
      },
    })], { backend: deliver, policy: wasmPolicy({ allowCapabilities: ["cgp.resource.read"] }) });
    assert.match(undelivered.diagnostics.map((item) => item.message).join("\n"), /post failed/);
    assert.equal(terminated, 1);
    assert.ok(staged && staged.byteLength > 0);
    postedFiles.forEach((file, index) => {
      assert.deepEqual(file.bytes, postedBefore[index]);
      assert.doesNotThrow(() => new Uint8Array(file.bytes.buffer));
    });
    assert.equal(deliver.resourceUsage().memoryBytes, 0);
    assert.equal(deliver.resourceUsage().guests, 0);
    assert.equal(deliver.openSessions(), 0);
    deliver.dispose();

    const broken = compileWasm({
      types: [
        { params: 3, results: 1 },
        { params: 1, results: 1 },
        { params: 0, results: 1 },
        { params: 5, results: 1 },
      ],
      imports: [{ module: "cgp.abi", name: "resource_read", type: 3 }],
      funcs: abiSupportFuncs(),
      memory: { min: 1, max: 1 },
      globals: [{ init: 1024 }, { init: 0 }, { init: 0 }],
      exports: [
        { name: "memory", kind: "mem", index: 0 },
        { name: "cg_alloc", kind: "func", index: 1 },
        { name: "cg_out_ptr", kind: "func", index: 2 },
        { name: "cg_out_len", kind: "func", index: 3 },
      ],
    });
    let dropped: ArrayBuffer | undefined;
    const after = createWasmBackend();
    const lost = await compose([pkg("org.example.broken", broken, ["cgp.resource.read"], {
      packageFiles: [{ path: "module.wasm", bytes: broken }],
      allocatePack(size: number) {
        dropped = new ArrayBuffer(size);
        return dropped;
      },
    })], { backend: after, policy: wasmPolicy({ allowCapabilities: ["cgp.resource.read"], maxMemoryBytes: 65536 }) });
    assert.equal(lost.runtimeActive, false);
    assert.match(lost.diagnostics.map((item) => item.message).join("\n"), /Guest did not export the ABI functions/);
    assert.equal(dropped?.byteLength, 0);
    assert.equal(after.openSessions(), 0);
    after.dispose();
    assert.equal(Buffer.from(owned[1]?.bytes ?? new Uint8Array()).toString(), "hello-note");
  });

  it("charges each activation's pack against its own snapshot budget", async () => {
    const { wasm } = probe();
    const size = filesFor(wasm).reduce((sum, file) => sum + file.bytes.byteLength, 0);
    const first = createWasmBackend();
    const second = createWasmBackend();
    const policy = wasmPolicy({ allowCapabilities: ["cgp.resource.read"] });
    const left = await compose([pkg("org.example.read", wasm, ["cgp.resource.read"], { maxSnapshotBytes: size })], { backend: first, policy });
    const right = await compose([pkg("org.example.read", wasm, ["cgp.resource.read"], { maxSnapshotBytes: size })], { backend: second, policy });
    assert.equal(left.runtimeActive, true, left.diagnostics.map((item) => item.message).join("\n"));
    assert.equal(right.runtimeActive, true, right.diagnostics.map((item) => item.message).join("\n"));
    await left.shutdown();
    await right.shutdown();
    first.dispose();
    second.dispose();

    const shared = createWasmBackend();
    const both = await compose(
      [
        pkg("org.example.one", wasm, ["cgp.resource.read"], { maxSnapshotBytes: size }),
        pkg("org.example.two", wasm, ["cgp.resource.read"], { maxSnapshotBytes: size }),
      ],
      { backend: shared, policy },
    );
    assert.equal(both.runtimeActive, false);
    assert.match(both.diagnostics.map((item) => item.message).join("\n"), /Resource pack exceeds the snapshot budget/);
    assert.equal(shared.openSessions(), 0);
    shared.dispose();
  });

  it("compiles module.wasm from the pack even when a separate wasm buffer is also posted", () => {
    const { wasm } = probe();
    const packed = packPackageFiles(filesFor(wasm), wasm, { maxSnapshotBytes: 8 * 1024 * 1024 });
    new Uint8Array(packed.pack).fill(0);
    const sent: Array<{ ok?: boolean; text?: string }> = [];
    const runtime = createGuestRuntime((_id, ok, text) => sent.push({ ok, text }));
    runtime.onMessage({
      id: 1,
      op: "load",
      pack: packed.pack,
      index: packed.index,
      wasm: storeGuest("{}"),
      allowResource: true,
      maxBytes: 131072,
      maxBinaryBytes: 262144,
    });
    assert.equal(sent[0]?.ok, false);
    assert.match(sent[0]?.text ?? "", /not WebAssembly/);
  });
});

const I32 = 0x7f;
const I64 = 0x7e;

function hookError(result: { ok: boolean; error?: unknown }): string {
  if (result.ok) return "";
  return result.error instanceof Error ? result.error.message : String(result.error);
}

function byteSum(files: readonly { bytes: Uint8Array }[]): number {
  return files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
}

function resourceCall(
  moduleId: string,
  wasm: Uint8Array,
  files: { path: string; bytes: Uint8Array }[],
  maxSnapshotBytes: number,
  hook: HookCall["hook"] = "initialize",
  allocatePack?: (size: number) => ArrayBuffer,
): HookCall {
  return {
    moduleId,
    hook,
    implementation: {
      wasm,
      packageFiles: files,
      maxSnapshotBytes,
      ...(allocatePack ? { allocatePack } : {}),
    } as HookCall["implementation"],
    args: [],
    permissions: ["cgp.resource.read"],
  };
}

function scriptedGuest(options?: {
  terminate?: () => Promise<void>;
  onPost?: (message: Record<string, unknown>, transfer: readonly ArrayBuffer[] | undefined) => void;
}): GuestProcess {
  const listeners = new Set<(message: { id?: number; ok?: boolean; text?: string }) => void>();
  return {
    postMessage(message, transfer) {
      options?.onPost?.(message, transfer);
      const channel = new MessageChannel();
      channel.port1.postMessage(null, transfer ? [...transfer] : []);
      channel.port1.close();
      channel.port2.close();
      queueMicrotask(() => {
        const fail = message.op === "hook" && message.hook === 2;
        const text =
          message.op === "load"
            ? "loaded"
            : JSON.stringify({ ok: !fail, json: "", error: fail ? "hook failed" : "", logs: [] });
        for (const listener of listeners) listener({ id: typeof message.id === "number" ? message.id : -1, ok: true, text });
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
      return options?.terminate ? options.terminate() : Promise.resolve();
    },
  };
}

describe("resource pack termination", () => {
  it("keeps a pack charged until termination finishes, then allows another guest", async () => {
    const wasm = resourceGuest();
    const files = filesFor(wasm);
    const size = byteSum(files);
    let spawned = 0;
    let releaseFirst: () => void = () => {};
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const backend = createBrowserWasmBackend({
      spawn() {
        spawned += 1;
        const mine = spawned;
        return scriptedGuest({
          terminate() {
            if (mine !== 1) return Promise.resolve();
            markStarted();
            return hold;
          },
        });
      },
    });
    if (!backend.configure) throw new Error("missing configure");
    backend.configure(wasmPolicy({ allowCapabilities: ["cgp.resource.read"], maxMemoryBytes: 65536 }));
    const session = backend.open();
    const first = await session.invoke(resourceCall("org.example.first", wasm, files, size));
    assert.equal(first.ok, true, hookError(first));
    assert.equal(spawned, 1);
    const stopping = session.invoke(resourceCall("org.example.first", wasm, files, size, "shutdown"));
    await started;
    const blocked = await session.invoke(resourceCall("org.example.second", wasm, filesFor(wasm), size));
    assert.equal(blocked.ok, false);
    assert.match(hookError(blocked), /Resource pack exceeds the snapshot budget/);
    assert.equal(spawned, 1);
    releaseFirst();
    const stopped = await stopping;
    assert.equal(stopped.ok, false);
    assert.match(hookError(stopped), /hook failed/);
    const next = await session.invoke(resourceCall("org.example.third", wasm, filesFor(wasm), size));
    assert.equal(next.ok, true, hookError(next));
    assert.equal(spawned, 2);
    await session.release();
    assert.equal(backend.resourceUsage().guests, 0);
    assert.equal(backend.resourceUsage().memoryBytes, 0);
    backend.dispose();
  });

  it("keeps the charge when termination fails and releases it on the retry", async () => {
    const wasm = resourceGuest();
    const files = filesFor(wasm);
    const size = byteSum(files);
    let attempts = 0;
    const backend = createBrowserWasmBackend({
      spawn() {
        return scriptedGuest({
          terminate() {
            attempts += 1;
            if (attempts === 1) return Promise.reject(new Error("terminate failed"));
            return Promise.resolve();
          },
        });
      },
    });
    if (!backend.configure) throw new Error("missing configure");
    backend.configure(wasmPolicy({ allowCapabilities: ["cgp.resource.read"], maxMemoryBytes: 65536 }));
    const session = backend.open();
    const first = await session.invoke(resourceCall("org.example.first", wasm, files, size));
    assert.equal(first.ok, true, hookError(first));
    await assert.rejects(
      () => session.invoke(resourceCall("org.example.first", wasm, files, size, "shutdown")),
      /terminate failed/,
    );
    assert.equal(attempts, 1);
    const blocked = await session.invoke(resourceCall("org.example.second", wasm, filesFor(wasm), size));
    assert.match(hookError(blocked), /Resource pack exceeds the snapshot budget/);
    await session.release();
    assert.equal(attempts, 2);
    assert.equal(backend.resourceUsage().guests, 0);
    assert.equal(backend.resourceUsage().memoryBytes, 0);
    backend.dispose();
  });

  it("drops a parent-owned pack when worker creation throws and then accepts another guest", async () => {
    const wasm = resourceGuest();
    const files = filesFor(wasm);
    const before = files.map((file) => Uint8Array.from(file.bytes));
    const size = byteSum(files);
    let staged: ArrayBuffer | undefined;
    let posts = 0;
    let live = 0;
    let failCreate = true;
    const backend = createBrowserWasmBackend({
      spawn() {
        if (failCreate) {
          failCreate = false;
          throw new Error("worker creation failed");
        }
        live += 1;
        return scriptedGuest({
          onPost() {
            posts += 1;
          },
          terminate() {
            live -= 1;
            return Promise.resolve();
          },
        });
      },
    });
    if (!backend.configure) throw new Error("missing configure");
    backend.configure(wasmPolicy({ allowCapabilities: ["cgp.resource.read"], maxMemoryBytes: 65536 }));
    const session = backend.open();
    const failed = await session.invoke(resourceCall("org.example.first", wasm, files, size, "initialize", (bytes) => {
      staged = new ArrayBuffer(bytes);
      return staged;
    }));
    assert.match(hookError(failed), /worker creation failed/);
    assert.equal(posts, 0);
    assert.equal(live, 0);
    assert.ok(staged && staged.byteLength === size);
    files.forEach((file, index) => assert.deepEqual(file.bytes, before[index]));
    assert.equal(backend.resourceUsage().memoryBytes, 0);
    assert.equal(backend.resourceUsage().guests, 0);
    const again = await session.invoke(resourceCall("org.example.second", wasm, filesFor(wasm), size));
    assert.equal(again.ok, true, hookError(again));
    assert.equal(live, 1);
    await session.release();
    assert.equal(live, 0);
    assert.equal(backend.resourceUsage().memoryBytes, 0);
    backend.dispose();
  });

  it("releases the pack charge once when delivery throws before transfer", async () => {
    const wasm = resourceGuest();
    const files = filesFor(wasm);
    const before = files.map((file) => Uint8Array.from(file.bytes));
    const size = byteSum(files);
    let staged: ArrayBuffer | undefined;
    let terminated = 0;
    let failDelivery = true;
    const backend = createBrowserWasmBackend({
      spawn() {
        const fail = failDelivery;
        failDelivery = false;
        return scriptedGuest({
          onPost() {
            if (fail) throw new Error("post failed");
          },
          terminate() {
            terminated += 1;
            return Promise.resolve();
          },
        });
      },
    });
    if (!backend.configure) throw new Error("missing configure");
    backend.configure(wasmPolicy({ allowCapabilities: ["cgp.resource.read"], maxMemoryBytes: 65536 }));
    const session = backend.open();
    const failed = await session.invoke(resourceCall("org.example.first", wasm, files, size, "initialize", (bytes) => {
      staged = new ArrayBuffer(bytes);
      return staged;
    }));
    assert.match(hookError(failed), /post failed/);
    assert.equal(terminated, 1);
    assert.ok(staged && staged.byteLength > 0);
    files.forEach((file, index) => {
      assert.deepEqual(file.bytes, before[index]);
      assert.doesNotThrow(() => new Uint8Array(file.bytes.buffer));
    });
    assert.equal(backend.resourceUsage().memoryBytes, 0);
    assert.equal(backend.resourceUsage().guests, 0);
    const again = await session.invoke(resourceCall("org.example.second", wasm, filesFor(wasm), size));
    assert.equal(again.ok, true, hookError(again));
    await session.release();
    assert.equal(terminated, 2);
    assert.equal(backend.openSessions(), 0);
    backend.dispose();
  });
});

describe("resource_read signature", () => {
  const five = [I32, I32, I32, I32, I32];
  const shapes: { name: string; params: number[]; results: number[]; typeIndex?: number; error: RegExp }[] = [
    { name: "four parameters", params: [I32, I32, I32, I32], results: [I32], error: /wrong signature/ },
    { name: "six parameters", params: [...five, I32], results: [I32], error: /wrong signature/ },
    { name: "a non-i32 parameter", params: [I32, I32, I32, I32, I64], results: [I32], error: /wrong signature/ },
    { name: "no result", params: five, results: [], error: /wrong signature/ },
    { name: "two results", params: five, results: [I32, I32], error: /wrong signature/ },
    { name: "a non-i32 result", params: five, results: [I64], error: /wrong signature/ },
    { name: "129 parameters", params: Array.from({ length: 129 }, () => I32), results: [I32], error: /wrong signature/ },
    { name: "an invalid type index", params: five, results: [I32], typeIndex: 99, error: /Malformed WebAssembly function type/ },
  ];

  function workerReply(wasm: Uint8Array) {
    const sent: Array<{ ok?: boolean; text?: string }> = [];
    const runtime = createGuestRuntime((_id, ok, text) => sent.push({ ok, text }));
    runtime.onMessage({
      id: 1,
      op: "load",
      wasm,
      allowResource: true,
      maxBytes: 65536,
      maxBinaryBytes: 262144,
    });
    return sent[0];
  }

  it("loads the five i32 signature and rejects every other function type before instantiation", async () => {
    const good = resourceSignatureGuest({ params: five, results: [I32] });
    const inspected = inspectWasm(good);
    const resource = inspected.imports.find((item) => item.name === "resource_read");
    assert.deepEqual(resource?.params, five);
    assert.deepEqual(resource?.results, [I32]);
    const accepted = workerReply(good);
    assert.equal(accepted?.ok, false);
    assert.match(accepted?.text ?? "", /^Package resources are not available\.$/);
    const sample = probe();
    const note = runScenario(byName(sample.scenarios, "note").id, filesFor(sample.wasm), sample.wasm);
    assert.equal(note.status, 0);
    assert.equal(note.written, le(NOTE.byteLength));

    const backend = createWasmBackend();
    const loaded = await compose(
      [pkg("org.example.signature", good, ["cgp.resource.read"], {
        packageFiles: [{ path: "module.wasm", bytes: good }],
        maxSnapshotBytes: good.byteLength,
      })],
      { backend, policy: wasmPolicy({ allowCapabilities: ["cgp.resource.read"], maxMemoryBytes: 65536 }) },
    );
    assert.equal(loaded.runtimeActive, true, loaded.diagnostics.map((item) => item.message).join("\n"));
    await loaded.shutdown();
    backend.dispose();

    for (const shape of shapes) {
      const wasm = resourceSignatureGuest({ params: shape.params, results: shape.results }, shape.typeIndex);
      const reply = workerReply(wasm);
      assert.equal(reply?.ok, false, shape.name);
      assert.match(reply?.text ?? "", shape.error, shape.name);
      assert.doesNotMatch(reply?.text ?? "", /WebAssembly\.Module|loaded/, shape.name);
      let spawned = false;
      const host = createBrowserWasmBackend({
        spawn() {
          spawned = true;
          throw new Error("spawned");
        },
      });
      const refused = await compose([pkg(`org.example.${shape.name.replace(/\s+/g, "-")}`, wasm, ["cgp.resource.read"])], {
        backend: host,
        policy: wasmPolicy({ allowCapabilities: ["cgp.resource.read"], maxMemoryBytes: 65536 }),
      });
      assert.equal(refused.runtimeActive, false, shape.name);
      assert.match(refused.diagnostics.map((item) => item.message).join("\n"), shape.error, shape.name);
      assert.equal(spawned, false, shape.name);
      host.dispose();
    }
  });
});

function uleb(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest !== 0) byte |= 0x80;
    out.push(byte);
  } while (rest !== 0);
  return out;
}

function readUlebAt(bytes: number[], at: { i: number }): number {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = bytes[at.i];
    if (byte === undefined) throw new Error("bad uleb");
    at.i += 1;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result >>> 0;
    shift += 7;
  }
}

function typePayload(wasm: Uint8Array): { payload: number[]; rest: number } {
  if (wasm[8] !== 1) throw new Error("type section missing");
  let i = 9;
  let size = 0;
  let shift = 0;
  let byte = 0;
  do {
    byte = wasm[i] ?? 0;
    i += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return { payload: [...wasm.subarray(i, i + size)], rest: i + size };
}

function withTypePayload(wasm: Uint8Array, payload: number[]): Uint8Array {
  const { rest } = typePayload(wasm);
  return Uint8Array.from([...wasm.subarray(0, 8), 1, ...uleb(payload.length), ...payload, ...wasm.subarray(rest)]);
}

function asRecursive(wasm: Uint8Array, extraCount = 0, extraBytes: number[] = []): Uint8Array {
  const { payload } = typePayload(wasm);
  const at = { i: 0 };
  const count = readUlebAt(payload, at);
  return withTypePayload(wasm, [0x01, 0x4e, ...uleb(count + extraCount), ...payload.slice(at.i), ...extraBytes]);
}

function replaceOnce(payload: number[], from: number[], to: number[]): number[] {
  for (let i = 0; i + from.length <= payload.length; i += 1) {
    if (from.every((byte, offset) => payload[i + offset] === byte)) {
      return [...payload.slice(0, i), ...to, ...payload.slice(i + from.length)];
    }
  }
  throw new Error("pattern missing");
}

function plainGuest(typeCount: number): Uint8Array {
  const types: { params: number; results: number }[] = [
    { params: 3, results: 1 },
    { params: 1, results: 1 },
    { params: 0, results: 1 },
    { params: 129, results: 0 },
  ];
  while (types.length < typeCount) types.push({ params: 0, results: 0 });
  return compileWasm({
    types,
    funcs: [...abiSupportFuncs(), { type: 0, body: [0x41, 0x00] }],
    memory: { min: 1, max: 1 },
    globals: [{ init: 1024 }, { init: 0 }, { init: 0 }],
    exports: [
      { name: "memory", kind: "mem", index: 0 },
      { name: "cg_alloc", kind: "func", index: 0 },
      { name: "cg_out_ptr", kind: "func", index: 1 },
      { name: "cg_out_len", kind: "func", index: 2 },
      { name: "cg_hook", kind: "func", index: 3 },
    ],
  });
}

function workerLoad(wasm: Uint8Array, allowResource = false) {
  const sent: Array<{ ok?: boolean; text?: string }> = [];
  const runtime = createGuestRuntime((_id, ok, text) => sent.push({ ok, text }));
  runtime.onMessage({
    id: 1,
    op: "load",
    wasm,
    allowResource,
    maxBytes: 65536,
    maxBinaryBytes: 262144,
  });
  return sent[0];
}

describe("type section compatibility", () => {
  it("leaves a non-resource WebAssembly 3.0 type section to the runtime", async () => {
    const wide = asRecursive(plainGuest(257), 1, [0x5f, 0x00]);
    assert.doesNotThrow(() => new WebAssembly.Module(wide.slice().buffer));
    assert.doesNotThrow(() => inspectWasm(wide));
    assert.equal(inspectWasm(wide).imports.length, 0);
    const loaded = workerLoad(wide);
    assert.equal(loaded?.ok, true, loaded?.text);
    assert.equal(loaded?.text, "loaded");
    const backend = createWasmBackend();
    const result = await compose([pkg("org.example.wide-types", wide, [])], {
      backend,
      policy: wasmPolicy({ maxMemoryBytes: 65536 }),
    });
    assert.equal(result.runtimeActive, true, result.diagnostics.map((item) => item.message).join("\n"));
    await result.shutdown();
    backend.dispose();
  });

  it("resolves resource_read across a recursive group and rejects an unknown type opcode", async () => {
    const five = [I32, I32, I32, I32, I32];
    const grouped = asRecursive(resourceSignatureGuest({ params: five, results: [I32] }));
    const inspected = inspectWasm(grouped);
    const resource = inspected.imports.find((item) => item.name === "resource_read");
    assert.deepEqual(resource?.params, five);
    assert.deepEqual(resource?.results, [I32]);
    const unavailable = workerLoad(grouped, true);
    assert.match(unavailable?.text ?? "", /^Package resources are not available\.$/);
    const backend = createWasmBackend();
    const loaded = await compose(
      [pkg("org.example.rec-signature", grouped, ["cgp.resource.read"], {
        packageFiles: [{ path: "module.wasm", bytes: grouped }],
        maxSnapshotBytes: grouped.byteLength,
      })],
      { backend, policy: wasmPolicy({ allowCapabilities: ["cgp.resource.read"], maxMemoryBytes: 65536 }) },
    );
    assert.equal(loaded.runtimeActive, true, loaded.diagnostics.map((item) => item.message).join("\n"));
    await loaded.shutdown();
    backend.dispose();

    const defined = compileWasm({
      types: [
        { params: 3, results: 1 },
        { params: 1, results: 1 },
        { params: 0, results: 1 },
        { params: 0, results: 0 },
        { params: 5, results: 1 },
      ],
      imports: [{ module: "cgp.abi", name: "resource_read", type: 4 }],
      funcs: [...abiSupportFuncs(), { type: 0, body: [0x41, 0x00] }],
      memory: { min: 1, max: 1 },
      globals: [{ init: 1024 }, { init: 0 }, { init: 0 }],
      exports: [
        { name: "memory", kind: "mem", index: 0 },
        { name: "cg_alloc", kind: "func", index: 0 },
        { name: "cg_out_ptr", kind: "func", index: 1 },
        { name: "cg_out_len", kind: "func", index: 2 },
        { name: "cg_hook", kind: "func", index: 3 },
      ],
    });
    const swapped = replaceOnce(typePayload(defined).payload, [0x60, 0x00, 0x00], [0x5f, 0x00]);
    const at = { i: 0 };
    const count = readUlebAt(swapped, at);
    const afterStruct = withTypePayload(defined, [0x01, 0x4e, ...uleb(count), ...swapped.slice(at.i)]);
    assert.deepEqual(inspectWasm(afterStruct).imports.find((item) => item.name === "resource_read")?.params, five);
    const afterReply = workerLoad(afterStruct, true);
    assert.match(afterReply?.text ?? "", /^Package resources are not available\.$/);

    const section = Uint8Array.from([
      0x02,
      0x4e, 0x02,
      0x5f, 0x00,
      0x50, 0x01, 0x00, 0x60, 0x01, 0x63, 0x70, 0x00,
      0x60, 0x05, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x01, 0x7f,
    ]);
    const resolved = resourceFunctionType(section, 0, section.length, 2);
    assert.deepEqual(resolved?.params, five);
    assert.equal(resourceFunctionType(section, 0, section.length, 0), undefined);
    const many = [0x81, 0x02];
    for (let n = 0; n < 257; n += 1) many.push(0x60, 0x00, 0x00);
    const manyBytes = Uint8Array.from(many);
    assert.deepEqual(resourceFunctionType(manyBytes, 0, manyBytes.length, 256), { params: [], results: [] });
    assert.throws(
      () => resourceFunctionType(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0x0f]), 0, 5, 0),
      /Malformed WebAssembly type section/,
    );

    const { payload } = typePayload(grouped);
    payload[payload.indexOf(0x60)] = 0x5d;
    const unknown = withTypePayload(grouped, payload);
    assert.throws(() => inspectWasm(unknown), /unsupported WebAssembly type form/);
    const reply = workerLoad(unknown, true);
    assert.match(reply?.text ?? "", /unsupported WebAssembly type form/);
    assert.doesNotMatch(reply?.text ?? "", /WebAssembly\.Module|loaded/);
    let spawned = false;
    const host = createBrowserWasmBackend({
      spawn() {
        spawned = true;
        throw new Error("spawned");
      },
    });
    const refused = await compose([pkg("org.example.unknown-type", unknown, ["cgp.resource.read"])], {
      backend: host,
      policy: wasmPolicy({ allowCapabilities: ["cgp.resource.read"], maxMemoryBytes: 65536 }),
    });
    assert.match(refused.diagnostics.map((item) => item.message).join("\n"), /unsupported WebAssembly type form/);
    assert.equal(spawned, false);
    host.dispose();
  });
});

describe("special resource keys", () => {
  it("accepts __proto__ and constructor as exact map keys beside module.wasm", () => {
    const built = probe();
    const ctor = text.encode("ctor-value");
    const files = filesFor(built.wasm, [{ path: "constructor", bytes: ctor }]);
    const packed = packPackageFiles(files, built.wasm, { maxSnapshotBytes: 8 * 1024 * 1024 });
    assert.equal(acceptResourceIndex(packed.pack, packed.index), undefined);
    const resources = new Map(packed.index.map(({ path, offset, length }) => [path, { offset, length }]));
    const protoRecord = packed.index.find((item) => item.path === "__proto__");
    const ctorRecord = packed.index.find((item) => item.path === "constructor");
    assert.ok(protoRecord);
    assert.ok(ctorRecord);
    assert.equal(typeof resources.get, "function");
    assert.deepEqual(resources.get("__proto__"), { offset: protoRecord.offset, length: protoRecord.length });
    assert.deepEqual(resources.get("constructor"), { offset: ctorRecord.offset, length: ctorRecord.length });
    assert.equal(typeof resources.get("constructor"), "object");
    const proto = runScenario(byName(built.scenarios, "proto").id, files, built.wasm);
    const constructed = runScenario(byName(built.scenarios, "constructor").id, files, built.wasm);
    assert.equal(proto.status, 0);
    assert.equal(proto.watch.startsWith(hex(PROTO)), true);
    assert.equal(constructed.status, 0);
    assert.equal(constructed.watch.startsWith(hex(ctor)), true);
  });
});

