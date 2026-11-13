const PAGE = 65536;
const textEncode = new TextEncoder();
const textDecode = new TextDecoder();

type GuestExports = {
  memory: WebAssembly.Memory;
  cg_alloc: (n: number) => number;
  cg_hook: (hook: number, ptr: number, len: number) => number;
  cg_out_ptr: () => number;
  cg_out_len: () => number;
};

let instance: WebAssembly.Instance | null = null;
let memory: WebAssembly.Memory | null = null;
let logs: string[] = [];

const scope = globalThis as unknown as {
  postMessage: (data: unknown) => void;
  onmessage: ((event: MessageEvent) => void) | null;
};

function reply(id: number, ok: boolean, text: string) {
  scope.postMessage({ id, ok, text });
}

function copyOut(ptr: number, len: number): Uint8Array {
  if (!memory) throw new Error("Guest has no memory.");
  const start = ptr >>> 0;
  const size = len >>> 0;
  if (size === 0) return new Uint8Array();
  if (start + size > memory.buffer.byteLength) throw new Error("Guest pointer is outside its memory.");
  return new Uint8Array(memory.buffer.slice(start, start + size));
}

scope.onmessage = (event: MessageEvent) => {
  const message = event.data as { id?: number; op?: string; wasm?: Uint8Array; allowLog?: boolean; maxBytes?: number; hook?: number; json?: string };
  const id = typeof message?.id === "number" ? message.id : -1;
  try {
    if (message?.op === "load") {
      const source = message.wasm instanceof Uint8Array ? message.wasm : new Uint8Array();
      const bytes = new Uint8Array(source.byteLength);
      bytes.set(source);
      const maxBytes = typeof message.maxBytes === "number" ? message.maxBytes : 0;
      if (bytes.byteLength > maxBytes) throw new Error("Guest binary exceeds the memory limit.");
      const mod = new WebAssembly.Module(bytes.buffer);
      const imports = WebAssembly.Module.imports(mod);
      const importObject: WebAssembly.Imports = {};
      logs = [];
      for (const item of imports) {
        if (item.module !== "cgp.abi" || item.name !== "log" || item.kind !== "function") {
          throw new Error(`Unauthorized import ${item.module}.${item.name}`);
        }
        if (message.allowLog !== true) throw new Error("Capability cgp.log is not granted.");
        importObject["cgp.abi"] = {
          log(ptr: number, len: number) {
            logs.push(textDecode.decode(copyOut(ptr, len)));
          },
        };
      }
      instance = new WebAssembly.Instance(mod, importObject);
      const exported = instance.exports as unknown as GuestExports;
      if (!(exported.memory instanceof WebAssembly.Memory)) throw new Error("Guest did not export memory.");
      memory = exported.memory;
      if (memory.buffer instanceof SharedArrayBuffer) throw new Error("Guest memory is shared. The host refuses it.");
      if (memory.buffer.byteLength > maxBytes) {
        throw new Error(`Guest memory is ${memory.buffer.byteLength} bytes. The limit is ${maxBytes}.`);
      }
      if (
        typeof exported.cg_alloc !== "function" ||
        typeof exported.cg_hook !== "function" ||
        typeof exported.cg_out_ptr !== "function" ||
        typeof exported.cg_out_len !== "function"
      ) {
        throw new Error("Guest did not export the ABI functions.");
      }
      reply(id, true, "loaded");
      return;
    }
    if (message?.op === "hook") {
      if (!instance || !memory) throw new Error("Guest is not loaded.");
      const exported = instance.exports as unknown as GuestExports;
      const maxBytes = typeof message.maxBytes === "number" ? message.maxBytes : 0;
      const input = textEncode.encode(typeof message.json === "string" ? message.json : "");
      if (input.byteLength > maxBytes) throw new Error("Guest input exceeds the memory limit.");
      const ptr = exported.cg_alloc(input.length);
      if (input.length > 0 && ptr === 0) throw new Error("Guest refused the input allocation.");
      if (input.length > 0) new Uint8Array(memory.buffer, ptr, input.length).set(input);
      const status = exported.cg_hook(message.hook ?? -1, ptr, input.length);
      const outPtr = exported.cg_out_ptr();
      const outLen = exported.cg_out_len();
      if (outLen > maxBytes || outLen < 0) throw new Error("Guest result exceeds the memory limit.");
      const out = textDecode.decode(copyOut(outPtr, outLen));
      const taken = logs.splice(0, logs.length);
      if (memory.buffer.byteLength > maxBytes) {
        throw new Error(`Guest memory is ${memory.buffer.byteLength} bytes. The limit is ${maxBytes}.`);
      }
      reply(id, true, JSON.stringify({ ok: status === 0, json: out, error: status === 0 ? "" : out || `Guest hook status ${status}.`, logs: taken }));
      return;
    }
    reply(id, false, "Unknown guest operation.");
  } catch (error) {
    reply(id, false, error instanceof Error ? error.message : "Guest failed.");
  }
};
