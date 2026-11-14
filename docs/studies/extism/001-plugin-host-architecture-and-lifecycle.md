# Extism Study 001 — Plugin Host Architecture, Guest SDKs, and Lifecycle

**Research date:** 2026-11-14  
**External project:** Extism  
**Core runtime source revision:** [051b765bb6abe4fe95d5e4f489f03ad7b137edbc](https://github.com/extism/extism/commit/051b765bb6abe4fe95d5e4f489f03ad7b137edbc)  
**JavaScript Host SDK revision:** [bec25c60d0ad32ce06d3934563fd8560f486f323](https://github.com/extism/js-sdk/commit/bec25c60d0ad32ce06d3934563fd8560f486f323)  
**JavaScript PDK revision:** [beacc9ad9e6bac6250143980b669d2e6c68aaa18](https://github.com/extism/js-pdk/commit/beacc9ad9e6bac6250143980b669d2e6c68aaa18)  
**Rust PDK revision:** [17429445a32ee4ab5c61f36c4866de555fc024fb](https://github.com/extism/rust-pdk/commit/17429445a32ee4ab5c61f36c4866de555fc024fb)  
**CGP comparison baseline:** [2777971d99b5dfaa26f2e7898ba6b11f471c99de](https://github.com/MrWizard94-Compile/Composable-Game-Platform/commit/2777971d99b5dfaa26f2e7898ba6b11f471c99de)

## Purpose

Study Extism as an embedded WebAssembly plugin execution framework. Focus on its host/guest split, runtime and SDK architecture, plugin construction and invocation lifecycle, host-function imports, state and memory behavior, resource limits, and portability. Compare the execution layer with CGP's existing composition, module lifecycle, isolation, and ABI contracts.

This is a research note, not an implementation decision. It does not authorize replacing CGP's current ABI, adding Extism as a dependency, or changing CGP's module lifecycle.

## Executive findings

1. **Extism is an embedded Wasm runtime and developer ecosystem, not a complete module platform.** The host application defines its plugin interface and decides how plugins are discovered, selected, authorized, and used. Extism supplies runtime APIs, Host SDKs, PDKs, manifests, memory marshalling, and host-function linking.
2. **The core runtime is Rust/Wasmtime with a C ABI; language SDKs wrap it.** The JavaScript SDK is a notable exception: it uses the WebAssembly runtime available in the JavaScript environment rather than loading the native C shared library. Its README lists browsers, Node, Deno, Bun, and Cloudflare Workers.
3. **The guest ABI is bytes-in/bytes-out.** Host and guest choose a serialization format such as JSON or Protobuf. PDKs provide convenience conversions, but Extism does not itself define CGP-like typed Slot contracts, semantic version compatibility, or package dependency resolution.
4. **A plugin can contain multiple named Wasm modules, but this is static linking within one Extism plugin instance.** It is not a general package graph, nested Slot system, or independently managed module lifecycle.
5. **Host functions are explicit capability imports, but their authority is defined by the host callback.** They can expose databases, internal APIs, and arbitrary host state. WASI is separately enabled; filesystem paths and HTTP destinations can be constrained through manifest settings. Host callbacks still need their own validation, authorization, budgets, and side-effect policy.
6. **Plugin instances are stateful and single-threaded.** Calls on one Rust Plugin instance are mutable/exclusive and reentrant calls are rejected. The Rust pool provides concurrency by creating or reusing multiple independent instances; state is not shared between those instances.
7. **A failed call is not a transaction.** A guest can mutate its own memory or persistent variables and invoke host functions before trapping. Extism reports the failure, but there is no general rollback of guest state or host-side effects. The inspected Rust pool returns a checked-out instance to the pool on drop even when the callback returned an error; host policy must decide when an instance is no longer safe to reuse.
8. **Extism has useful per-plugin controls, not CGP's full composition-level budget model.** Manifest memory options include Wasm pages, variable-store bytes, and HTTP response bytes; timeout is expressed in milliseconds; the Rust builder exposes instruction fuel limits. These do not automatically provide CGP-style aggregate budgets across all active compositions.
9. **Extism is a strong reference for CGP's guest execution adapter and SDK experience, but not for CGP's Foundation.** The best ideas to evaluate are bytes-in/bytes-out marshalling, PDK ergonomics, host-function namespaces, content hashes, resource limits, compiled-plugin reuse, and plugin test harnesses.

## 1. Evidence boundary and inspected sources

The core runtime was inspected at Extism revision 051b765bb6abe4fe95d5e4f489f03ad7b137edbc. This revision's latest commit upgrades Wasmtime to 49.0.1 and the Rust toolchain to 1.96.0. It is a moving development branch snapshot, not a claim that every published SDK package is released at the same version.

Primary core-runtime files:

- [Runtime README and supported SDK/PDK matrix](https://github.com/extism/extism/blob/051b765bb6abe4fe95d5e4f489f03ad7b137edbc/README.md)
- [Manifest model and strict schema](https://github.com/extism/extism/blob/051b765bb6abe4fe95d5e4f489f03ad7b137edbc/manifest/src/lib.rs)
- [Manifest JSON Schema](https://github.com/extism/extism/blob/051b765bb6abe4fe95d5e4f489f03ad7b137edbc/manifest/schema.json)
- [Plugin runtime and call path](https://github.com/extism/extism/blob/051b765bb6abe4fe95d5e4f489f03ad7b137edbc/runtime/src/plugin.rs)
- [Plugin builder and fuel/host-function configuration](https://github.com/extism/extism/blob/051b765bb6abe4fe95d5e4f489f03ad7b137edbc/runtime/src/plugin_builder.rs)
- [Host callback and UserData model](https://github.com/extism/extism/blob/051b765bb6abe4fe95d5e4f489f03ad7b137edbc/runtime/src/function.rs)
- [Per-plugin state, memory limiter, and WASI setup](https://github.com/extism/extism/blob/051b765bb6abe4fe95d5e4f489f03ad7b137edbc/runtime/src/current_plugin.rs)
- [Plugin instance pool](https://github.com/extism/extism/blob/051b765bb6abe4fe95d5e4f489f03ad7b137edbc/runtime/src/pool.rs)
- [Timer and cancellation mechanism](https://github.com/extism/extism/blob/051b765bb6abe4fe95d5e4f489f03ad7b137edbc/runtime/src/timer.rs)

Additional upstream SDK sources:

- [JavaScript Host SDK](https://github.com/extism/js-sdk/tree/bec25c60d0ad32ce06d3934563fd8560f486f323)
- [JavaScript PDK](https://github.com/extism/js-pdk/tree/beacc9ad9e6bac6250143980b669d2e6c68aaa18)
- [Rust PDK](https://github.com/extism/rust-pdk/tree/17429445a32ee4ab5c61f36c4866de555fc024fb)

Official documentation consulted:

- [Plugin System](https://extism.org/docs/concepts/plug-in-system/)
- [Plugin](https://extism.org/docs/concepts/plug-in/)
- [Host SDKs](https://extism.org/docs/concepts/host-sdk/)
- [Host Functions](https://extism.org/docs/concepts/host-functions/)
- [Plugin Development Kits](https://extism.org/docs/concepts/pdk/)
- [Memory](https://extism.org/docs/concepts/memory/)
- [Manifest](https://extism.org/docs/concepts/manifest/)
- [Configuration](https://extism.org/docs/concepts/configuration/)
- [Runtime APIs](https://extism.org/docs/concepts/runtime-apis/)
- [Testing Plugins](https://extism.org/docs/concepts/testing/)
- [FAQ](https://extism.org/docs/questions/)

## 2. Architecture: what Extism provides

Extism describes the application that embeds plugins as the **host**. The host chooses the plugin system interface. A plugin is a Wasm module that implements that host-defined interface. Extism's ecosystem supplies:

- A Rust runtime built on Wasmtime.
- A C API that allows other languages to embed the runtime through FFI.
- Host SDKs for multiple languages.
- PDKs that make guest Wasm modules easier to author.
- A manifest for Wasm inputs and runtime constraints.
- A common bytes-in/bytes-out communication model.
- Built-in imports for input/output, configuration, variables, logging, and optional HTTP.
- Host functions for application-defined capabilities.

The core runtime is embedded in the host process. It is not a separate service or sidecar by default. This avoids an RPC boundary, but means the host process still owns runtime deployment, lifecycle, crash policy, and operational containment.

### 2.1 Runtime and SDK variants

The core Rust runtime exposes a C API. Many language SDKs are wrappers around that API. The JavaScript SDK uses the Wasm runtime available in the JavaScript environment rather than FFI to a native shared library. Its inspected README lists browsers (Firefox, Chrome, WebKit), Node, Deno, Bun, and Cloudflare Workers.

That distinction matters for CGP: Extism is not one identical binary runtime distributed unchanged to every host. Its shared contract and PDK conventions are implemented through host-specific SDK/runtime adapters. Compatibility and feature parity must be checked per SDK and target.

The JavaScript PDK is also distinct from the JavaScript Host SDK. It compiles guest JavaScript into Wasm using QuickJS-ng and Wizer. The guest environment is not Node.js or a browser: the PDK README documents no event loop, no background tasks, no Node filesystem/network/process APIs, and no DOM, Worker, WebSocket, or browser storage APIs. Its execution is synchronous; `async` syntax only works over already-resolved values, while HTTP is completed synchronously.

Therefore, 'JavaScript plugin' does not mean an ordinary JavaScript module running with the host's APIs. It is guest code compiled into a Wasm sandbox with a curated runtime surface.

## 3. Guest ABI and module composition

### 3.1 Bytes-in / bytes-out

An Extism plugin export accepts no more than the runtime's supported Wasm-level function shape and communicates payload data through Extism-managed memory. At the high level, the host serializes input to bytes, invokes an exported function, then reads output bytes and deserializes them. The guest does the inverse.

JSON is common, but the documented approach allows the host and guest to choose JSON, Protobuf, Cap'n Proto, Arrow, or another format supported by both languages. Rust PDK macros such as `#[plugin_fn]` and conversion traits hide lower-level memory offsets and encoding from guest authors.

This is ergonomic and language-neutral, but it deliberately leaves schema governance to the application. Extism does not provide a built-in semantic interface registry with contract IDs, compatibility ranges, or version negotiation. XTP Bindgen is an adjacent tool for generating bindings from an IDL; it is not the same thing as Extism's core runtime contract.

### 3.2 Multiple Wasm modules in one plugin

The manifest's `wasm` field is a list of module sources. A source may be loaded from disk, bytes, or HTTP, and may carry a name and optional SHA-256 hash. With multiple modules, Extism links the named modules through a shared linker; one module is the `main` module, either explicitly named or selected according to the manifest's ordering rules. Duplicate module names are rejected.

This supports splitting a guest implementation across Wasm modules and resolving their Wasm imports. It is not a CGP package graph: there are no independent module IDs, version ranges, capability requirements, nested Slots, contributor ordering, or per-submodule activation/shutdown lifecycle in this manifest.

### 3.3 Integrity and loading

Manifest module sources can be local files, in-memory bytes, or remote URLs. An optional SHA-256 hash is checked against the loaded bytes and a mismatch refuses loading. The manifest schema is strict and rejects unknown fields. The runtime build can disable filesystem or HTTP-based module registration through compile-time features.

For CGP, the hash check is a useful integrity primitive, but it is not a full supply-chain policy. CGP would still need trusted registries, package identity, signatures or attestations if required, compatibility checks, provenance, and policy for remote retrieval.

## 4. Host functions and authority

Host functions are host-provided imports that guest modules can call. They have a name, Wasm parameter/result types, optional user data, and an optional namespace. The default user namespace is `extism:host/user`; Extism's own functions use its environment namespace. A plugin cannot call a host function unless the host links a matching import.

The Rust API passes a `CurrentPlugin` context and typed `UserData` into the callback. Rust user data is reference-counted and mutex-wrapped; the callback must still implement the host's own safety and authorization rules. The C API uses opaque user-data pointers with a lifetime/cleanup contract.

Host functions are a useful capability-granting mechanism, but the grant is only as narrow as the callback. A function such as `database_query` can be read-only and bounded, or it can expose broad mutation authority. Extism cannot infer the intended policy from the function name or Wasm signature.

Important failure boundary: guest fuel and Wasm timeouts do not roll back a host function's external effects. If a plugin writes to a database, emits a network request, or mutates host state through a callback and later traps, those effects have already happened unless the host callback itself uses a transactional or proposal-based design.

CGP should preserve its existing host-owned capability model: host functions should be narrow adapters to explicit CGP services, not generic access to the Foundation's internals. A host callback that mutates authoritative state should still route through the correct CGP service/operation lane and validation boundary.

## 5. Manifest security and runtime limits

The current manifest model includes:

| Field | Purpose | Important boundary |
|---|---|---|
| `wasm` | One or more module sources, with optional name and SHA-256 hash | Does not define package dependency resolution |
| `memory.max_pages` | Maximum Wasm linear-memory pages | Not total process RSS or all host allocations |
| `memory.max_http_response_bytes` | Maximum Extism HTTP response size | Does not constrain arbitrary host-function responses unless host code does so |
| `memory.max_var_bytes` | Maximum Extism plugin-variable storage; zero disables vars | Does not bound all guest memory or external host state |
| `allowed_hosts` | HTTP destination allow-list; an empty list allows none | HTTP access also depends on runtime feature/configuration |
| `allowed_paths` | Host filesystem paths exposed inside WASI | Only meaningful when WASI is enabled |
| `config` | Host-provided key/value configuration | Configuration is readable by guest code; secrets should not be passed without need |
| `timeout_ms` | Per-plugin exported-function execution timeout | Does not constitute a composition-wide scheduling budget |

WASI is opt-in in the Rust PluginBuilder. Without WASI, guest code does not receive WASI filesystem or POSIX-like interfaces. The runtime also provides a separate host-controlled HTTP function, so HTTP capability should be controlled independently from WASI. The configuration docs distinguish runtime build features for HTTP and remote module registration.

The Rust PluginBuilder additionally exposes an instruction fuel limit. The current source applies the initialization fuel budget before linking/instantiation/guest initialization and refills the normal call budget before the exported call. Initialization fuel can be separately overridden, but only when a call fuel limit is also configured.

The timeout uses Wasmtime epoch interruption. The Rust source starts the timer immediately before calling the selected guest export and stops it when that call returns. Cancellation can be requested through a `CancelHandle` from another thread. This is a guest-execution interruption mechanism, not a rollback mechanism.

Limitations to keep explicit:

- A Wasm page cap does not cap the entire host process, host-function allocations, or memory held by external services.
- Per-plugin limits do not automatically add up to a composition-wide or backend-wide budget.
- Fuel bounds Wasm instruction consumption, not arbitrary time spent in host callbacks or external services.
- A host callback can block or perform side effects outside the guest's linear memory; the host must bound it independently.
- Enabling WASI expands the capability surface. Filesystem paths and HTTP hosts must be intentionally configured.
- The JavaScript host runtime has target-specific behavior. Browser background-thread support in the SDK requires `SharedArrayBuffer` and `Atomics` support in a `crossOriginIsolated` context.

## 6. Plugin lifecycle and state

### 6.1 Construction and invocation

The Rust runtime separates compilation from instantiation:

1. `PluginBuilder` receives raw Wasm or a manifest and collects options, imports, WASI enablement, and limits.
2. `CompiledPlugin::new` creates the Wasmtime engine, loads/compiles the Wasm modules, validates the main module, and prepares a reusable compiled representation.
3. `Plugin::new_from_compiled` creates a plugin-specific Wasmtime Store, `CurrentPlugin` context, linker, host context, cancellation handle, and per-instance runtime state.
4. Guest instantiation is lazy. The source explains that this avoids running a Wasm start function outside the call path.
5. On the first export call, Extism instantiates the guest, detects supported guest runtime initialization functions where needed, and initializes that runtime.
6. The call path sets input, invokes the selected export, handles the return code/output/error, and stops the timeout timer.

A plugin instance is therefore not just a static module file. It is a stateful runtime object with its own Store, instance, memory, variables, imports, and host context.

### 6.2 Persistent state and memory lifetime

Extism documents persistent plugin variables and module-scope state between calls. The JavaScript SDK README demonstrates a counter that increments across repeated calls and states that variables are not shared between plugin instances.

Extism also manages a separate buffer space for host/guest message passing. The memory documentation explains that the managed input/output buffers are reset/cleaned up between calls; output data is valid only until the next plugin call. This must not be confused with all guest state being reset between calls: plugin variables and guest instance state are intentionally capable of persisting.

The host can explicitly reset the plugin runtime and free Extism-managed allocations. The exact reset behavior and state semantics should be tested per SDK before building a persistence adapter around it. CGP should not assume Extism variables are equivalent to CGP `exportState`/`importState` save slices.

### 6.3 Concurrency and pools

The FAQ states that Extism plugins are single-threaded. The Rust `Plugin::call` API requires mutable access to the instance and uses a try-lock to reject reentrant calls. The Rust `Pool` provides bounded concurrent access by creating additional Plugin instances up to `max_instances`, then reusing instances returned to the pool.

A `PoolPlugin` is returned to the pool on drop. Its drop implementation pushes the instance back into the available queue when the pool still exists. The `with_plugin` helper returns the callback's result; normal scope exit drops the checkout wrapper whether the callback succeeded or returned an error.

This is a practical throughput strategy, but each pooled instance has independent state. It is not shared-state parallelism and does not provide deterministic ordering across instances. A host that requires one authoritative state must coordinate calls and state explicitly.

### 6.4 Failure and replacement

Extism reports traps, timeouts, fuel exhaustion, missing exports, and guest-returned errors to the host. It can optionally capture Wasm coredumps and memory dumps for diagnostics.

However, a failed call is not a transaction. The call path invokes the guest in its existing instance; the inspected source does not show a general automatic rollback or guaranteed instance replacement on trap. A guest may have changed its own memory or persistent variables before failure. It may also have called host functions that already changed external state.

The Rust pool's automatic return-on-drop means an error returned from a `with_plugin` callback does not, by itself, evict that instance. A host using the pool for untrusted or stateful work should define an explicit policy for discarding/recreating an instance after a trap, timeout, fuel exhaustion, or integrity failure. This is a significant difference from CGP's simulation proposal-and-ledger path, where rejected proposals do not commit to the authoritative ledger.

The inspected runtime exposes explicit free/drop semantics but does not impose a general guest `shutdown` export or CGP-style lifecycle sequence. If the host wants a plugin-specific cleanup callback, it must define and invoke that convention itself before releasing the instance. Host-side resource cleanup must remain correct even if guest cleanup fails.

## 7. Testing and authoring experience

Extism separates Host SDKs (used by the application to load/run plugins) from PDKs (used by plugin authors to compile guest Wasm). The supported language matrix is broad, and PDKs provide idiomatic wrappers for exports, inputs/outputs, configuration, variables, logging, and memory.

Extism's testing documentation describes the `xtp` CLI and test harness libraries for JavaScript/TypeScript, Rust, Go, and Zig. Tests execute plugins in a Wasm runtime and can assert outputs, plugin state, and timing. The documented `--mock-host` flow allows a test to provide a Wasm module that stands in for imported host functions.

This is a strong pattern for CGP's independent module SDK: authoring convenience should be backed by tests that execute the real guest artifact through the actual host ABI, not only by tests of source-level functions.

## 8. Comparison with CGP

| Concern | Extism | CGP today |
|---|---|---|
| Primary purpose | Embedded Wasm execution framework and plugin developer ecosystem | Modular composition platform with explicit Foundation contracts and multiple execution backends |
| Plugin system contract | Defined by each host application | Defined by CGP manifests, contracts, Slots, and ADRs |
| Dependency resolution | No general package resolver; manifest modules are statically linked into one plugin | Explicit capability/module requirements, provider resolution, deterministic ordering, and refusal rules |
| Module composition | One Extism plugin may link multiple named Wasm modules | Independent modules compose through nested, module-owned Slots |
| ABI | Bytes-in/bytes-out plus PDK conversion helpers | Versioned CGP core-module ABI and JSON payloads/handles; WIT compatibility prototype remains a separate research direction |
| Host capabilities | Imported host functions, Extism APIs, optional WASI and HTTP | CGP service/Slot contracts, backend grants, and composition-scoped handles |
| Lifecycle | Host constructs, calls, resets, and frees plugin instances; no universal guest shutdown lifecycle | Discover, validate, resolve, prepare, register, initialize, run, shutdown |
| State | Stateful Wasm instance and plugin variables; separate instances have separate state | Module-owned save slices, caller-driven save/restore, and explicit simulation ledger authority |
| Isolation | Wasm sandbox inside the host process | Node/browser worker isolation with per-module guest instances and explicit composition sessions |
| Limits | Per-plugin memory, variable, HTTP-response, timeout, and fuel controls | Per-guest and aggregate composition/backend budgets, worker limits, and explicit backend enforcement |
| Failure semantics | Call errors/traps; no general rollback of guest or host side effects | Proposal validation and ledger commit boundary for the supported simulation proof; no general transaction for arbitrary module-local state |
| Concurrency | Single-threaded plugin instance; pool multiple instances | Per-module worker sessions and CGP-controlled operation lanes/dispatch |

CGP ADR baselines checked for this study:

- ADR 0002 — Manifests, Slots, and Resolution
- ADR 0003 — Execution, Trust, and Lifecycle
- ADR 0004 — Ordered Dispatch
- ADR 0005 — Module-Owned Saves
- ADR 0011 — Isolated WebAssembly Guests
- ADR 0012 — Cross-Backend Execution and Aggregate Budgets
- ADR 0015 — Caller-Driven Simulation Steps
- ADR 0016 — Simulation Integrity

## 9. Transferable ideas and non-transferable mechanisms

| Extism mechanism | Possible CGP lesson | Important limit |
|---|---|---|
| Host SDK / PDK split | Separate module-author ergonomics from host integration | CGP still owns its own package, Slot, and lifecycle contracts |
| Bytes-in/bytes-out ABI | Keep cross-language boundary simple and serialization explicit | Not a typed contract registry or zero-copy guarantee |
| Host-function namespaces | Group imports and expose narrowly scoped capabilities | Callback authority and side effects remain host responsibilities |
| Strict manifest schema and module hash | Reject unknown metadata and verify artifact bytes | Hash alone is not package provenance or signature verification |
| Wasm memory/timeout/fuel controls | Apply defense-in-depth to guest execution | Must be extended to composition-wide and host-callback budgets |
| CompiledPlugin reuse | Separate expensive compilation from per-instance state | Compiled artifact reuse does not mean guest state is shared |
| Bounded plugin pool | Offer bounded concurrency with independent instances | Requires explicit state isolation and deterministic coordination |
| `xtp` guest test harness | Test compiled Wasm through the actual host ABI and mock imports | Mock host tests do not replace integration tests with real capabilities |

## 10. Recommendations for CGP

1. **Do not replace CGP's Foundation with Extism.** Extism intentionally leaves plugin-system semantics to the host. CGP already has the module identity, dependency, Slot, contract, ordering, profile, and lifecycle machinery that Extism does not attempt to provide.
2. **Treat Extism as a candidate guest-runtime adapter, not an architecture mandate.** Compare its Rust/Wasmtime execution path with CGP's current Node/browser worker backends and current ABI before considering a prototype.
3. **Preserve the current ABI while evaluating SDK ergonomics.** A future CGP PDK could provide high-level typed helpers over the existing ABI without adopting Extism's full runtime or binary contract.
4. **Use host functions only as narrow capability adapters.** Each import should map to an explicit CGP service or contract, with host-side validation, authorization, budgeting, and deterministic mutation rules.
5. **Keep state persistence host-owned.** Treat guest memory and plugin variables as runtime-local state. Use CGP save slices for durable state, with explicit versioning and restore validation.
6. **Define a failed-instance policy.** After a trap, timeout, fuel exhaustion, or malformed result, decide whether the guest instance can be reused or must be discarded. Do not let a generic pool silently decide the platform's integrity policy.
7. **Retain aggregate budgets outside the guest runtime.** Per-plugin memory/fuel/timeout limits are necessary but not sufficient for many modules or multiple compositions sharing one host.
8. **Borrow the testing model.** Compile a third-party guest artifact, load it through the real CGP ABI, exercise imports, verify failure behavior, and test state across calls and fresh instances.

## 11. Open questions for the next Extism slice

- How exactly do plugin variables, guest linear memory, and Extism-managed message buffers behave across normal calls, explicit reset, `_start`, trap, and re-instantiation in each SDK?
- Which runtime features are genuinely consistent between the Rust/Wasmtime runtime and the JavaScript SDK in browsers and Node?
- How does Extism's host-controlled HTTP enforce allowed-host matching, redirect behavior, response limits, and timeout propagation?
- Can a plugin pool safely discard unhealthy instances without races or leaking capacity after failed construction/calls?
- What is the exact boundary between Wasm fuel/time limits and time spent inside synchronous host functions?
- Could CGP reuse selected PDK concepts while retaining its own ABI, or would that create an unnecessary second abstraction layer?

## 12. Conclusion

Extism is a strong reference for embedded Wasm execution, language-specific host/guest SDKs, byte-oriented ABI design, capability imports, runtime limits, and test tooling. It is not a replacement for a module platform: dependency resolution, semantic contracts, composition, module ownership, lifecycle policy, and deterministic state authority remain host responsibilities.

For CGP, the appropriate direction is to study Extism as an execution and authoring layer. Preserve CGP's Foundation, Slots, composition sessions, module-owned saves, aggregate budgets, and proposal/ledger authority. A later prototype should answer whether Extism's guest runtime or only its SDK/PDK ideas offer a measurable advantage over the existing CGP backend.
