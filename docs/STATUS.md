# Status

Milestone 1 through an isolated WebAssembly guest. Working, not a game.

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
- Isolated WebAssembly guests. Discovery reads manifests and wasm bytes and does not import or instantiate. Each composition owns its workers. `release` terminates them, including when composition fails. Two compositions can run at once, including two versions of the same module id, and one looping guest does not block the other. The host waits on promises and does not call `Atomics.wait`. Guest memory must declare a maximum. Shared memory, 64-bit memory, imported memory, and an oversized or unbounded table are refused before instantiation. The worker repeats those checks and runs under a heap, code, and stack cap. Unauthorized imports, including WASI and `node:fs`, are refused before the guest runs. `cgp.log` is linked only when the manifest and the policy both allow it. Save slices are plain JSON and restore on a new isolate.
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
- Enforced permissions for in-process JavaScript. A declared permission is still not a boundary there. The WASM backend does enforce its import allow-list.
- An isolating backend other than `wasm-isolate`. The in-process backend still cannot revoke filesystem, network, or operating-system access, and it cannot enforce time or memory limits. A policy that asks it to is refused.
- Save migrations beyond a major-version refusal. No disk format beyond the JSON document.

## Provisional

- Manifest field names and the six slot kinds.
- Foundations API `1.0.0` and max depth 8.
- Contract compatibility is major-version equality, or exact equality when the connection names a full version. Subscriber, pipeline, and service payloads must be callable at registration. Registry, singleton, and policy payloads are not inspected.
- The in-process backend is opt-in. It still cannot revoke filesystem, network, or operating-system access, and it cannot enforce time, memory, or capability limits. A policy that asks it to is refused. It is not a sandbox.
- `wasm-isolate` is the isolating backend. Guests are owned by the composition that opened them.
- A dispatchable payload is a function, or an object with a `handle` function. A service may return `undefined`. A pipeline stage may not.
- A save payload is whatever JSON the module returns. Same major means compatible. `importState` is the only migration.
