# Writing a module

Copy [examples/starter-module](../examples/starter-module) for JavaScript, or [examples/wasm-module](../examples/wasm-module) for a portable guest. Change `moduleId`. A package is a folder with `manifest.json` and, if it has behavior, either `module.ts` exporting `implementation` or `module.wasm`.

The browser console can check a manifest. It does not load an implementation by importing it. Loading code is `compose()`.

## Public entry

Import from `src/foundations/index.ts` only. That file is also the package export `"."`. Other files under `src/foundations` are internal and can change. `compose` does not run module code under the default policy. The in-process backend grants filesystem, network, and os, and it cannot enforce limits. Pass `trust: "trusted-in-process"` or `policy: IN_PROCESS_POLICY` to opt in. Pass `backend` to replace it. `createWasmBackend()` is the Node isolate. `createCrossBackend(isolate)` sends WebAssembly bytes to that isolate and JavaScript hooks to the in-process backend. `CROSS_POLICY` allows the in-process grants and sets a time and memory limit the isolate actually enforces. JavaScript on that same composition is still not limited.

| Export | Use |
|---|---|
| `validateManifest` | Check one manifest before you compose. |
| `compose` | Load packages. Pass `{ trust: "trusted-in-process" }` or a backend. |
| `contributionsFor` | Read a slot. The host does not interpret payloads. |
| `publish`, `runPipeline`, `callService` | Caller-initiated execution. There is no tick. |
| `captureSave`, `restoreSave` | JSON a module exports. Same major version only. |
| `FOUNDATIONS_API` | The host version a `moduleApi` range must admit. Today `1.0.0`. |
| `createWasmBackend`, `createCrossBackend`, `CROSS_POLICY` | Run a guest, or run guests and JavaScript in one composition. |

## Manifest

The schema is closed. An unknown field is an error. Versions are `major.minor.patch`. Ranges accept an exact version, `^`, `~`, and comparator sets such as `>=1.0.0 <2.0.0`.

- `moduleId`: dotted lowercase, at least two segments (`org.example.starter`).
- `name`, `version`, `moduleApi`: required. `version` is exact.
- `requires`: capabilities, not folder names. List each capability once. `optional: true` warns and continues when nobody provides it. Two matching providers refuse the composition. Set `moduleId` to pin one provider. A satisfied requirement is an order edge. An ambiguous or missing one is not.
- `provides`: capabilities this module offers, exact versions.
- `connectsTo`: a slot id and a contract reference (`platform.system/1` or a full version).
- `exposesSlots`: slots this module owns. Kind is `singleton`, `policy`, `registry`, `pipeline`, `subscriber`, or `service`.
- `save`: optional `{ "version": "1.0.0" }`. Exact. This module then owns one JSON slice. A document with two slices for that module is refused. Object keys are sorted. Array order is kept.
- `permissions`: stored on the result. Not a sandbox for JavaScript. For a guest, `cgp.log` is linked only when this list and the policy's `allowCapabilities` both include it. Every other import is refused before the guest runs. `license`, when present, is an SPDX expression such as `MIT` or `LicenseRef-Proprietary`. "Not yet licensed" is rejected. The examples in this repository are MIT. See [ADR 0013](adr/0013-authoring-toolchain-and-license.md).

A module cannot connect to a slot it owns. Two modules cannot own the same slot id.

## Implementation

```ts
import type { ModuleImplementation } from "../../src/foundations/index.ts";

export const implementation: ModuleImplementation = {
  register(ctx) {
    ctx.contribute("platform.systems", {
      id: "starter",
      payload: { systemId: "starter", label: "Starter" },
    });
  },
};
```

`register` may `contribute` and may `keep` once. A second `keep` fails registration and rolls the composition back.

`initialize` and `shutdown` receive `kept()` and `ownedSlot(slotId)`. `shutdown` runs in reverse initialization order. It is single-flight: a second call reports `already` and does not run the hooks again. If one module's shutdown throws, the host records it and continues with the rest. `release` still runs, including when a hook throws, so the composition's workers are terminated. After `shutdown()`, the result is quiesced and dispatch and save refuse.

`exportState` returns JSON. `importState` receives a slice whose major version matches the manifest. The host does not migrate for you.

A callable contribution is a function, an object with a `handle` function, or an ABI handle. `publish` keeps going after a throw. `runPipeline` stops. `callService` calls the one provider. A service may return `undefined`. A pipeline stage may not.

Contribution ids match `^[a-z][a-z0-9-]{0,64}$`. Order is `(order, module id, contribution id)`.

## WebAssembly

Copy `examples/wasm-module`. It has `manifest.json` and `module.wasm` and no `module.ts`. Discovery reads the bytes and does not instantiate them. The binary must export `memory` (one page maximum in the template), `cg_alloc`, `cg_hook`, `cg_out_ptr`, and `cg_out_len`. The only legal import is `cgp.abi.log`. See [abi.md](abi.md).

`dispatch: true` on a contribution replaces that contribution's payload with an ABI handle. An object whose only key is `dispatch: true`, nested inside the payload, becomes a handle too. Later calls go back through hook `5`. The call JSON is `{ "contributionId", "arg", "args" }`. The result is JSON. A number result is a JSON number, not an object.

`org.cgp.dune-growth` is the first guest that computes a real contribution. It is off by default. It provides the same growth capability as Seasonal Growth, so enabling both is a conflict. Its arithmetic is fixed-point hundredths: `delta = (growthHundredths * factorHundredths + 50) / 100`, with spring 120, summer 80, autumn 30, and winter 5.

Aggregate budgets are optional fields on the policy: `maxGuests`, `maxTotalMemoryBytes`, `maxTotalBinaryBytes`, and `maxTotalHookMs`. Unset means unlimited. Only an isolating backend enforces them, and only for the composition that opened the session. A failed load refunds the guest, binary, and memory charge. Host ceilings are separate and are set on the backend (`host: { maxGuests, maxMemoryBytes, maxBinaryBytes, maxHookMs }`). They cover every composition that backend has open. Guest, memory, and binary charges return when the composition releases. Host hook time does not.

`maxTotalHookMs` and a host `maxHookMs` admit one hook at a time on that ledger. A call starts only while time already spent is below the budget. Its wall-clock time is added when it settles, so the in-flight call can carry the total past the budget by less than `maxHookMs`, and the next call then sees that total. When the budget is unset, calls are not serialized. `isolateHeapMb` asks for a Node worker heap cap. The browser isolate cannot apply it and refuses that policy before any hook runs. Both isolates otherwise enforce the same declared limits, including refusal of a bad binary before a worker starts.

`cgp.log` lines are kept per composition, prefixed with the module id, and capped (4096 bytes, 32 lines, 240 bytes each, unless the backend was given a tighter `log` budget). A further line becomes one `[log dropped]` marker. One composition cannot read another's buffer. `release` resolves only after that composition's workers have been terminated.

`node --experimental-strip-types scripts/build-wasm-module.ts` regenerates the template binary and the Dune Growth bytes. `scripts/verify-wasm.ts` checks them. The foundations workflow runs that check, the tests (including the browser isolate), and `tsc -p tsconfig.foundations.json`.

## What a refusal looks like

`validateManifest` returns `{ ok: false, errors }` or `{ ok: true, manifest }`.

`compose` isolates a bad manifest and can still activate its neighbors. A conflict, an ambiguous service, a cycle, a contract mismatch, a missing required slot, depth past 8, or a throw from `initialize` refuses the admitted graph. `result.runtimeActive` is false and `result.diagnostics` says why. Nothing from that graph stays registered. The session is released.

## Profiles

A profile is a JSON document, not a list in host code. It pins module ids and exact versions. See `profiles/nested-proof.json`.

`validateProfile` checks the document. `resolveProfile` selects those packages from a catalog you already loaded. A missing module, or a package whose version is not the pin, refuses the whole selection. The host does not upgrade to a newer package. Ranges belong on a module's `moduleApi` and `requires`, not on a profile pin.

## What this is not

The in-process backend is trusted code. It is not an isolate and it cannot enforce a resource limit. A WebAssembly guest is an isolate: one worker, one memory, a time limit, and no filesystem, network, or operating-system import. A cross composition can hold both. JavaScript in that composition is still not sandboxed. There is no hot reload. The host does not know what a payload means.
