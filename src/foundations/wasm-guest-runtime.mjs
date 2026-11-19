// @ts-check
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
  /** @type {ArrayBuffer | null} */
  let pack = null;
  /** @type {Map<string, { offset: number, length: number }> | null} */
  let resources = null;
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
    const clipped = clipUtf8(line, logBudget.maxLine);
    const size = utf8Bytes(clipped);
    if (dropped || logs.length >= logBudget.maxLines || logBytes + size > logBudget.maxBytes) {
      if (!dropped) noteDrop();
      return;
    }
    logs.push(clipped);
    logBytes += size;
  }

  function noteDrop() {
    dropped = true;
    const marker = "[log dropped]";
    const markerSize = utf8Bytes(marker);
    if (markerSize > logBudget.maxBytes || logBudget.maxLines < 1) return;
    while (logs.length > 0 && (logBytes + markerSize > logBudget.maxBytes || logs.length >= logBudget.maxLines)) {
      const removed = logs.shift();
      if (removed !== undefined) logBytes -= utf8Bytes(removed);
    }
    if (logBytes + markerSize <= logBudget.maxBytes && logs.length < logBudget.maxLines) {
      logs.push(marker);
      logBytes += markerSize;
    }
  }

  /**
   * @param {Record<string, unknown>} message
   */
  function rememberLogBudget(message) {
    const maxBytes = finiteCap(message.maxLogBytes);
    if (maxBytes !== undefined) logBudget.maxBytes = maxBytes;
    const maxLines = finiteCap(message.maxLogLines);
    if (maxLines !== undefined) logBudget.maxLines = maxLines;
    const maxLine = finiteCap(message.maxLogLine);
    if (maxLine !== undefined) logBudget.maxLine = maxLine;
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
        pack = null;
        resources = null;
        /** @type {Uint8Array} */
        let bytes;
        if (record.pack instanceof ArrayBuffer || record.index !== undefined) {
          if (!(record.pack instanceof ArrayBuffer)) throw new Error("Resource index is malformed.");
          const indexError = acceptResourceIndex(record.pack, record.index);
          if (indexError) throw new Error(indexError);
          const index = /** @type {ResourceIndex} */ (record.index);
          resources = new Map(
            index.map(({ path, offset, length }) => [
              path,
              { offset, length },
            ]),
          );
          const wasm = resources.get("module.wasm");
          if (!wasm) throw new Error("Resource index is malformed.");
          bytes = new Uint8Array(record.pack, wasm.offset, wasm.length);
          pack = record.pack;
        } else {
          bytes = record.wasm instanceof Uint8Array ? record.wasm : new Uint8Array();
        }
        const maxBytes = typeof record.maxBytes === "number" ? record.maxBytes : 0;
        const maxBinaryBytes = typeof record.maxBinaryBytes === "number" ? record.maxBinaryBytes : maxBytes;
        const importsResource = assertGuestBinary(bytes, maxBytes, maxBinaryBytes, record.allowLog === true, record.allowResource === true);
        if (importsResource && !resources) throw new Error("Package resources are not available.");
        const mod = new WebAssembly.Module(bytes);
        const imports = WebAssembly.Module.imports(mod);
        /** @type {WebAssembly.Imports} */
        const importObject = {};
        /** @type {Record<string, Function>} */
        const abi = {};
        logs = [];
        logBytes = 0;
        dropped = false;
        for (const item of imports) {
          if (item.module !== "cgp.abi" || item.kind !== "function") {
            throw new Error(`Unauthorized import ${item.module}.${item.name}`);
          }
          if (item.name === "log") {
            if (record.allowLog !== true) throw new Error("Capability cgp.log is not granted.");
            /**
             * @param {number} ptr
             * @param {number} len
             */
            abi.log = (ptr, len) => {
              const size = Math.min(len >>> 0, logBudget.maxLine);
              pushLog(textDecode.decode(copyOut(ptr, size)));
            };
          } else if (item.name === "resource_read") {
            if (record.allowResource !== true || !resources || !pack) {
              throw new Error("Package resources are not available.");
            }
            abi.resource_read = readResource;
          } else {
            throw new Error(`Unauthorized import ${item.module}.${item.name}`);
          }
        }
        if (imports.length > 0) importObject["cgp.abi"] = abi;
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
        if (input.length > 0) new Uint8Array(/** @type {ArrayBuffer} */ (memory.buffer), ptr, input.length).set(input);
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

  /**
   * @param {number} pathPtr
   * @param {number} pathLen
   * @param {number} out
   * @param {number} outCap
   * @param {number} written
   */
  function readResource(pathPtr, pathLen, out, outCap, written) {
    if (!memory || !resources || !(pack instanceof ArrayBuffer)) return 5;
    const buffer = memory.buffer;
    if (typeof SharedArrayBuffer === "function" && buffer instanceof SharedArrayBuffer) return 5;
    if (!(buffer instanceof ArrayBuffer)) return 5;
    if (/** @type {{ detached?: boolean }} */ (buffer).detached === true) return 5;
    const writtenAt = written >>> 0;
    if (outOfRange(buffer.byteLength, writtenAt, 4)) return 4;
    const pathSize = pathLen >>> 0;
    if (pathSize > 240) return 3;
    const pathAt = pathPtr >>> 0;
    if (pathSize === 0) return 3;
    if (outOfRange(buffer.byteLength, pathAt, pathSize)) return 4;
    /** @type {string} */
    let key;
    try {
      key = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(buffer, pathAt, pathSize));
    } catch {
      return 3;
    }
    if (guestPathRejected(key)) return 3;
    const hit = resources.get(key);
    if (!hit) return 2;
    const n = hit.length;
    const cap = outCap >>> 0;
    const dest = out >>> 0;
    const view = new DataView(buffer);
    if (n > cap) {
      view.setUint32(writtenAt, n, true);
      return 1;
    }
    if (n > 0) {
      if (outOfRange(buffer.byteLength, dest, n)) return 4;
      if (rangesOverlap(dest, n, writtenAt, 4)) return 4;
      new Uint8Array(buffer, dest, n).set(new Uint8Array(pack, hit.offset, n));
    }
    view.setUint32(writtenAt, n, true);
    return 0;
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

/** @param {string} text */
function utf8Bytes(text) {
  return textEncode.encode(text).byteLength;
}

/**
 * A non-negative finite cap, or undefined when the host did not set one.
 * `0` is a real cap. Negative and non-finite values are ignored.
 * @param {unknown} value
 */
function finiteCap(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

/**
 * @param {string} text
 * @param {number} maxBytes
 */
function clipUtf8(text, maxBytes) {
  if (maxBytes <= 0) return "";
  const encoded = textEncode.encode(text);
  if (encoded.byteLength <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0) {
    const byte = encoded[end];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    end -= 1;
  }
  return textDecode.decode(encoded.subarray(0, end));
}

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
 * @param {{ i: number }} at
 * @param {number} end
 */
function readStartIndex(bytes, at, end) {
  if (at.i >= end) throw new Error("Malformed WebAssembly start section.");
  for (let n = 0; n < 5; n += 1) {
    if (at.i >= end) throw new Error("Malformed WebAssembly function index.");
    const byte = bytes[at.i];
    if (byte === undefined) throw new Error("Truncated WebAssembly binary.");
    at.i += 1;
    if (n === 4 && ((byte & 0x80) !== 0 || byte > 0x0f)) {
      throw new Error("Malformed WebAssembly function index.");
    }
    if ((byte & 0x80) === 0) {
      if (at.i !== end) throw new Error("Malformed WebAssembly start section.");
      return;
    }
  }
  throw new Error("Malformed WebAssembly function index.");
}

/**
 * @param {Uint8Array} bytes
 * @param {number} maxBytes
 * @param {number} maxBinaryBytes
 * @param {boolean} allowLog
 * @param {boolean} allowResource
 * @returns {boolean}
 */
function assertGuestBinary(bytes, maxBytes, maxBinaryBytes, allowLog, allowResource) {
  if (!(bytes instanceof Uint8Array)) throw new Error("Guest binary is missing.");
  if (bytes.byteLength > maxBinaryBytes) {
    throw new Error(`Guest binary is ${bytes.byteLength} bytes. The binary limit is ${maxBinaryBytes}.`);
  }
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error("Module bytes are not WebAssembly.");
  }
  const at = { i: 8 };
  let sawMemory = false;
  let hasStart = false;
  let importsResource = false;
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
        const isLog = moduleName === "cgp.abi" && field === "log" && kind === 0;
        const isResource = moduleName === "cgp.abi" && field === "resource_read" && kind === 0;
        if (!isLog && !isResource) throw new Error(`Unauthorized import ${moduleName}.${field}`);
        if (isLog && !allowLog) throw new Error("Capability cgp.log is not granted.");
        if (isResource && !allowResource) throw new Error("Capability cgp.resource.read is not granted.");
        if (isResource) importsResource = true;
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
    } else if (id === 8) {
      if (hasStart) throw new Error("Malformed WebAssembly start section.");
      readStartIndex(bytes, at, end);
      hasStart = true;
    }
    at.i = end;
  }
  if (importsResource && hasStart) {
    throw new Error("Guest imports cgp.abi.resource_read and has a start section.");
  }
  if (!sawMemory) throw new Error("Guest exports no memory limit.");
  return importsResource;
}

/**
 * @param {WebAssembly.Memory} guestMemory
 * @param {number} maxBytes
 */
function assertMemory(guestMemory, maxBytes) {
  if (typeof SharedArrayBuffer === "function" && guestMemory.buffer instanceof SharedArrayBuffer) {
    throw new Error("Guest memory is shared. The host refuses it.");
  }
  if (guestMemory.buffer.byteLength > maxBytes) {
    throw new Error(`Guest memory is ${guestMemory.buffer.byteLength} bytes. The limit is ${maxBytes}.`);
  }
}

/**
 * @typedef {{ path: string, offset: number, length: number }} ResourceRecord
 * @typedef {ResourceRecord[]} ResourceIndex
 */

/**
 * @param {number} byteLength
 * @param {number} start
 * @param {number} size
 */
function outOfRange(byteLength, start, size) {
  return size > byteLength || start > byteLength - size;
}

/**
 * @param {number} start
 * @param {number} size
 * @param {number} other
 * @param {number} otherSize
 */
function rangesOverlap(start, size, other, otherSize) {
  if (size === 0 || otherSize === 0) return false;
  return start < other + otherSize && other < start + size;
}

/** @param {string} path */
function guestPathRejected(path) {
  if (utf8Bytes(path) > 240) return true;
  if (path.split("/").length > 16) return true;
  return packagePathErrors([path]) !== undefined;
}

const PATH_COMPONENT = /^[A-Za-z0-9._-]+$/;
const WINDOWS_DEVICE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

/** @param {readonly string[]} paths */
function packagePathErrors(paths) {
  const exact = new Set();
  const folded = new Set();
  /** @type {Map<string, string>} */
  const componentSpellings = new Map();
  for (const path of paths) {
    if (typeof path !== "string" || path.length === 0) return "empty";
    if (utf8Bytes(path) > 240) return "length";
    if (path.startsWith("/") || path.includes("\\") || path.includes(":")) return "absolute";
    const components = path.split("/");
    if (components.length > 16) return "depth";
    if (components.some((part) => part.length === 0 || part === "." || part === "..")) return "component";
    if (components.some((part) => !PATH_COMPONENT.test(part) || part.endsWith("."))) return "grammar";
    if (components.some((part) => WINDOWS_DEVICE.test(part))) return "device";
    if (components.some((part) => part.toLowerCase() === "node_modules")) return "forbidden";
    const basename = components[components.length - 1]?.toLowerCase();
    if (basename === "package.json" || basename === "module.ts") return "forbidden";
    const key = path.toLowerCase();
    if (exact.has(path) || folded.has(key)) return "collision";
    let prefix = "";
    for (const part of components) {
      prefix = prefix ? prefix + "/" + part : part;
      const foldedPrefix = prefix.toLowerCase();
      const previous = componentSpellings.get(foldedPrefix);
      if (previous !== undefined && previous !== prefix) return "collision";
      componentSpellings.set(foldedPrefix, prefix);
    }
    exact.add(path);
    folded.add(key);
  }
  for (const path of exact) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      const parent = parts.slice(0, i).join("/");
      if (exact.has(parent)) return "collision";
    }
  }
  return undefined;
}

/** @param {unknown} value */
function safeNonNegative(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Reject a resource index. Returns a stable error, or undefined when the index
 * is an exact partition of the pack and includes `module.wasm`.
 * @param {ArrayBuffer | number} pack
 * @param {unknown} index
 */
export function acceptResourceIndex(pack, index) {
  const byteLength = typeof pack === "number" ? pack : pack instanceof ArrayBuffer ? pack.byteLength : null;
  if (byteLength === null || !safeNonNegative(byteLength)) return "Resource index is malformed.";
  if (!Array.isArray(index)) return "Resource index is malformed.";
  if (index.length > 4096) return "Resource index is malformed.";
  /** @type {string[]} */
  const paths = [];
  /** @type {{ offset: number, length: number }[]} */
  const ranges = [];
  let sum = 0;
  let sawWasm = false;
  for (const record of index) {
    if (!record || typeof record !== "object") return "Resource index is malformed.";
    const path = /** @type {{ path?: unknown, offset?: unknown, length?: unknown }} */ (record).path;
    const offset = /** @type {{ offset?: unknown }} */ (record).offset;
    const length = /** @type {{ length?: unknown }} */ (record).length;
    if (typeof path !== "string") return "Resource index is malformed.";
    if (!safeNonNegative(offset) || !safeNonNegative(length)) return "Resource index is malformed.";
    if (outOfRange(byteLength, offset, length)) return "Resource index is malformed.";
    paths.push(path);
    ranges.push({ offset, length });
    if (sum > Number.MAX_SAFE_INTEGER - length) return "Resource index is malformed.";
    sum += length;
    if (path === "module.wasm") sawWasm = true;
  }
  if (packagePathErrors(paths) !== undefined) return "Resource index is malformed.";
  const ordered = [...ranges].sort((a, b) => a.offset - b.offset || a.length - b.length);
  let cursor = 0;
  for (const range of ordered) {
    if (range.offset < cursor) return "Resource index is malformed.";
    if (range.offset > cursor) return "Resource index is malformed.";
    cursor = range.offset + range.length;
  }
  if (cursor !== byteLength || sum !== byteLength) return "Resource index is malformed.";
  if (!sawWasm) return "Resource index is malformed.";
  return undefined;
}

/**
 * Copy one guest's files into one exact ArrayBuffer. The source views are not transferred.
 * @param {readonly { path: string, bytes: Uint8Array }[]} files
 * @param {Uint8Array} artifact
 * @param {{ maxSnapshotBytes: number, packedBytes?: number, allocate?: (size: number) => ArrayBuffer }} options
 */
export function packPackageFiles(files, artifact, options) {
  if (!Array.isArray(files) || !(artifact instanceof Uint8Array)) throw new Error("Resource index is malformed.");
  const budget = options.maxSnapshotBytes;
  const already = options.packedBytes ?? 0;
  if (!safeNonNegative(budget) || !safeNonNegative(already) || already > budget) {
    throw new Error("Resource pack exceeds the snapshot budget.");
  }
  /** @type {{ path: string, bytes: Uint8Array }[]} */
  const ordered = [];
  for (const file of files) {
    if (!file || typeof file.path !== "string" || !(file.bytes instanceof Uint8Array)) {
      throw new Error("Resource index is malformed.");
    }
    ordered.push({ path: file.path, bytes: file.bytes });
  }
  ordered.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (ordered.length > 4096) throw new Error("Resource index is malformed.");
  let total = 0;
  /** @type {Uint8Array | null} */
  let wasmBytes = null;
  /** @type {ResourceIndex} */
  const index = [];
  for (const file of ordered) {
    const n = file.bytes.byteLength;
    if (!safeNonNegative(n) || total > Number.MAX_SAFE_INTEGER - n) throw new Error("Resource index is malformed.");
    index.push({ path: file.path, offset: total, length: n });
    total += n;
    if (file.path === "module.wasm") wasmBytes = file.bytes;
  }
  if (!wasmBytes || wasmBytes.byteLength !== artifact.byteLength) throw new Error("Resource index is malformed.");
  for (let i = 0; i < artifact.byteLength; i += 1) {
    if (wasmBytes[i] !== artifact[i]) throw new Error("Resource index is malformed.");
  }
  if (packagePathErrors(ordered.map((file) => file.path)) !== undefined) throw new Error("Resource index is malformed.");
  const preview = acceptResourceIndex(total, index);
  if (preview) throw new Error(preview);
  if (total > budget - already) throw new Error("Resource pack exceeds the snapshot budget.");
  const allocate = options.allocate ?? ((size) => new ArrayBuffer(size));
  const pack = allocate(total);
  if (!(pack instanceof ArrayBuffer) || pack.byteLength !== total) throw new Error("Could not allocate the resource pack.");
  const dest = new Uint8Array(pack);
  for (const record of index) {
    const file = ordered.find((item) => item.path === record.path && item.bytes.byteLength === record.length);
    if (!file) throw new Error("Resource index is malformed.");
    dest.set(file.bytes, record.offset);
  }
  const checked = acceptResourceIndex(pack, index);
  if (checked) throw new Error(checked);
  return { pack, index, bytes: total };
}
