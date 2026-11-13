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
| `publish`, `runPipeline`, `callService` | Caller-initiated execution. The host has no tick. A runner outside the host may request one step. |
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

`exportState` returns JSON. `importState` receives a slice whose major version matches the manifest. The host does not migrate for you. Check the slice before writing. If `importState` throws, the host stops the restore and writes the pre-restore snapshot back into every module it had already changed, including the one that threw. Later slices are not written. `applied` is empty. The host waits if `importState` returns a promise. If the snapshot write throws, the notice is `save.rollback` and that module can be left changed. `captureSave` waits for an in-flight restore or simulation step, including completion subscribers, so the document is not a mixture. Calling `captureSave` or `restoreSave` on this composition from `importState`, `exportState`, a system, or a completion subscriber is refused with `save.reentrant`, including after that hook awaits. The refusal is for this composition only. It does not wait on the lane. A direct service call is not on that lane. If it runs while a capture is already exporting, a later slice can show the change and an earlier slice stays what that module returned. A direct ledger open is not the runner. A restore during that open mark is refused by the ledger, and the witness does not keep the rejected document.

A callable contribution is a function, an object with a `handle` function, or an ABI handle. `publish` keeps going after a throw. `runPipeline` stops. `callService` calls the one provider. A service may return `undefined`. A pipeline stage may not.

Contribution ids match `^[a-z][a-z0-9-]{0,64}$`. Order is `(order, module id, contribution id)`.

## WebAssembly

Copy `examples/wasm-module`. It has `manifest.json` and `module.wasm` and no `module.ts`. Discovery reads the bytes and does not instantiate them. The binary must export `memory` (one page maximum in the template), `cg_alloc`, `cg_hook`, `cg_out_ptr`, and `cg_out_len`. The only legal import is `cgp.abi.log`. See [abi.md](abi.md).

`dispatch: true` on a contribution replaces that contribution's payload with an ABI handle. An object whose only own key is `dispatch: true`, nested inside the payload, becomes a handle too. The host mints the handle for this composition. Returning `{ "abi", "moduleId", "contributionId" }` from another module does not. A handle does not call a guest in a different composition. Later calls go back through hook `5`. The call JSON is `{ "contributionId", "arg", "args" }`. A call with no arguments sends `"arg": null` and `"args": []`. An explicit `undefined` is refused, and a throw while reading the arguments becomes `ABI payload is not JSON (could not encode).` without forwarding the thrown value. The result is JSON. A number result is a JSON number, not an object. Guest objects are copied, so a `__proto__` field cannot change the host's prototypes.

`org.cgp.dune-growth` is the first guest that computes a real contribution. It is off by default. It provides the same growth capability as Seasonal Growth, so enabling both is a conflict. Its arithmetic is fixed-point hundredths: `delta = (growthHundredths * factorHundredths + 50) / 100`, with spring 120, summer 80, autumn 30, and winter 5.

Aggregate budgets are optional fields on the policy: `maxGuests`, `maxTotalMemoryBytes`, `maxTotalBinaryBytes`, and `maxTotalHookMs`. Unset means unlimited. Only an isolating backend enforces them, and only for the composition that opened the session. A reservation is charged after the binary checks and before the worker starts. A failed load refunds that same hold once, including when `release` already refunded it. Host ceilings are separate and are set on the backend (`host: { maxGuests, maxMemoryBytes, maxBinaryBytes, maxHookMs }`). They cover every composition that backend has open, including a load still in flight. `maxMemoryBytes` is the declared linear-memory maximum for one guest. `maxBinaryBytes` is that guest's file size. They are not the same limit. A binary may be larger than the memory it declares when `maxBinaryBytes` says so, and a memory maximum above `maxMemoryBytes` is still refused when the file itself is small. The default for each is 65536 when the policy omits it. `maxTotalBinaryBytes` remains the composition sum, and the backend's host `maxBinaryBytes` remains the sum across open compositions. Host `maxMemoryBytes` is the sum of declared linear-memory maxima. It is not the worker's RSS, and `isolateHeapMb` is not added to it. Guest, memory, and binary charges return when the composition releases. Host hook time does not. `dispose()` waits for every open session and then refuses new ones.

`maxTotalHookMs` and a host `maxHookMs` admit one hook at a time on that ledger. A call starts only while time already spent is below the budget. Its wall-clock time is added when it settles, so the in-flight call can carry the total past the budget by less than `maxHookMs`, and the next call then sees that total. When the budget is unset, calls are not serialized. `isolateHeapMb` asks for a Node worker heap cap. The browser isolate cannot apply it and refuses that policy before any hook runs. Both isolates otherwise enforce the same declared limits, including refusal of a bad binary before a worker starts.

`cgp.log` lines are kept per composition, prefixed with the module id, and capped by UTF-8 bytes (4096 bytes of stored lines, 32 lines, 240 bytes of message, unless the backend was given a tighter `log` budget). `maxLines` is the number of stored lines, and the single `[log dropped]` marker counts as one of them. A further line is not stored. Older lines are removed until the marker fits in both the line count and the byte cap. If the marker cannot fit (`maxLines` below 1, or the marker larger than `maxBytes`), it is not stored and lines that already fit stay. One composition cannot read another's buffer. After `release`, logs stay readable only while they fit the backend's retention cap (`maxRetainedSessions` 8 and `maxRetainedBytes` 16384 by default). `release` resolves only after that composition's workers have been terminated, including a worker whose load had not finished. A synchronous failure while a call is admitted, including an ABI value that is not JSON, still drops that admission so `release` and `dispose` can finish.

`node --experimental-strip-types scripts/build-wasm-module.ts` regenerates the template binary, the Dune Growth bytes, and `examples/third-party-module/module.wasm` from `guest.json`. Pass a package directory to compile only that folder. `scripts/check-wasm-module.ts <package>` validates a third-party package and instantiates it. A package compiled by another toolchain has `manifest.json` and `module.wasm`, no `module.ts`, and no `guest.json`. `scripts/verify-wasm.ts` checks generated bytes. `scripts/browser-wasm.ts` loads the shared runtime in Chromium. The foundations workflow runs those checks, the tests, and `tsc -p tsconfig.foundations.json`, which also typechecks `wasm-guest-runtime.mjs`. See [ADR 0014](adr/0014-accounting-and-third-party-guests.md).

## What a refusal looks like

`validateManifest` returns `{ ok: false, errors }` or `{ ok: true, manifest }`.

`compose` isolates a bad manifest and can still activate its neighbors. A conflict, an ambiguous service, a cycle, a contract mismatch, a missing required slot, depth past 8, or a throw from `initialize` refuses the admitted graph. `result.runtimeActive` is false and `result.diagnostics` says why. Nothing from that graph stays registered. The session is released.

## Profiles

A profile is a JSON document, not a list in host code. It pins module ids and exact versions. See `profiles/nested-proof.json`.

`validateProfile` checks the document. `resolveProfile` selects those packages from a catalog you already loaded. A missing module, or a package whose version is not the pin, refuses the whole selection. The host does not upgrade to a newer package. Ranges belong on a module's `moduleApi` and `requires`, not on a profile pin.

## What this is not

The in-process backend is trusted code. It is not an isolate and it cannot enforce a resource limit. A WebAssembly guest is an isolate: one worker, one memory, a time limit, and no filesystem, network, or operating-system import. A cross composition can hold both. JavaScript in that composition is still not sandboxed. There is no hot reload. The host does not know what a payload means.
