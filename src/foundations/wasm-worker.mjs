import { parentPort } from "node:worker_threads";

const textEncode = new TextEncoder();
const textDecode = new TextDecoder();

let instance = null;
let memory = null;
let dead = false;

function respond(sab, ok, text) {
  const view = new Int32Array(sab);
  const bytes = textEncode.encode(text);
  const room = sab.byteLength - 16;
  const clipped = bytes.length > room ? textEncode.encode("Guest result exceeded the output limit.") : bytes;
  new Uint8Array(sab).set(clipped, 16);
  Atomics.store(view, 1, clipped.length);
  Atomics.store(view, 2, bytes.length > room ? 0 : ok ? 1 : 0);
  Atomics.store(view, 0, 1);
  Atomics.notify(view, 0);
}

function copyOut(ptr, len) {
  const start = ptr >>> 0;
  const size = len >>> 0;
  if (size === 0) return new Uint8Array();
  if (start + size > memory.buffer.byteLength) {
    throw new Error("Guest pointer is outside its memory.");
  }
  return new Uint8Array(memory.buffer.slice(start, start + size));
}

parentPort.on("message", (message) => {
  if (dead) return;
  try {
    if (message.op === "load") {
      const mod = new WebAssembly.Module(message.wasm);
      const imports = WebAssembly.Module.imports(mod);
      const logs = [];
      const importObject = {};
      for (const item of imports) {
        if (item.module !== "cgp.abi" || item.name !== "log" || item.kind !== "function") {
          throw new Error(`Unauthorized import ${item.module}.${item.name}`);
        }
        if (!message.allowLog) throw new Error("Capability cgp.log is not granted.");
        importObject["cgp.abi"] = {
          log(ptr, len) {
            logs.push(textDecode.decode(copyOut(ptr, len)));
          },
        };
      }
      instance = new WebAssembly.Instance(mod, importObject);
      const exports = instance.exports;
      memory = exports.memory;
      if (!(memory instanceof WebAssembly.Memory)) throw new Error("Guest did not export memory.");
      for (const name of ["cg_alloc", "cg_hook", "cg_out_ptr", "cg_out_len"]) {
        if (typeof exports[name] !== "function") throw new Error(`Guest did not export ${name}.`);
      }
      instance.logs = logs;
      respond(message.sab, true, "loaded");
      return;
    }
    if (message.op === "hook") {
      const exports = instance.exports;
      const input = textEncode.encode(message.json);
      const ptr = exports.cg_alloc(input.length);
      if (input.length > 0 && ptr === 0) throw new Error("Guest refused the input allocation.");
      if (input.length > 0) new Uint8Array(memory.buffer, ptr, input.length).set(input);
      const status = exports.cg_hook(message.hook, ptr, input.length);
      const outPtr = exports.cg_out_ptr();
      const outLen = exports.cg_out_len();
      const out = textDecode.decode(copyOut(outPtr, outLen));
      const logs = instance.logs.splice(0, instance.logs.length);
      const envelope = JSON.stringify({
        ok: status === 0,
        json: out,
        error: status === 0 ? "" : out || `Guest hook status ${status}.`,
        logs,
        pages: memory.buffer.byteLength / 65536,
      });
      respond(message.sab, true, envelope);
    }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "Guest failed.";
    try {
      respond(message.sab, false, messageText);
    } catch {
      dead = true;
    }
  }
});
