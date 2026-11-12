# Writing a module

Copy [examples/starter-module](../examples/starter-module). Change `moduleId`. A package is a folder with `manifest.json` and, if it has behavior, `module.ts` exporting `implementation`.

The browser console can check a manifest. It does not load an implementation. Loading code is `compose()`.

## Public entry

Import from `src/foundations/index.ts` only. That file is also the package export `"."`. Other files under `src/foundations` are internal and can change. `compose` does not run module code under the default policy. The in-process backend grants filesystem, network, and os, and it cannot enforce limits. Pass `trust: "trusted-in-process"` or `policy: IN_PROCESS_POLICY` to opt in. Pass `backend` to replace it. This is not a sandbox.

| Export | Use |
|---|---|
| `validateManifest` | Check one manifest before you compose. |
| `compose` | Load packages. Pass `{ trust: "trusted-in-process" }` or omit it. |
| `contributionsFor` | Read a slot. The host does not interpret payloads. |
| `publish`, `runPipeline`, `callService` | Caller-initiated execution. There is no tick. |
| `captureSave`, `restoreSave` | JSON a module exports. Same major version only. |
| `FOUNDATIONS_API` | The host version a `moduleApi` range must admit. Today `1.0.0`. |

## Manifest

The schema is closed. An unknown field is an error. Versions are `major.minor.patch`. Ranges accept an exact version, `^`, `~`, and comparator sets such as `>=1.0.0 <2.0.0`.

- `moduleId`: dotted lowercase, at least two segments (`org.example.starter`).
- `name`, `version`, `moduleApi`: required. `version` is exact.
- `requires`: capabilities, not folder names. List each capability once. `optional: true` warns and continues when nobody provides it. Two matching providers refuse the composition. Set `moduleId` to pin one provider. A satisfied requirement is an order edge. An ambiguous or missing one is not.
- `provides`: capabilities this module offers, exact versions.
- `connectsTo`: a slot id and a contract reference (`platform.system/1` or a full version).
- `exposesSlots`: slots this module owns. Kind is `singleton`, `policy`, `registry`, `pipeline`, `subscriber`, or `service`.
- `save`: optional `{ "version": "1.0.0" }`. Exact. This module then owns one JSON slice. A document with two slices for that module is refused. Object keys are sorted. Array order is kept.
- `permissions`: stored on the result. Not enforced. A list here is not a sandbox.

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

`initialize` and `shutdown` receive `kept()` and `ownedSlot(slotId)`. `shutdown` runs in reverse initialization order. After `shutdown()`, the result is quiesced and dispatch and save refuse.

`exportState` returns JSON. `importState` receives a slice whose major version matches the manifest. The host does not migrate for you.

A callable contribution is a function, or an object with a `handle` function. `publish` keeps going after a throw. `runPipeline` stops. `callService` calls the one provider. A service may return `undefined`. A pipeline stage may not.

Contribution ids match `^[a-z][a-z0-9-]{0,64}$`. Order is `(order, module id, contribution id)`.

## What a refusal looks like

`validateManifest` returns `{ ok: false, errors }` or `{ ok: true, manifest }`.

`compose` isolates a bad manifest and can still activate its neighbors. A conflict, an ambiguous service, a cycle, a contract mismatch, a missing required slot, depth past 8, or a throw from `initialize` refuses the admitted graph. `result.runtimeActive` is false and `result.diagnostics` says why. Nothing from that graph stays registered.

## Profiles

A profile is a JSON document, not a list in host code. It pins module ids and exact versions. See `profiles/nested-proof.json`.

`validateProfile` checks the document. `resolveProfile` selects those packages from a catalog you already loaded. A missing module, or a package whose version is not the pin, refuses the whole selection. The host does not upgrade to a newer package. Ranges belong on a module's `moduleApi` and `requires`, not on a profile pin.

## What this is not

Modules are trusted in-process code. There is no isolate, no resource limit, and no hot reload. The host does not know what a payload means.
