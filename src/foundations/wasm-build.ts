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
  const bytes = [...new TextEncoder().encode(text)];
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
  i32Load: [0x28, 0x02, 0x00],
  i32Store8: [0x3a, 0x00, 0x00],
  i32Store: [0x36, 0x02, 0x00],
  i32And: [0x71],
  i32ShrU: [0x76],
  memorySize: [0x3f, 0x00],
  memoryGrow: [0x40, 0x00],
};

/** Opcode helpers for a guest built outside this file. */
export const wasmOp = op;

function funcBody(localCount: number, body: number[]): number[] {
  const locals = localCount > 0 ? [1, ...uleb(localCount), I32] : [0];
  const bytes = [...locals, ...body, ...op.end];
  return [...uleb(bytes.length), ...bytes];
}

type FnType = { params: number; results: number; paramTypes?: readonly number[]; resultTypes?: readonly number[] };
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
    ...types.flatMap((item) => {
      const params = item.paramTypes ?? Array.from({ length: item.params }, () => I32);
      const results = item.resultTypes ?? Array.from({ length: item.results }, () => I32);
      return [0x60, ...uleb(params.length), ...params, ...uleb(results.length), ...results];
    }),
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

/** Copies an imported JSON payload and later exports those same bytes. A call can echo its input bytes. */
export function storeGuest(registerJson: string, echoCalls = false): Uint8Array {
  const register = text(registerJson);
  const initial = text('{"count":0}');
  const registerAt = 400;
  const heapAt = 1024;
  const stateLimit = 128;
  // State sits at 512 unless the register blob needs that room. The two must not overlap.
  const stateAt = Math.max(512, registerAt + register.length);
  if (stateAt + stateLimit > heapAt) {
    throw new Error(`Register payload is ${register.length} bytes. It must end before the guest heap.`);
  }
  const echo: number[] = echoCalls
    ? [
        ...op.localGet(0),
        ...op.i32Const(5),
        ...op.i32Eq,
        ...op.if,
        ...op.localGet(1),
        ...op.globalSet(1),
        ...op.localGet(2),
        ...op.globalSet(2),
        ...op.i32Const(0),
        ...op.ret,
        ...op.end,
      ]
    : [];
  const copy: number[] = [
    ...echo,
    ...op.localGet(0),
    ...op.i32Const(4),
    ...op.i32Eq,
    ...op.if,
    ...op.localGet(2),
    ...op.i32Const(stateLimit),
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
    ...op.i32Const(stateAt),
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
    ...op.i32Const(stateAt),
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
    ...op.i32Const(registerAt),
    ...op.globalSet(1),
    ...op.i32Const(register.length),
    ...op.globalSet(2),
    ...op.i32Const(0),
    ...op.ret,
    ...op.end,
    ...op.i32Const(stateAt),
    ...op.globalSet(1),
    ...op.globalGet(3),
    ...op.globalSet(2),
    ...op.i32Const(0),
  ];
  return compileWasm({
    types: STANDARD_TYPES,
    funcs: [allocFunc(), outPtrFunc(), outLenFunc(), { type: 0, locals: 1, body: copy }],
    memory: { min: 1, max: 1 },
    globals: [{ init: heapAt }, { init: stateAt }, { init: initial.length }, { init: initial.length }],
    exports: standardExports(0),
    data: [
      { offset: registerAt, bytes: register },
      { offset: stateAt, bytes: initial },
    ],
  });
}

/**
 * A guest for the language boundary. Hook 5 returns the call bytes unchanged.
 * Import stores the JSON and export returns those bytes. This is not a C, Go, or Python program.
 */
export function boundaryGuest(): Uint8Array {
  return storeGuest(
    JSON.stringify({
      contributions: [
        { slotId: "example.pipe", id: "relay", order: 10, dispatch: true },
        { slotId: "example.ask", id: "ask", dispatch: true },
      ],
    }),
    true,
  );
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

/** A guest whose `resource_read` import uses `typeIndex` into a custom function type. */
export function resourceSignatureGuest(
  signature: { params: readonly number[]; results: readonly number[] },
  typeIndex = 3,
): Uint8Array {
  return compileWasm({
    types: [
      ...STANDARD_TYPES,
      {
        params: signature.params.length,
        results: signature.results.length,
        paramTypes: signature.params,
        resultTypes: signature.results,
      },
    ],
    imports: [{ module: "cgp.abi", name: "resource_read", type: typeIndex }],
    funcs: [...abiSupportFuncs(), { type: 0, body: [...op.i32Const(0)] }],
    memory: { min: 1, max: 1 },
    globals: [{ init: 1024 }, { init: 0 }, { init: 0 }],
    exports: standardExports(1),
  });
}

/** Imports `resource_read` and calls it from every hook. The host stub must refuse that call. */
export function resourceGuest(): Uint8Array {
  return compileWasm({
    types: [...STANDARD_TYPES, { params: 5, results: 1 }],
    imports: [{ module: "cgp.abi", name: "resource_read", type: 3 }],
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

/**
 * Register calls `log`. Initialize calls `resource_read`.
 * A namespace that keeps only the last import fails one of those hooks.
 */
export function resourceLogGuest(): Uint8Array {
  const ping = text("ping");
  const ok = text('{"ok":true}');
  return compileWasm({
    types: [...STANDARD_TYPES, { params: 2, results: 0 }, { params: 5, results: 1 }],
    imports: [
      { module: "cgp.abi", name: "log", type: 3 },
      { module: "cgp.abi", name: "resource_read", type: 4 },
    ],
    funcs: [
      allocFunc(),
      outPtrFunc(),
      outLenFunc(),
      {
        type: 0,
        body: [
          ...op.localGet(0),
          ...op.i32Const(0),
          ...op.i32Eq,
          ...op.if,
          ...op.i32Const(200),
          ...op.i32Const(ping.length),
          ...op.call(0),
          ...op.i32Const(256),
          ...op.globalSet(1),
          ...op.i32Const(ok.length),
          ...op.globalSet(2),
          ...op.i32Const(0),
          ...op.ret,
          ...op.end,
          ...op.localGet(0),
          ...op.i32Const(1),
          ...op.i32Eq,
          ...op.if,
          ...op.i32Const(0),
          ...op.i32Const(0),
          ...op.i32Const(0),
          ...op.i32Const(0),
          ...op.i32Const(0),
          ...op.call(1),
          ...op.drop,
          ...op.i32Const(0),
          ...op.ret,
          ...op.end,
          ...op.i32Const(0),
        ],
      },
    ],
    memory: { min: 1, max: 1 },
    globals: [{ init: 1024 }, { init: 256 }, { init: ok.length }],
    exports: standardExports(2),
    data: [
      { offset: 200, bytes: ping },
      { offset: 256, bytes: ok },
    ],
  });
}

/** Start calls `resource_read`. Refusal must happen before that call runs. */
export function resourceStartGuest(): Uint8Array {
  return compileWasm({
    types: [...STANDARD_TYPES, { params: 0, results: 0 }, { params: 5, results: 1 }],
    imports: [{ module: "cgp.abi", name: "resource_read", type: 4 }],
    funcs: [
      allocFunc(),
      outPtrFunc(),
      outLenFunc(),
      { type: 0, body: [...op.i32Const(0)] },
      {
        type: 3,
        body: [
          ...op.i32Const(0),
          ...op.i32Const(0),
          ...op.i32Const(0),
          ...op.i32Const(0),
          ...op.i32Const(0),
          ...op.call(0),
          ...op.drop,
        ],
      },
    ],
    memory: { min: 1, max: 1 },
    globals: [{ init: 1024 }, { init: 0 }, { init: 0 }],
    exports: standardExports(1),
    start: 5,
  });
}

/** A start section that does not import `resource_read` stays legal. */
export function quietStartGuest(): Uint8Array {
  return compileWasm({
    types: [...STANDARD_TYPES, { params: 0, results: 0 }],
    funcs: [
      allocFunc(),
      outPtrFunc(),
      outLenFunc(),
      { type: 0, body: [...op.i32Const(0)] },
      { type: 3, body: [] },
    ],
    memory: { min: 1, max: 1 },
    globals: [{ init: 1024 }, { init: 0 }, { init: 0 }],
    exports: standardExports(0),
    start: 4,
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

/**
 * Fixed UTF-8 results for register (hook 0), exportState (hook 3), and call (hook 5).
 * A hook with no text returns an empty result. The text must sit before the heap at 1024.
 */
export function scriptedGuest(outputs: { register?: string; exportState?: string; call?: string } = {}): Uint8Array {
  const register = text(outputs.register ?? "");
  const exported = text(outputs.exportState ?? "");
  const call = text(outputs.call ?? "");
  const registerAt = 400;
  const exportAt = registerAt + register.length;
  const callAt = exportAt + exported.length;
  if (callAt + call.length > 1024) throw new Error("Scripted guest text does not fit before the heap.");
  const body = [
    ...op.localGet(0),
    ...op.i32Eqz,
    ...op.if,
    ...op.i32Const(registerAt),
    ...op.globalSet(1),
    ...op.i32Const(register.length),
    ...op.globalSet(2),
    ...op.i32Const(0),
    ...op.ret,
    ...op.end,
    ...op.localGet(0),
    ...op.i32Const(3),
    ...op.i32Eq,
    ...op.if,
    ...op.i32Const(exportAt),
    ...op.globalSet(1),
    ...op.i32Const(exported.length),
    ...op.globalSet(2),
    ...op.i32Const(0),
    ...op.ret,
    ...op.end,
    ...op.localGet(0),
    ...op.i32Const(5),
    ...op.i32Eq,
    ...op.if,
    ...op.i32Const(callAt),
    ...op.globalSet(1),
    ...op.i32Const(call.length),
    ...op.globalSet(2),
    ...op.i32Const(0),
    ...op.ret,
    ...op.end,
    ...op.i32Const(0),
  ];
  const data: { offset: number; bytes: Uint8Array }[] = [];
  if (register.length > 0) data.push({ offset: registerAt, bytes: register });
  if (exported.length > 0) data.push({ offset: exportAt, bytes: exported });
  if (call.length > 0) data.push({ offset: callAt, bytes: call });
  return compileWasm({
    types: STANDARD_TYPES,
    funcs: [allocFunc(), outPtrFunc(), outLenFunc(), { type: 0, body }],
    memory: { min: 1, max: 1 },
    globals: [{ init: 1024 }, { init: 0 }, { init: 0 }],
    exports: standardExports(0),
    data,
  });
}

/** Register returns one dispatch contribution. Hook 5 returns the input bytes unchanged. */
export function echoGuest(): Uint8Array {
  const register = text(
    JSON.stringify({
      contributions: [{ slotId: "platform.systems", id: "echo", dispatch: true, payload: { systemId: "echo" } }],
    }),
  );
  const registerAt = 400;
  if (registerAt + register.length > 1024) throw new Error("Echo register text does not fit before the heap.");
  const body = [
    ...op.localGet(0),
    ...op.i32Const(5),
    ...op.i32Eq,
    ...op.if,
    ...op.localGet(1),
    ...op.globalSet(1),
    ...op.localGet(2),
    ...op.globalSet(2),
    ...op.i32Const(0),
    ...op.ret,
    ...op.end,
    ...op.localGet(0),
    ...op.i32Eqz,
    ...op.if,
    ...op.i32Const(registerAt),
    ...op.globalSet(1),
    ...op.i32Const(register.length),
    ...op.globalSet(2),
    ...op.i32Const(0),
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
    data: [{ offset: registerAt, bytes: register }],
  });
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

/** Appends a custom section so the file can be larger than the guest's linear memory. */
export function withCustomPadding(bytes: Uint8Array, padding: number): Uint8Array {
  const payload = 1 + padding;
  const size = uleb(payload);
  const section = new Uint8Array(1 + size.length + payload);
  section[0] = 0;
  section.set(size, 1);
  const out = new Uint8Array(bytes.byteLength + section.byteLength);
  out.set(bytes, 0);
  out.set(section, bytes.byteLength);
  return out;
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

export type ResourceScenario = {
  id: number;
  name: string;
  path: Uint8Array;
  pathAddr: number;
  pathLen?: number;
  out: number;
  outCap: number;
  written: number;
  watch: number;
  grow: boolean;
};

/** Reads package files through `cgp.abi.resource_read` and reports status plus hex dumps. */
export function resourceProbeGuest(): { wasm: Uint8Array; scenarios: ResourceScenario[]; noteAddr: number; notePathLength: number } {
  const encode = (value: string) => text(value);
  let cursor = 256;
  const data: { offset: number; bytes: Uint8Array }[] = [];
  const place = (bytes: Uint8Array) => {
    const addr = cursor;
    data.push({ offset: addr, bytes });
    cursor = addr + bytes.byteLength + 1;
    return addr;
  };
  const notePath = encode("note.txt");
  const noteAddr = place(notePath);
  const paths = {
    note: { bytes: notePath, addr: noteAddr },
    empty: { bytes: encode("empty.txt"), addr: 0 },
    wasm: { bytes: encode("module.wasm"), addr: 0 },
    wrong: { bytes: encode("Note.txt"), addr: 0 },
    proto: { bytes: encode("__proto__"), addr: 0 },
    ctor: { bytes: encode("constructor"), addr: 0 },
    bad: { bytes: Uint8Array.of(0xff), addr: 0 },
    dotdot: { bytes: encode("../nope"), addr: 0 },
    slash: { bytes: encode("a\\b"), addr: 0 },
    absolute: { bytes: encode("/abs"), addr: 0 },
    percent: { bytes: encode("a/%2e"), addr: 0 },
    deep16: { bytes: encode(Array.from({ length: 16 }, () => "a").join("/")), addr: 0 },
    deep17: { bytes: encode(Array.from({ length: 17 }, () => "a").join("/")), addr: 0 },
    long: { bytes: encode("a".repeat(241)), addr: 0 },
    missing: { bytes: encode("missing.txt"), addr: 0 },
    end: { bytes: encode("end.txt"), addr: 0 },
    other: { bytes: encode("other-pack.txt"), addr: 0 },
    dot: { bytes: encode("."), addr: 0 },
  };
  for (const key of Object.keys(paths) as (keyof typeof paths)[]) {
    if (key === "note") continue;
    paths[key].addr = place(paths[key].bytes);
  }
  data.push({ offset: 3000, bytes: new Uint8Array(400).fill(0xa5) });
  data.push({ offset: 3100, bytes: Uint8Array.of(0xff, 0xff, 0xff, 0xff) });
  data.push({ offset: 65520, bytes: new Uint8Array(16).fill(0xa5) });

  const scenarios: ResourceScenario[] = [];
  const add = (name: string, spec: Omit<ResourceScenario, "id" | "name">) => {
    scenarios.push({ id: scenarios.length + 1, name, ...spec });
  };
  const read = (name: string, path: { bytes: Uint8Array; addr: number }, extra: Partial<ResourceScenario> = {}) => {
    add(name, {
      path: path.bytes,
      pathAddr: path.addr,
      out: 3000,
      outCap: 64,
      written: 3100,
      watch: 3000,
      grow: false,
      ...extra,
    });
  };
  read("note", paths.note);
  read("empty", paths.empty, { outCap: 0 });
  read("empty-overlap", paths.empty, { out: 3100, outCap: 0, written: 3100, watch: 3000 });
  read("missing", paths.missing);
  read("case", paths.wrong);
  read("utf8", paths.bad);
  read("dotdot", paths.dotdot);
  read("slash", paths.slash);
  read("absolute", paths.absolute);
  read("percent", paths.percent);
  read("deep16", paths.deep16);
  read("deep17", paths.deep17);
  read("long", paths.long);
  read("empty-name", paths.note, { pathLen: 0 });
  read("too-small", paths.note, { outCap: 0 });
  read("short", paths.note, { outCap: 4 });
  read("proto", paths.proto);
  read("constructor", paths.ctor);
  read("wasm", paths.wasm, { outCap: 40000, written: 60000, watch: 3000 });
  read("end", paths.end, { out: 65532, outCap: 4, watch: 65520 });
  read("adjacent", paths.end, { out: 3200, outCap: 4, written: 3204, watch: 3200 });
  read("overlap", paths.end, { out: 3300, outCap: 4, written: 3302, watch: 3300 });
  read("high-written", paths.note, { written: -16 });
  read("high-out", paths.note, { out: -2147483648 });
  read("high-length", paths.note, { pathLen: -2147483648 });
  read("path-range", paths.note, { pathAddr: 70000, pathLen: 4 });
  read("written-range", paths.note, { written: 65534 });
  read("out-range", paths.end, { out: 65534, outCap: 4 });
  read("other", paths.other);
  read("dot", paths.dot);
  read("grow", paths.note, { out: 65536, outCap: 64, watch: 65536, grow: true });

  const ELSE = [0x05];
  const dump = (start: number, size: number, dest: number, count: number): number[] => [
    ...op.i32Const(start),
    ...op.i32Const(size),
    ...op.call(1),
    ...op.i32Eqz,
    ...op.if,
    ...Array.from({ length: count * 2 }, (_, index) => [...op.i32Const(dest + index), ...op.i32Const(0x66), ...op.i32Store8]).flat(),
    ...ELSE,
    ...Array.from({ length: count }, (_, index) => [
      ...op.i32Const(start + index),
      ...op.i32Load8U,
      ...op.i32Const(dest + index * 2),
      ...op.call(3),
    ]).flat(),
    ...op.end,
  ];
  const scenarioBody = (item: ResourceScenario): number[] => {
    const pathLen = item.pathLen ?? item.path.byteLength;
    return [
      ...op.block,
      ...op.localGet(1),
      ...op.i32Load8U,
      ...op.i32Const(item.id),
      ...op.i32Ne,
      ...op.brIf(0),
      ...op.memorySize,
      ...op.localSet(4),
      ...(item.grow ? [...op.i32Const(1), ...op.memoryGrow, ...op.drop] : []),
      ...op.i32Const(item.pathAddr),
      ...op.i32Const(pathLen),
      ...op.i32Const(item.out),
      ...op.i32Const(item.outCap),
      ...op.i32Const(item.written),
      ...op.call(0),
      ...op.localSet(3),
      ...op.memorySize,
      ...op.localSet(5),
      ...op.i32Const(2000),
      ...op.localGet(3),
      ...op.i32Const(48),
      ...op.i32Add,
      ...op.i32Store8,
      ...dump(item.written, 4, 2001, 4),
      ...dump(item.watch, 16, 2009, 16),
      ...op.localGet(4),
      ...op.i32Const(2041),
      ...op.call(3),
      ...op.localGet(5),
      ...op.i32Const(2043),
      ...op.call(3),
      ...op.i32Const(2000),
      ...op.globalSet(1),
      ...op.i32Const(45),
      ...op.globalSet(2),
      ...op.i32Const(0),
      ...op.ret,
      ...op.end,
    ];
  };

  const hook: number[] = [
    ...op.localGet(0),
    ...op.i32Const(2),
    ...op.i32Eq,
    ...op.if,
    ...op.i32Const(noteAddr),
    ...op.i32Const(notePath.byteLength),
    ...op.i32Const(3000),
    ...op.i32Const(64),
    ...op.i32Const(3100),
    ...op.call(0),
    ...op.i32Eqz,
    ...op.if,
    ...op.i32Const(0),
    ...op.ret,
    ...op.end,
    ...op.i32Const(1),
    ...op.ret,
    ...op.end,
    ...scenarios.flatMap(scenarioBody),
    ...op.i32Const(0),
  ];

  const wasm = compileWasm({
    types: [...STANDARD_TYPES, { params: 5, results: 1 }, { params: 2, results: 0 }, { params: 2, results: 1 }],
    imports: [{ module: "cgp.abi", name: "resource_read", type: 3 }],
    funcs: [
      {
        type: 5,
        locals: 1,
        body: [
          ...op.memorySize,
          ...op.i32Const(65536),
          ...op.i32Mul,
          ...op.localSet(2),
          ...op.localGet(1),
          ...op.localGet(2),
          ...op.i32GtU,
          ...op.if,
          ...op.i32Const(0),
          ...op.ret,
          ...op.end,
          ...op.localGet(0),
          ...op.localGet(2),
          ...op.localGet(1),
          ...op.i32Sub,
          ...op.i32GtU,
          ...op.if,
          ...op.i32Const(0),
          ...op.ret,
          ...op.end,
          ...op.i32Const(1),
        ],
      },
      {
        type: 1,
        body: [
          ...op.localGet(0),
          ...op.i32Const(10),
          ...op.i32LtU,
          ...op.if,
          ...op.localGet(0),
          ...op.i32Const(48),
          ...op.i32Add,
          ...op.ret,
          ...op.end,
          ...op.localGet(0),
          ...op.i32Const(87),
          ...op.i32Add,
        ],
      },
      {
        type: 4,
        body: [
          ...op.localGet(1),
          ...op.localGet(0),
          ...op.i32Const(4),
          ...op.i32ShrU,
          ...op.i32Const(15),
          ...op.i32And,
          ...op.call(2),
          ...op.i32Store8,
          ...op.localGet(1),
          ...op.i32Const(1),
          ...op.i32Add,
          ...op.localGet(0),
          ...op.i32Const(15),
          ...op.i32And,
          ...op.call(2),
          ...op.i32Store8,
        ],
      },
      allocFunc(),
      outPtrFunc(),
      outLenFunc(),
      { type: 0, locals: 4, body: hook },
    ],
    memory: { min: 1, max: 2 },
    globals: [{ init: 4096 }, { init: 0 }, { init: 0 }],
    exports: standardExports(4),
    data,
  });
  return { wasm, scenarios, noteAddr, notePathLength: notePath.byteLength };
}
