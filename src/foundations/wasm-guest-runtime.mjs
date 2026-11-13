const PAGE = 65536;
const MAX_TABLE = 256;
const textEncode = new TextEncoder();
const textDecode = new TextDecoder();

/**
 * Guest checks and the ABI call loop, shared by the Node worker and the browser worker.
 * The parent is not trusted to have performed them.
 * @param {(id: number, ok: boolean, text: string) => void} reply
 */
export function createGuestRuntime(reply) {
  /** @type {WebAssembly.Instance | null} */
  let instance = null;
  /** @type {WebAssembly.Memory | null} */
  let memory = null;
  /** @type {string[]} */
  let logs = [];
  let logBytes = 0;
  let dropped = false;
  const logBudget = { maxBytes: 4096, maxLines: 32, maxLine: 240 };

  /**
   * @param {number} ptr
   * @param {number} len
   */
  function copyOut(ptr, len) {
    if (!memory) throw new Error("Guest has no memory.");
    const start = ptr >>> 0;
    const size = len >>> 0;
    if (size === 0) return new Uint8Array();
    if (start + size > memory.buffer.byteLength) throw new Error("Guest pointer is outside its memory.");
    return new Uint8Array(memory.buffer.slice(start, start + size));
  }

  /**
   * @param {string} line
   */
  function pushLog(line) {
    const clipped = line.length > logBudget.maxLine ? line.slice(0, logBudget.maxLine) : line;
    if (dropped || logs.length >= logBudget.maxLines || logBytes + clipped.length > logBudget.maxBytes) {
      if (!dropped) {
        dropped = true;
        logs.push("[log dropped]");
      }
      return;
    }
    logs.push(clipped);
    logBytes += clipped.length;
  }

  /**
   * @param {Record<string, unknown>} message
   */
  function rememberLogBudget(message) {
    if (typeof message.maxLogBytes === "number" && message.maxLogBytes > 0) logBudget.maxBytes = message.maxLogBytes;
    if (typeof message.maxLogLines === "number" && message.maxLogLines > 0) logBudget.maxLines = message.maxLogLines;
    if (typeof message.maxLogLine === "number" && message.maxLogLine > 0) logBudget.maxLine = message.maxLogLine;
  }

  /**
   * @param {unknown} message
   */
  function onMessage(message) {
    const record = message && typeof message === "object" ? /** @type {Record<string, unknown>} */ (message) : {};
    const id = typeof record.id === "number" ? record.id : -1;
    try {
      rememberLogBudget(record);
      if (record.op === "release") {
        reply(id, true, "released");
        return;
      }
      if (record.op === "load") {
        const bytes = record.wasm instanceof Uint8Array ? record.wasm : new Uint8Array();
        const maxBytes = typeof record.maxBytes === "number" ? record.maxBytes : 0;
        assertGuestBinary(bytes, maxBytes, record.allowLog === true);
        const mod = new WebAssembly.Module(bytes);
        const imports = WebAssembly.Module.imports(mod);
        /** @type {WebAssembly.Imports} */
        const importObject = {};
        logs = [];
        logBytes = 0;
        dropped = false;
        for (const item of imports) {
          if (item.module !== "cgp.abi" || item.name !== "log" || item.kind !== "function") {
            throw new Error(`Unauthorized import ${item.module}.${item.name}`);
          }
          if (record.allowLog !== true) throw new Error("Capability cgp.log is not granted.");
          importObject["cgp.abi"] = {
            /**
             * @param {number} ptr
             * @param {number} len
             */
            log(ptr, len) {
              const size = Math.min(len >>> 0, logBudget.maxLine);
              pushLog(textDecode.decode(copyOut(ptr, size)));
            },
          };
        }
        instance = new WebAssembly.Instance(mod, importObject);
        const exported = /** @type {GuestExports} */ (instance.exports);
        if (!(exported.memory instanceof WebAssembly.Memory)) throw new Error("Guest did not export memory.");
        memory = exported.memory;
        assertMemory(memory, maxBytes);
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
      if (record.op === "hook") {
        if (!instance || !memory) throw new Error("Guest is not loaded.");
        const exported = /** @type {GuestExports} */ (instance.exports);
        const maxBytes = typeof record.maxBytes === "number" ? record.maxBytes : 0;
        const input = textEncode.encode(typeof record.json === "string" ? record.json : "");
        if (input.byteLength > maxBytes) throw new Error("Guest input exceeds the memory limit.");
        const ptr = exported.cg_alloc(input.length);
        if (input.length > 0 && ptr === 0) throw new Error("Guest refused the input allocation.");
        if (input.length > 0) new Uint8Array(memory.buffer, ptr, input.length).set(input);
        const status = exported.cg_hook(typeof record.hook === "number" ? record.hook : -1, ptr, input.length);
        const outPtr = exported.cg_out_ptr();
        const outLen = exported.cg_out_len();
        if (outLen > maxBytes || outLen < 0) throw new Error("Guest result exceeds the memory limit.");
        const out = textDecode.decode(copyOut(outPtr, outLen));
        const taken = logs.splice(0, logs.length);
        logBytes = 0;
        dropped = false;
        assertMemory(memory, maxBytes);
        reply(
          id,
          true,
          JSON.stringify({
            ok: status === 0,
            json: out,
            error: status === 0 ? "" : out || `Guest hook status ${status}.`,
            logs: taken,
          }),
        );
        return;
      }
      reply(id, false, "Unknown guest operation.");
    } catch (error) {
      reply(id, false, error instanceof Error ? error.message : "Guest failed.");
    }
  }

  return { onMessage };
}

/**
 * @typedef {{
 *   memory: WebAssembly.Memory,
 *   cg_alloc: (n: number) => number,
 *   cg_hook: (hook: number, ptr: number, len: number) => number,
 *   cg_out_ptr: () => number,
 *   cg_out_len: () => number,
 * }} GuestExports
 */

/**
 * @param {Uint8Array} bytes
 * @param {{ i: number }} at
 */
function readUleb(bytes, at) {
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

/**
 * @param {Uint8Array} bytes
 * @param {{ i: number }} at
 */
function readName(bytes, at) {
  const length = readUleb(bytes, at);
  const end = at.i + length;
  if (end > bytes.length) throw new Error("Truncated WebAssembly binary.");
  const text = new TextDecoder().decode(bytes.subarray(at.i, end));
  at.i = end;
  return text;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} maxBytes
 * @param {boolean} allowLog
 */
function assertGuestBinary(bytes, maxBytes, allowLog) {
  if (!(bytes instanceof Uint8Array)) throw new Error("Guest binary is missing.");
  if (bytes.byteLength > maxBytes) throw new Error("Guest binary exceeds the memory limit.");
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error("Module bytes are not WebAssembly.");
  }
  const at = { i: 8 };
  let sawMemory = false;
  while (at.i < bytes.length) {
    const id = bytes[at.i];
    at.i += 1;
    const size = readUleb(bytes, at);
    const end = at.i + size;
    if (end > bytes.length) throw new Error("Truncated WebAssembly binary.");
    if (id === 2) {
      const count = readUleb(bytes, at);
      for (let n = 0; n < count; n += 1) {
        const moduleName = readName(bytes, at);
        const field = readName(bytes, at);
        const kind = bytes[at.i];
        at.i += 1;
        if (kind === 0) readUleb(bytes, at);
        else if (kind === 1) {
          at.i += 1;
          const flags = readUleb(bytes, at);
          readUleb(bytes, at);
          if (flags & 1) readUleb(bytes, at);
        } else if (kind === 2) {
          const flags = readUleb(bytes, at);
          readUleb(bytes, at);
          if (flags & 1) readUleb(bytes, at);
          throw new Error("Guest imports memory. The host does not share memory.");
        } else if (kind === 3) at.i += 2;
        else throw new Error("Unsupported WebAssembly import.");
        if (moduleName !== "cgp.abi" || field !== "log" || kind !== 0) {
          throw new Error(`Unauthorized import ${moduleName}.${field}`);
        }
        if (!allowLog) throw new Error("Capability cgp.log is not granted.");
      }
    } else if (id === 4) {
      const count = readUleb(bytes, at);
      if (count !== 1) throw new Error("Guest must declare at most one table.");
      at.i += 1;
      const flags = readUleb(bytes, at);
      const min = readUleb(bytes, at);
      const max = flags & 1 ? readUleb(bytes, at) : null;
      if (flags & 2) throw new Error("Guest uses a shared table.");
      if (max === null) throw new Error("Guest table has no maximum.");
      if (max > MAX_TABLE || min > MAX_TABLE) throw new Error(`Guest table maximum is ${max} entries.`);
    } else if (id === 5) {
      const count = readUleb(bytes, at);
      if (count !== 1) throw new Error("Guest must declare exactly one memory.");
      const flags = readUleb(bytes, at);
      if (flags & 4) throw new Error("Guest uses 64-bit memory.");
      if (flags & 2) throw new Error("Guest uses shared memory.");
      const min = readUleb(bytes, at);
      const max = flags & 1 ? readUleb(bytes, at) : null;
      if (max === null) throw new Error("Guest memory has no maximum.");
      if (min * PAGE > maxBytes || max * PAGE > maxBytes) {
        throw new Error(`Guest memory maximum is ${max * PAGE} bytes. The limit is ${maxBytes}.`);
      }
      sawMemory = true;
    }
    at.i = end;
  }
  if (!sawMemory) throw new Error("Guest exports no memory limit.");
}

/**
 * @param {WebAssembly.Memory} guestMemory
 * @param {number} maxBytes
 */
function assertMemory(guestMemory, maxBytes) {
  if (guestMemory.buffer instanceof SharedArrayBuffer) throw new Error("Guest memory is shared. The host refuses it.");
  if (guestMemory.buffer.byteLength > maxBytes) {
    throw new Error(`Guest memory is ${guestMemory.buffer.byteLength} bytes. The limit is ${maxBytes}.`);
  }
}
