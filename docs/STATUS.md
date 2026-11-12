# Status

Milestone 1 through an execution boundary. Working, not a game.

## Implemented

- JSON manifests, closed schema, semantic versions and ranges.
- Discovery of module folders on disk, and the same packages bundled for the console.
- API compatibility, required and optional capability dependencies, duplicate ids.
- Slots: singleton, policy, registry, pipeline, subscriber, service.
- Module-owned slots. A child package connects without changing the parent or the host.
- Cycle detection, depth limit 8, deterministic order, conflict and ambiguity refusal.
- Transactional failure: bad manifests are isolated; graph failures and init exceptions roll back. Shutdown on rollback includes the module that failed, and skips any module that had not entered that phase.
- Headless demo and the browser console over one `compose()` function. The public entry is `src/foundations/index.ts`, also the package export `"."`.
- Caller-initiated dispatch. `publish` fans one event through a subscriber slot and keeps going after a throw. `runPipeline` folds a value through a pipeline slot and stops at the first failure. `callService` invokes the one provider of a service slot and returns its value. A contribution to those three kinds must already be callable or registration fails. None of these is a tick.
- Composition fingerprints name module versions, slot contracts, dependency edges, and contribution order. Package order does not change the fingerprint. A different version or contribution order does.
- Execution boundary. Hooks and slot payloads run only through a backend. The default policy allows no filesystem, network, or operating-system grant, so the in-process backend does not run until the caller opts in. A limit on a backend that cannot enforce it is refused. A replacement backend uses the same manifests and hooks. The host does not pass filesystem, network, or operating-system handles into a module context.
- Flora proof (species registry + one growth policy) and Lighting proof (source registry) on the same platform slot.
- Module-owned save slices. The host stores JSON a module exports and restores a slice only when the major version matches. Two slices for one module are refused. A different profile name or fingerprint warns, and slices are still matched by module id. Object keys in a slice are sorted. Array order is kept. `shutdown()` quiesces the runtime, and dispatch and save then refuse.
- A public entry, `src/foundations/index.ts`, and a copyable starter module. `validateManifest` checks a manifest that has no implementation yet. The console uses that same function. It does not load code.
- Composition profiles. A JSON document pins module ids and exact versions. A missing module or a different packaged version refuses the selection. The host does not upgrade.
- Capability requirements. One matching provider is a dependency. Two matching providers are ambiguous, and the host does not pick one. Naming `moduleId` on the requirement pins the provider. An optional requirement still refuses when more than one provider matches. A module that lists the same capability twice is isolated.
- Resolved order edges. Each edge names the provider, the dependent, and a capability or a module-owned slot. A missing or ambiguous requirement adds no edge.
- A world record table and a caller-driven step, as modules. World Core exposes spawn, remove, and list. World Store keeps the records and the save slice. Step Clock counts only when a caller asks. Step Witness hears that one publish. Neither module runs a loop, and the host does not know what an entity or a step means.

## Not implemented

- Physics.
- Rendering.
- Input.
- Audio.
- A simulation tick or a scheduler that runs by itself. A step happens only when a caller asks.
- Multiplayer networking or replication.
- Hot module reloading.
- Enforced permissions. A declared permission is still not a boundary.
- An isolating backend that can revoke filesystem, network, and operating-system access and enforce time and memory limits. The policy gate refuses a backend that cannot. The in-process backend cannot.
- Save migrations beyond a major-version refusal. No disk format beyond the JSON document.

## Provisional

- Manifest field names and the six slot kinds.
- Foundations API `1.0.0` and max depth 8.
- Contract compatibility is major-version equality, or exact equality when the connection names a full version. Subscriber, pipeline, and service payloads must be callable at registration. Registry, singleton, and policy payloads are not inspected.
- The in-process backend is the only one shipped. It is opt-in. A permission list is not a boundary.
- A dispatchable payload is a function, or an object with a `handle` function. A service may return `undefined`. A pipeline stage may not.
- A save payload is whatever JSON the module returns. Same major means compatible. `importState` is the only migration.
