/** Builds the small WebAssembly fixtures the isolation tests run. This is not a compiler. */

const I32 = 0x7f;

function uleb(value: number): number[] {
  if (!Number.isInteger(value) || value < 0) throw new Error(`bad uleb ${value}`);
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

function sleb(value: number): number[] {
  let rest = value | 0;
  const out: number[] = [];
  for (;;) {
    const byte = rest & 0x7f;
    rest >>= 7;
    if ((rest === 0 && (byte & 0x40) === 0) || (rest === -1 && (byte & 0x40) !== 0)) {
      out.push(byte);
      break;
    }
    out.push(byte | 0x80);
  }
  return out;
}

function name(text: string): number[] {
  const bytes = [...Buffer.from(text)];
  return [...uleb(bytes.length), ...bytes];
}

function section(id: number, body: number[]): number[] {
  return [id, ...uleb(body.length), ...body];
}

const op = {
  end: [0x0b],
  block: [0x02, 0x40],
  loop: [0x03, 0x40],
  if: [0x04, 0x40],
  br: (n: number) => [0x0c, ...uleb(n)],
  brIf: (n: number) => [0x0d, ...uleb(n)],
  ret: [0x0f],
  call: (n: number) => [0x10, ...uleb(n)],
  drop: [0x1a],
  localGet: (n: number) => [0x20, ...uleb(n)],
  localSet: (n: number) => [0x21, ...uleb(n)],
  localTee: (n: number) => [0x22, ...uleb(n)],
  globalGet: (n: number) => [0x23, ...uleb(n)],
  globalSet: (n: number) => [0x24, ...uleb(n)],
  i32Const: (n: number) => [0x41, ...sleb(n)],
  i32Eqz: [0x45],
  i32Eq: [0x46],
  i32Ne: [0x47],
  i32LtS: [0x48],
  i32LtU: [0x49],
  i32GtS: [0x4a],
  i32GtU: [0x4b],
  i32LeU: [0x4d],
  i32GeU: [0x4f],
  i32Add: [0x6a],
  i32Sub: [0x6b],
  i32Mul: [0x6c],
  i32DivU: [0x6e],
  i32RemU: [0x70],
  i32Load8U: [0x2d, 0x00, 0x00],
  i32Store8: [0x3a, 0x00, 0x00],
  memoryGrow: [0x40, 0x00],
};

/** Opcode helpers for a guest built outside this file. */
export const wasmOp = op;

function funcBody(localCount: number, body: number[]): number[] {
  const locals = localCount > 0 ? [1, ...uleb(localCount), I32] : [0];
  const bytes = [...locals, ...body, ...op.end];
  return [...uleb(bytes.length), ...bytes];
}

type FnType = { params: number; results: number };
type Fn = { type: number; locals?: number; body: number[] };
type Imp = { module: string; name: string; type: number };
type Glob = { init: number };

export type WasmSpec = {
  types: FnType[];
  imports?: Imp[];
  funcs: Fn[];
  memory: { min: number; max?: number; shared?: boolean };
  tables?: { min: number; max?: number }[];
  globals?: Glob[];
  exports: { name: string; kind: "func" | "mem"; index: number }[];
  data?: { offset: number; bytes: Uint8Array }[];
  start?: number;
};

function typeBytes(types: FnType[]): number[] {
  return [
    ...uleb(types.length),
    ...types.flatMap((item) => [0x60, ...uleb(item.params), ...Array(item.params).fill(I32), ...uleb(item.results), ...Array(item.results).fill(I32)]),
  ];
}

export function compileWasm(spec: WasmSpec): Uint8Array {
  const imports = spec.imports ?? [];
  const globals = spec.globals ?? [];
  const tables = spec.tables ?? [];
  const data = spec.data ?? [];
  const type = section(1, typeBytes(spec.types));
  const imported = section(
    2,
    [
      ...uleb(imports.length),
      ...imports.flatMap((item) => [...name(item.module), ...name(item.name), 0x00, ...uleb(item.type)]),
    ],
  );
  const func = section(3, [...uleb(spec.funcs.length), ...spec.funcs.flatMap((item) => uleb(item.type))]);
  const table = section(4, [
    ...uleb(tables.length),
    ...tables.flatMap((item) => [
      0x70,
      ...(item.max === undefined ? [0x00, ...uleb(item.min)] : [0x01, ...uleb(item.min), ...uleb(item.max)]),
    ]),
  ]);
  const memoryFlags = (spec.memory.max === undefined ? 0 : 1) | (spec.memory.shared ? 2 : 0);
  const memory = section(5, [
    1,
    memoryFlags,
    ...uleb(spec.memory.min),
    ...(spec.memory.max === undefined ? [] : uleb(spec.memory.max)),
  ]);
  const global = section(
    6,
    [
      ...uleb(globals.length),
      ...globals.flatMap((item) => [I32, 0x01, ...op.i32Const(item.init), ...op.end]),
    ],
  );
  const exported = section(
    7,
    [
      ...uleb(spec.exports.length),
      ...spec.exports.flatMap((item) => [...name(item.name), item.kind === "func" ? 0x00 : 0x02, ...uleb(item.index)]),
    ],
  );
  const start = spec.start === undefined ? [] : section(8, uleb(spec.start));
  const code = section(10, [
    ...uleb(spec.funcs.length),
    ...spec.funcs.flatMap((item) => funcBody(item.locals ?? 0, item.body)),
  ]);
  const datum = section(11, [
    ...uleb(data.length),
    ...data.flatMap((item) => [0x00, ...op.i32Const(item.offset), ...op.end, ...uleb(item.bytes.length), ...item.bytes]),
  ]);
  const parts = [
    type,
    imports.length ? imported : [],
    func,
    tables.length ? table : [],
    memory,
    globals.length ? global : [],
    exported,
    start,
    code,
    data.length ? datum : [],
  ];
  return Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...parts.flat()]);
}

const text = (value: string) => new TextEncoder().encode(value);

function allocFunc(): Fn {
  return {
    type: 1,
    locals: 1,
    body: [
      ...op.localGet(0),
      ...op.i32Eqz,
      ...op.if,
      ...op.i32Const(0),
      ...op.ret,
      ...op.end,
      ...op.globalGet(0),
      ...op.localSet(1),
      ...op.localGet(1),
      ...op.localGet(0),
      ...op.i32Add,
      ...op.i32Const(65536),
      ...op.i32GtU,
      ...op.if,
      ...op.i32Const(0),
      ...op.ret,
      ...op.end,
      ...op.localGet(1),
      ...op.localGet(0),
      ...op.i32Add,
      ...op.globalSet(0),
      ...op.localGet(1),
    ],
  };
}

function outPtrFunc(): Fn {
  return { type: 2, body: [...op.globalGet(1)] };
}

function outLenFunc(): Fn {
  return { type: 2, body: [...op.globalGet(2)] };
}

const STANDARD_TYPES: FnType[] = [
  { params: 3, results: 1 },
  { params: 1, results: 1 },
  { params: 0, results: 1 },
];

function standardExports(funcBase: number): WasmSpec["exports"] {
  return [
    { name: "memory", kind: "mem", index: 0 },
    { name: "cg_alloc", kind: "func", index: funcBase },
    { name: "cg_out_ptr", kind: "func", index: funcBase + 1 },
    { name: "cg_out_len", kind: "func", index: funcBase + 2 },
    { name: "cg_hook", kind: "func", index: funcBase + 3 },
  ];
}

/** `cg_alloc`, `cg_out_ptr`, and `cg_out_len`, in that order. A guest appends `cg_hook`. */
export function abiSupportFuncs(): Fn[] {
  return [allocFunc(), outPtrFunc(), outLenFunc()];
}

export function abiExports(funcBase: number): WasmSpec["exports"] {
  return standardExports(funcBase);
}

/** Copies an imported JSON payload and later exports those same bytes. */
export function storeGuest(registerJson: string): Uint8Array {
  const register = text(registerJson);
  const initial = text('{"count":0}');
  const copy: number[] = [
    ...op.localGet(0),
    ...op.i32Const(4),
    ...op.i32Eq,
    ...op.if,
    ...op.localGet(2),
    ...op.i32Const(128),
    ...op.i32GtU,
    ...op.if,
    ...op.i32Const(1),
    ...op.ret,
    ...op.end,
    ...op.i32Const(0),
    ...op.localSet(3),
    ...op.block,
    ...op.loop,
    ...op.localGet(3),
    ...op.localGet(2),
    ...op.i32GeU,
    ...op.brIf(1),
    ...op.localGet(3),
    ...op.i32Const(512),
    ...op.i32Add,
    ...op.localGet(1),
    ...op.localGet(3),
    ...op.i32Add,
    ...op.i32Load8U,
    ...op.i32Store8,
    ...op.localGet(3),
    ...op.i32Const(1),
    ...op.i32Add,
    ...op.localSet(3),
    ...op.br(0),
    ...op.end,
    ...op.end,
    ...op.i32Const(512),
    ...op.globalSet(1),
    ...op.localGet(2),
    ...op.globalSet(2),
    ...op.localGet(2),
    ...op.globalSet(3),
    ...op.i32Const(0),
    ...op.ret,
    ...op.end,
    ...op.localGet(0),
    ...op.i32Eqz,
    ...op.if,
    ...op.i32Const(400),
    ...op.globalSet(1),
    ...op.i32Const(register.length),
    ...op.globalSet(2),
    ...op.i32Const(0),
    ...op.ret,
    ...op.end,
    ...op.i32Const(512),
    ...op.globalSet(1),
    ...op.globalGet(3),
    ...op.globalSet(2),
    ...op.i32Const(0),
  ];
  return compileWasm({
    types: STANDARD_TYPES,
    funcs: [allocFunc(), outPtrFunc(), outLenFunc(), { type: 0, locals: 1, body: copy }],
    memory: { min: 1, max: 1 },
    globals: [{ init: 1024 }, { init: 512 }, { init: initial.length }, { init: initial.length }],
    exports: standardExports(0),
    data: [
      { offset: 400, bytes: register },
      { offset: 512, bytes: initial },
    ],
  });
}

/** Increments its own digit. A second instance must not see that digit. */
export function counterGuest(): Uint8Array {
  const register = text('{"contributions":[{"slotId":"meter.hear","id":"a","dispatch":true}]}');
  const shown = text('{"n":0}');
  const body = [
    ...op.localGet(0),
    ...op.i32Const(5),
    ...op.i32Eq,
    ...op.if,
    ...op.i32Const(261),
    ...op.i32Const(261),
    ...op.i32Load8U,
    ...op.i32Const(1),
    ...op.i32Add,
    ...op.i32Store8,
    ...op.end,
    ...op.localGet(0),
    ...op.i32Eqz,
    ...op.if,
    ...op.i32Const(0),
    ...op.i32Const(0xab),
    ...op.i32Store8,
    ...op.i32Const(300),
    ...op.globalSet(1),
    ...op.i32Const(register.length),
    ...op.globalSet(2),
    ...op.i32Const(0),
    ...op.ret,
    ...op.end,
    ...op.i32Const(256),
    ...op.globalSet(1),
    ...op.i32Const(shown.length),
    ...op.globalSet(2),
    ...op.i32Const(0),
  ];
  return compileWasm({
    types: STANDARD_TYPES,
    funcs: [allocFunc(), outPtrFunc(), outLenFunc(), { type: 0, body }],
    memory: { min: 1, max: 1 },
    globals: [{ init: 1024 }, { init: 256 }, { init: shown.length }],
    exports: standardExports(0),
    data: [
      { offset: 256, bytes: shown },
      { offset: 300, bytes: register },
    ],
  });
}

/** Reads address 0. Foreign bytes fail the hook. */
export function readerGuest(): Uint8Array {
  const register = text('{"contributions":[{"slotId":"meter.hear","id":"b","dispatch":true}]}');
  const ok = text('{"b0":0}');
  const body = [
    ...op.i32Const(0),
    ...op.i32Load8U,
    ...op.i32Eqz,
    ...op.if,
    ...op.localGet(0),
    ...op.i32Eqz,
    ...op.if,
    ...op.i32Const(300),
    ...op.globalSet(1),
    ...op.i32Const(register.length),
    ...op.globalSet(2),
    ...op.i32Const(0),
    ...op.ret,
    ...op.end,
    ...op.i32Const(256),
    ...op.globalSet(1),
    ...op.i32Const(ok.length),
    ...op.globalSet(2),
    ...op.i32Const(0),
    ...op.ret,
    ...op.end,
    ...op.i32Const(1),
  ];
  return compileWasm({
    types: STANDARD_TYPES,
    funcs: [allocFunc(), outPtrFunc(), outLenFunc(), { type: 0, body }],
    memory: { min: 1, max: 1 },
    globals: [{ init: 1024 }, { init: 256 }, { init: ok.length }],
    exports: standardExports(0),
    data: [
      { offset: 256, bytes: ok },
      { offset: 300, bytes: register },
    ],
  });
}

export function loopingGuest(): Uint8Array {
  return compileWasm({
    types: STANDARD_TYPES,
    funcs: [
      allocFunc(),
      outPtrFunc(),
      outLenFunc(),
      { type: 0, body: [...op.loop, ...op.br(0), ...op.end, ...op.i32Const(0)] },
    ],
    memory: { min: 1, max: 1 },
    globals: [{ init: 1024 }, { init: 0 }, { init: 0 }],
    exports: standardExports(0),
  });
}

/** Start runs the loop. The binary is valid; instantiation never returns. Discovery must not instantiate it. */
export function startLoopGuest(): Uint8Array {
  return compileWasm({
    types: [{ params: 0, results: 0 }],
    funcs: [{ type: 0, body: [...op.loop, ...op.br(0), ...op.end] }],
    memory: { min: 1, max: 1 },
    exports: [
      { name: "memory", kind: "mem", index: 0 },
      { name: "cg_start", kind: "func", index: 0 },
    ],
    start: 0,
  });
}

export function wasiGuest(): Uint8Array {
  return compileWasm({
    types: [...STANDARD_TYPES, { params: 4, results: 1 }],
    imports: [{ module: "wasi_snapshot_preview1", name: "fd_write", type: 3 }],
    funcs: [
      allocFunc(),
      outPtrFunc(),
      outLenFunc(),
      {
        type: 0,
        body: [
          ...op.i32Const(0),
          ...op.i32Const(0),
          ...op.i32Const(0),
          ...op.i32Const(0),
          ...op.call(0),
          ...op.drop,
          ...op.i32Const(0),
        ],
      },
    ],
    memory: { min: 1, max: 1 },
    globals: [{ init: 1024 }, { init: 0 }, { init: 0 }],
    exports: standardExports(1),
  });
}

export function logGuest(allowedName = "cgp.abi"): Uint8Array {
  const ping = text("ping");
  const ok = text('{"ok":true}');
  return compileWasm({
    types: [...STANDARD_TYPES, { params: 2, results: 0 }],
    imports: [{ module: allowedName, name: "log", type: 3 }],
    funcs: [
      allocFunc(),
      outPtrFunc(),
      outLenFunc(),
      {
        type: 0,
        body: [
          ...op.i32Const(200),
          ...op.i32Const(ping.length),
          ...op.call(0),
          ...op.i32Const(256),
          ...op.globalSet(1),
          ...op.i32Const(ok.length),
          ...op.globalSet(2),
          ...op.i32Const(0),
        ],
      },
    ],
    memory: { min: 1, max: 1 },
    globals: [{ init: 1024 }, { init: 256 }, { init: ok.length }],
    exports: standardExports(1),
    data: [
      { offset: 200, bytes: ping },
      { offset: 256, bytes: ok },
    ],
  });
}

export function unboundedGuest(): Uint8Array {
  return compileWasm({
    types: STANDARD_TYPES,
    funcs: [allocFunc(), outPtrFunc(), outLenFunc(), { type: 0, body: [...op.i32Const(0)] }],
    memory: { min: 1 },
    globals: [{ init: 1024 }, { init: 0 }, { init: 0 }],
    exports: standardExports(0),
  });
}

export function growGuest(): Uint8Array {
  return compileWasm({
    types: STANDARD_TYPES,
    funcs: [
      allocFunc(),
      outPtrFunc(),
      outLenFunc(),
      {
        type: 0,
        body: [
          ...op.i32Const(1),
          ...op.memoryGrow,
          ...op.i32Const(-1),
          ...op.i32Eq,
          ...op.if,
          ...op.i32Const(0),
          ...op.ret,
          ...op.end,
          ...op.i32Const(1),
        ],
      },
    ],
    memory: { min: 1, max: 1 },
    globals: [{ init: 1024 }, { init: 0 }, { init: 0 }],
    exports: standardExports(0),
  });
}

/** Two pages declared. A one-page policy must refuse this before it runs. */
export function wideGuest(): Uint8Array {
  return compileWasm({
    types: STANDARD_TYPES,
    funcs: [allocFunc(), outPtrFunc(), outLenFunc(), { type: 0, body: [...op.i32Const(0)] }],
    memory: { min: 2, max: 2 },
    globals: [{ init: 1024 }, { init: 0 }, { init: 0 }],
    exports: standardExports(0),
  });
}

/** A table with no maximum. Refused before instantiation. */
export function openTableGuest(): Uint8Array {
  return compileWasm({
    types: STANDARD_TYPES,
    funcs: [allocFunc(), outPtrFunc(), outLenFunc(), { type: 0, body: [...op.i32Const(0)] }],
    memory: { min: 1, max: 1 },
    tables: [{ min: 1 }],
    globals: [{ init: 1024 }, { init: 0 }, { init: 0 }],
    exports: standardExports(0),
  });
}

/** A table larger than the host allows. Refused before instantiation. */
export function hugeTableGuest(): Uint8Array {
  return compileWasm({
    types: STANDARD_TYPES,
    funcs: [allocFunc(), outPtrFunc(), outLenFunc(), { type: 0, body: [...op.i32Const(0)] }],
    memory: { min: 1, max: 1 },
    tables: [{ min: 1_000_000, max: 1_000_000 }],
    globals: [{ init: 1024 }, { init: 0 }, { init: 0 }],
    exports: standardExports(0),
  });
}

/** Shared linear memory. The host does not attach it. */
export function sharedGuest(): Uint8Array {
  return compileWasm({
    types: STANDARD_TYPES,
    funcs: [allocFunc(), outPtrFunc(), outLenFunc(), { type: 0, body: [...op.i32Const(0)] }],
    memory: { min: 1, max: 1, shared: true },
    globals: [{ init: 1024 }, { init: 0 }, { init: 0 }],
    exports: standardExports(0),
  });
}

/** Loops only while shutting down. Register and every other hook return. */
export function shutdownLoopGuest(): Uint8Array {
  const body = [
    ...op.localGet(0),
    ...op.i32Const(2),
    ...op.i32Eq,
    ...op.if,
    ...op.loop,
    ...op.br(0),
    ...op.end,
    ...op.end,
    ...op.i32Const(0),
  ];
  return compileWasm({
    types: STANDARD_TYPES,
    funcs: [allocFunc(), outPtrFunc(), outLenFunc(), { type: 0, body }],
    memory: { min: 1, max: 1 },
    globals: [{ init: 1024 }, { init: 0 }, { init: 0 }],
    exports: standardExports(0),
  });
}

/** Loops only while a caller invokes the contribution. Register and every other hook return. */
export function callLoopGuest(id: string): Uint8Array {
  const register = text(
    JSON.stringify({
      contributions: [{ slotId: "platform.systems", id, dispatch: true, payload: { systemId: id } }],
    }),
  );
  const body = [
    ...op.localGet(0),
    ...op.i32Eqz,
    ...op.if,
    ...op.i32Const(400),
    ...op.globalSet(1),
    ...op.i32Const(register.length),
    ...op.globalSet(2),
    ...op.i32Const(0),
    ...op.ret,
    ...op.end,
    ...op.localGet(0),
    ...op.i32Const(5),
    ...op.i32Eq,
    ...op.if,
    ...op.loop,
    ...op.br(0),
    ...op.end,
    ...op.end,
    ...op.i32Const(0),
  ];
  return compileWasm({
    types: STANDARD_TYPES,
    funcs: [allocFunc(), outPtrFunc(), outLenFunc(), { type: 0, body }],
    memory: { min: 1, max: 1 },
    globals: [{ init: 1024 }, { init: 0 }, { init: 0 }],
    exports: standardExports(0),
    data: [{ offset: 400, bytes: register }],
  });
}

/** Copyable guest. It contributes one opaque record and does not import anything. */
export function templateGuest(): Uint8Array {
  return storeGuest(
    JSON.stringify({
      contributions: [
        {
          slotId: "platform.systems",
          id: "starter",
          payload: { systemId: "starter", label: "Starter" },
        },
      ],
    }),
  );
}

export type GuestContribution = {
  slotId: string;
  id: string;
  payload?: unknown;
  order?: number;
  dispatch?: boolean;
};

/** A third-party guest whose only behavior is the contributions in its register result. */
export function guestFromContributions(contributions: readonly GuestContribution[]): Uint8Array {
  return storeGuest(JSON.stringify({ contributions }));
}

/** Register succeeds. Initialize returns a failure status so the host rolls the composition back. */
export function initFaultGuest(): Uint8Array {
  const register = text(
    JSON.stringify({
      contributions: [{ slotId: "platform.systems", id: "fault", payload: { systemId: "fault" } }],
    }),
  );
  const body = [
    ...op.localGet(0),
    ...op.i32Eqz,
    ...op.if,
    ...op.i32Const(400),
    ...op.globalSet(1),
    ...op.i32Const(register.length),
    ...op.globalSet(2),
    ...op.i32Const(0),
    ...op.ret,
    ...op.end,
    ...op.localGet(0),
    ...op.i32Const(1),
    ...op.i32Eq,
    ...op.if,
    ...op.i32Const(1),
    ...op.ret,
    ...op.end,
    ...op.i32Const(0),
  ];
  return compileWasm({
    types: STANDARD_TYPES,
    funcs: [allocFunc(), outPtrFunc(), outLenFunc(), { type: 0, body }],
    memory: { min: 1, max: 1 },
    globals: [{ init: 1024 }, { init: 0 }, { init: 0 }],
    exports: standardExports(0),
    data: [{ offset: 400, bytes: register }],
  });
}

/** Passes the binary checks, instantiates, then fails because `cg_hook` is missing. */
export function missingAbiGuest(): Uint8Array {
  return compileWasm({
    types: STANDARD_TYPES,
    funcs: [allocFunc(), outPtrFunc(), outLenFunc()],
    memory: { min: 1, max: 1 },
    globals: [{ init: 1024 }, { init: 0 }, { init: 0 }],
    exports: [
      { name: "memory", kind: "mem", index: 0 },
      { name: "cg_alloc", kind: "func", index: 0 },
      { name: "cg_out_ptr", kind: "func", index: 1 },
      { name: "cg_out_len", kind: "func", index: 2 },
    ],
  });
}
