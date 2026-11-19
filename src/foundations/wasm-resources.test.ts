import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Worker, isMarkedAsUntransferable } from "node:worker_threads";
import { compose, type ModulePackage } from "./host.ts";
import type { ExecutionPolicy } from "./backend.ts";
import { createWasmBackend } from "./wasm-backend.ts";
import { createBrowserWasmBackend } from "./wasm-browser.ts";
import { acceptResourceIndex, createGuestRuntime, packPackageFiles } from "./wasm-guest-runtime.mjs";
import { abiSupportFuncs, compileWasm, resourceProbeGuest, storeGuest, type ResourceScenario } from "./wasm-build.ts";
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
    const owned = filesFor(wasm).map((file) => ({ path: file.path, bytes: Uint8Array.from(file.bytes) }));
    let staged: ArrayBuffer | undefined;
    let posted: Record<string, unknown> | undefined;
    const backend = createBrowserWasmBackend({
      spawn() {
        const worker = new Worker(new URL("./wasm-worker.mjs", import.meta.url));
        worker.unref();
        const listeners = new Set<(message: { id?: number; ok?: boolean; text?: string }) => void>();
        const process: GuestProcess = {
          postMessage(message, transfer) {
            if (message.op === "load") posted = message;
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
      allocatePack(size: number) {
        staged = new ArrayBuffer(size);
        return staged;
      },
    })], { backend, policy: wasmPolicy({ allowCapabilities: ["cgp.resource.read"] }) });
    assert.equal(result.runtimeActive, true, result.diagnostics.map((item) => item.message).join("\n"));
    assert.equal(staged?.byteLength, 0);
    assert.equal(posted?.wasm, undefined);
    assert.ok(posted?.pack instanceof ArrayBuffer);
    for (const file of owned) assert.equal(file.bytes.byteLength > 0 || file.path === "empty.txt", true);
    assert.equal(Buffer.from(owned[1]?.bytes ?? new Uint8Array()).toString(), "hello-note");
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
            return Promise.resolve();
          },
        };
      },
    });
    const undelivered = await compose([pkg("org.example.read", wasm, ["cgp.resource.read"], {
      allocatePack(size: number) {
        staged = new ArrayBuffer(size);
        return staged;
      },
    })], { backend: deliver, policy: wasmPolicy({ allowCapabilities: ["cgp.resource.read"] }) });
    assert.match(undelivered.diagnostics.map((item) => item.message).join("\n"), /post failed/);
    assert.ok(staged && staged.byteLength > 0);
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
