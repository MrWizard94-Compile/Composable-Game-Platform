# Status

Milestone 1 through save identity. Working, not a game.

## Implemented

- JSON manifests, closed schema, semantic versions and ranges.
- Discovery of module folders on disk, and the same packages bundled for the console.
- API compatibility, required and optional capability dependencies, duplicate ids.
- Slots: singleton, policy, registry, pipeline, subscriber, service.
- Module-owned slots. A child package connects without changing the parent or the host.
- Cycle detection, depth limit 8, deterministic order, conflict and ambiguity refusal.
- Transactional failure: bad manifests are isolated; graph failures and init exceptions roll back.
- Headless demo and the browser console over one `compose()` function.
- Flora proof (species registry + one growth policy) and Lighting proof (source registry) on the same platform slot.
- Caller-initiated dispatch. `publish` fans one event through a subscriber slot and keeps going after a throw. `runPipeline` folds a value through a pipeline slot and stops at the first failure. `callService` invokes the one provider of a service slot and returns its value. None of these is a tick.
- Module-owned save slices. The host stores JSON a module exports and restores a slice only when the major version matches. Two slices for one module are refused. A different profile name or fingerprint warns, and slices are still matched by module id. `shutdown()` quiesces the runtime, and dispatch and save then refuse.
- A public entry, `src/foundations/index.ts`, and a copyable starter module. `validateManifest` checks a manifest that has no implementation yet. The console uses that same function. It does not load code.
- Composition profiles. A JSON document pins module ids and exact versions. A missing module or a different packaged version refuses the selection. The host does not upgrade.
- Capability requirements. One matching provider is a dependency. Two matching providers are ambiguous, and the host does not pick one. Naming `moduleId` on the requirement pins the provider. An optional requirement still refuses when more than one provider matches.
- Resolved order edges. Each edge names the provider, the dependent, and a capability or a module-owned slot. A missing or ambiguous requirement adds no edge.

## Not implemented

- Sandbox, resource limits, package signing.
- Permission enforcement. Declarations are stored and ignored.
- Save migrations beyond a major-version refusal. No disk format beyond the JSON document. No networking or replication.
- Hot reload, a frame loop, rendering, input, audio.
- A world, entities, or any gameplay rule inside the Foundations.

## Provisional

- Manifest field names and the six slot kinds.
- Foundations API `1.0.0` and max depth 8.
- In-process trusted modules as the only execution mode.
- Contract compatibility is major-version equality, or exact equality when the connection names a full version.
- A dispatchable payload is a function, or an object with a `handle` function. A service may return `undefined`. A pipeline stage may not.
- A save payload is whatever JSON the module returns. Same major means compatible. `importState` is the only migration.
