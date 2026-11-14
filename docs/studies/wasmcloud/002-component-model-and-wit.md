# wasmCloud Study 002 — WebAssembly Component Model and WIT

**Research date:** 2026-11-14  
**Subject:** WebAssembly Component Model, WIT, Canonical ABI, resources, async, and runtime portability  
**CGP comparison baseline:** [4003955c2328569ae365a2c873c856eed4342bbd](https://github.com/MrWizard94-Compile/Composable-Game-Platform/commit/4003955c2328569ae365a2c873c856eed4342bbd)  
**Related study:** [001 — Component host and capability model](001-component-host-and-capability-model.md)

## Purpose and decision boundary

Determine whether the WebAssembly Component Model and WebAssembly Interface Types (WIT) could provide CGP with a standardized, typed, language-neutral module ABI without replacing CGP's defining composition model.

This is a research note, not an implementation decision. No CGP ABI, manifest, backend, module graph, or SDK decision is made here.

## Executive conclusion

**WIT is a strong candidate for the contract layer of CGP's isolated-module ABI, but the Component Model is not a drop-in replacement for CGP's host architecture.**

The strongest fit is a layered design:

1. Keep CGP manifests, profiles, module identity, capability grants, nested Slot ownership, dependency resolution, contribution ordering, save policy, and deterministic host scheduling as CGP responsibilities.
2. Use WIT packages and interfaces to define the typed imports and exports behind module contracts.
3. Let the CGP host resolve the composition graph and decide which module export satisfies each module import. WIT validation checks interface compatibility; CGP still decides whether a connection is allowed and where it belongs.
4. Keep the current core-module ABI as a possible compatibility backend while a Component Model backend is prototyped. Do not commit to a migration before Node/browser parity, lifecycle, resource ownership, async, and performance are measured.

The most important obstacle is not WIT's type system. It is **runtime portability**. Wasmtime 46+ supports WASI 0.3, but ordinary browsers do not natively execute Component Model binaries. JavaScript tooling uses JCO transpilation into JavaScript wrappers and core Wasm modules. WASI 0.3 support in the JavaScript ecosystem is still experimental, and the browser path needs direct validation.

A second major obstacle is concurrency. WASI 0.3 adds native async, streams, and futures, but cancellation is cooperative and task resumption can be nondeterministic. CGP must not allow arbitrary asynchronous component work to mutate authoritative simulation state outside its existing serialized operation and commit rules.

## 1. Terminology: module versus component

The Component Model introduces a different binary format from a core WebAssembly module.

| Term | Meaning |
|---|---|
| Core Wasm module | The original WebAssembly binary format. It exposes low-level imports/exports, linear memory, and primitive function signatures. |
| Component | A Component Model binary. It can contain core modules and nested components, and describes richer typed imports/exports. |
| WIT | The interface-definition language used to describe component interfaces, worlds, types, and package identities. |
| World | The complete external contract of a component: what it imports and what it exports. |
| Interface | A named collection of typed functions and types. |
| Canonical ABI | The standardized lowering/lifting rules that map WIT-level values to the lower-level core Wasm representation. |
| WASI | A set of standardized system interfaces described using WIT. WASI is not the Component Model itself. |

A component can contain one or more core modules and other components. Its internal implementation is hidden behind the declared WIT surface. Components can be composed by satisfying imports with compatible exports.

This distinction matters for CGP: the current guest ABI is a custom JSON protocol over core Wasm modules. Adopting WIT would mean adopting or adapting to the Component Model binary format and its runtime/tooling, not merely changing the JSON schema.

Sources:
- [Component Model FAQ](https://component-model.bytecodealliance.org/reference/faq.html)
- [Component Model components and composition](https://component-model.bytecodealliance.org/design/components.html)
- [Canonical ABI](https://component-model.bytecodealliance.org/advanced/canonical-abi.html)

## 2. WIT contracts: interfaces and worlds

WIT separates an interface's vocabulary from a component's complete import/export surface.

An interface describes typed operations and data. WIT supports primitives, strings, lists, options, results, tuples, records, variants, enums, flags, resources, and (in WASI 0.3) async functions, streams, and futures.

A world describes the complete external surface of one component:
- exported interfaces/functions are functionality the component provides;
- imported interfaces/functions are dependencies the host or another component must fulfill.

A world does not describe internal behavior. It cannot prove that a component's implementation is correct, deterministic, safe, or semantically compatible with the intended game behavior.

The host can inspect and validate the component's declared world before running it. If a component does not import a filesystem or network interface, the host need not link one. The Component Model's boundary is therefore a useful basis for capability-oriented isolation.

### Why this is useful to CGP

CGP already has:
- module manifests;
- capability requirements and provisions;
- Slot exposure declarations;
- explicit Slot connections;
- contract names and versions;
- a host-resolved composition graph.

WIT can add a typed contract for each import/export. It should not replace the manifest or composition graph.

A module world could describe all of its external WIT imports and exports, while the CGP manifest continues to say:
- which module owns each Slot;
- which Slot a contribution targets;
- whether a Slot is a registry, service, or another kind;
- which provider a connection resolves to;
- whether the dependency is optional;
- what capability grants are required;
- what lifecycle and save rules apply.

**Important:** WIT package, interface, and world are not interchangeable with CGP package, module, and Slot. A WIT package groups interface definitions; a world describes one component's boundary; a CGP module owns runtime behavior and may own multiple nested Slots.

Sources:
- [WIT reference](https://component-model.bytecodealliance.org/design/wit.html)
- [WIT worlds](https://component-model.bytecodealliance.org/design/worlds.html)
- [WIT packages](https://component-model.bytecodealliance.org/design/packages.html)

## 3. Versioning and compatibility

WIT package IDs can include a namespace, package name, and optional SemVer version, for example:

    package cgp:render-contracts@1.2.0;

WIT also supports item-level feature gates:
- @since(version = ...) identifies an item introduced in a particular package version;
- @deprecated(version = ...) marks an item deprecated;
- @unstable(feature = ...) marks an experimental item.

These gates let tooling validate whether an item is available to a component targeting a particular version. The Component Model also defines structural type compatibility and canonical interface names. WASI 0.3.1 adopted the implements and external-id annotations for plain-named interface imports and exports.

However, **WIT does not define package dependency resolution**. Tooling decides how packages are located and resolved. Version-aware linking support is also not uniform across all tools. Current WASI guidance recommends pinning all WIT-aware tools to the same exact WIT version where necessary; mismatched versions can surface as confusing wrong-type instantiation errors.

This means WIT should not be treated as a complete replacement for CGP's existing SemVer and dependency-resolution logic.

### Recommended CGP division of responsibility

| Concern | Owner |
|---|---|
| Module release version | CGP manifest/package system |
| Foundations API compatibility | CGP |
| Slot contract identity and compatibility range | CGP manifest/composition resolver |
| Typed function/data shape | WIT interface |
| Component import/export surface | WIT world |
| WIT package dependency acquisition and pinning | CGP SDK/package tooling |
| Compatibility policy and migration rules | CGP, using WIT validation as one input |

CGP should pin exact WIT package versions in lockfiles or equivalent resolved metadata. It should not assume that a WIT package's SemVer string automatically causes every runtime to select a compatible provider.

A further design question is whether the CGP contract version and WIT package version should always move together. They represent different things: CGP's contract may include ownership, mutability, scheduling, lifecycle, and persistence semantics that WIT's type signatures do not encode.

Sources:
- [WIT package and feature-gate syntax](https://github.com/WebAssembly/component-model/blob/main/design/mvp/WIT.md)
- [WASI Component Model feature adoption](https://github.com/WebAssembly/WASI/blob/main/docs/ComponentModelFeatures.md)
- [WASI release and version-pinning guidance](https://wasi.dev/releases)

## 4. Cross-language interoperability and Canonical ABI

The Canonical ABI defines how rich WIT values are represented at the binary boundary. A Rust record, a C struct, and a JavaScript object can represent the same WIT record while the Canonical ABI standardizes how values cross between components.

This avoids requiring every language pair to invent its own serialization protocol. It also removes the need for CGP to define JSON as the only cross-language data representation.

Potential benefits:
- typed values instead of runtime JSON validation for every call;
- generated language bindings;
- explicit result/error variants;
- resource handles with ownership rules;
- language-neutral interface packages;
- local component-to-component calls without requiring HTTP or a network protocol.

Potential costs:
- generated bindings and componentization become part of the build toolchain;
- component binaries and adapters may be larger than a simple core module;
- the runtime must implement the Component Model and the exact WIT/WASI features used;
- component startup, linking, memory, and call overhead must be benchmarked;
- developers must manage WIT dependencies and toolchain version pins.

The Canonical ABI standardizes representation and calling convention. It does not guarantee low overhead, zero-copy behavior for every type, or identical performance across runtimes.

Sources:
- [Canonical ABI overview](https://component-model.bytecodealliance.org/advanced/canonical-abi.html)
- [Component Model FAQ](https://component-model.bytecodealliance.org/reference/faq.html)

## 5. Resources, handles, and ownership

WIT resources model entities that should not be copied as ordinary data. A resource is exposed through methods and passed using handles.

Two ownership modes matter:

- An owned resource handle transfers unique ownership. When its owner drops it, the resource is destroyed.
- A borrowed handle represents a temporary loan for the duration of a call. The callee must not retain the borrowed handle after the call returns.

This is more expressive than passing an arbitrary integer or JSON object as a handle. It gives bindings and the Canonical ABI explicit ownership semantics.

### Mapping to CGP

CGP already has host-minted dispatch handles:
- the visible JSON-like fields are not the capability;
- a private WeakMap brand distinguishes real handles from lookalikes;
- handles are scoped to a composition;
- a handle from another composition cannot dispatch;
- composition release tears down the execution session.

WIT resources could provide a standard typed handle abstraction for component-facing objects such as:
- a contribution endpoint;
- a Slot service proxy;
- a host capability;
- a stream subscription;
- a composition-scoped context object.

But WIT resource handles are not automatically CGP's dispatch authorization. CGP would still need to enforce:
1. which composition owns the resource;
2. which module is allowed to use it;
3. which Slot or contract it represents;
4. whether the handle is still live;
5. what happens on module shutdown, restore, failed initialization, or composition release.

**Recommendation:** if CGP prototypes WIT, model at least one composition-scoped resource and test forged, stale, cross-module, and cross-composition use. Do not replace the existing handle security tests with type validation alone.

Sources:
- [WIT resource ownership](https://component-model.bytecodealliance.org/design/wit.html)
- [Canonical ABI handle ownership](https://component-model.bytecodealliance.org/advanced/canonical-abi.html)

## 6. Async, streams, futures, and cancellation

WASI 0.3 (released June 11, 2026) adds native async primitives to the Component Model:

- async func: a function call may suspend before returning;
- future<T>: one typed value that becomes available later;
- stream<T>: a typed asynchronous sequence of values.

These are Canonical ABI primitives, not ordinary application-level polling conventions. They allow asynchronous readiness to pass through multiple component boundaries without every intermediate component implementing an event loop merely to forward wake-ups. This addresses the WASI 0.2 "sandwich problem."

WASI 0.3 builds on the 0.2 Component Model foundation. Runtimes can support both versions, and 0.3 hosts can adapt 0.2 imports at the boundary.

### Cancellation is cooperative, not forced termination

The concurrency design permits a caller to request cancellation of an in-flight subtask. But cancellation is not an instruction to instantly kill arbitrary guest execution.

A cancellation request can arrive after the callee has started. The callee may continue running, perform imports, perform I/O, and produce side effects until it reaches a cancellation delivery point and resolves the task. The caller may still receive a normal return if the callee wins the race. Borrowed handles must be returned before the task is considered resolved.

The concurrency design also documents nondeterministic resumption ordering in some cases where multiple blocked tasks become ready.

This is an important limitation for CGP. Cancellation cannot be treated as rollback, and an async task cannot be assumed to stop immediately when a simulation step or module is cancelled.

### CGP deterministic execution implications

CGP currently has caller-driven simulation steps, serialized operation lanes, and explicit commit authority. Those rules should remain authoritative.

A WIT async interface could be useful for I/O, resource loading, streaming assets, networking, and background preparation. But async completion must not silently mutate simulation state from outside CGP's lane and commit model.

A safe pattern to investigate is:

1. An isolated component starts asynchronous work.
2. The result is delivered as a completion or proposal.
3. CGP records the completion in a host-owned queue.
4. The caller decides which deterministic step consumes it.
5. Authoritative state changes occur only through the existing host-controlled mutation/commit path.

The exact queue ordering and replay policy would need to be specified. If external completion timing changes which step receives an event, deterministic replay requires recording the event and its assigned step.

**Recommendation:** do not make WASI 0.3 async the default for simulation hooks. Keep deterministic simulation hooks synchronous or explicitly step-scheduled. Allow async only through host-defined service boundaries with documented cancellation, backpressure, and completion semantics.

Sources:
- [Native async with WASI 0.3](https://component-model.bytecodealliance.org/design/async.html)
- [Component Model concurrency explainer](https://github.com/WebAssembly/component-model/blob/main/design/mvp/Concurrency.md)
- [Canonical ABI async and cancellation operations](https://component-model.bytecodealliance.org/advanced/canonical-abi.html)
- [WASI 0.3 release](https://wasi.dev/releases/wasi-p3)

## 7. Node and browser runtime portability

This is the largest practical constraint for CGP.

### Node.js

The JavaScript tooling stack includes:
- componentize-js: builds components from JavaScript/TypeScript projects;
- jco: componentization, generated bindings/types, transpilation, and execution support;
- generated TypeScript declaration files;
- an experimental WASI 0.3 preview3-shim for Node.js.

The JavaScript ecosystem can run transpiled components from Node. WASI 0.3 support through the JavaScript shim is still described as experimental, rather than the same mature support offered by Wasmtime 46+.

CGP's package currently targets Node 22 or newer. A prototype must test the exact Node versions CGP intends to support, not infer compatibility from the fact that Node supports core WebAssembly modules.

### Browser

Ordinary browsers currently execute core WebAssembly modules, but do not natively execute Component Model binaries. The documented JavaScript path is:

1. Build a component binary.
2. Run jco transpile.
3. Generate JavaScript wrappers and one or more core Wasm modules.
4. Import the generated JavaScript from the browser application.

This can make a component usable in a browser without native Component Model support, but it is a transpilation path—not direct browser execution of the component binary.

WASI 0.3 browser support needs additional care. The WASI language matrix identifies the JavaScript 0.3 shim as experimental for Node.js; it does not establish equivalent turnkey browser support for CGP. The Component Model concurrency design discusses browser polyfilling through JavaScript Promise Integration (JSPI), but CGP must verify actual browser support, generated code, and behavior in its supported browsers.

### Practical support matrix (research snapshot)

| Runtime/toolchain | Component Model status | CGP implication |
|---|---|---|
| Wasmtime 46+ | WASI 0.3 support enabled by default; also runs 0.2 | Strong server/runtime reference |
| Node + jco | Components can be transpiled and run; WASI 0.3 shim is experimental | Viable prototype route, but pin versions and test |
| Browser + jco transpilation | Component converted to JS wrappers and core Wasm modules | Possible browser route; not native component execution |
| Browser + WASI 0.3 async | Depends on generated tooling and JSPI/runtime support | Not yet a verified CGP deployment target |
| Rust | Component tooling exists; WASI 0.3 toolchain support is newer than 0.2 | Strong candidate guest language |
| Python / Go / C / C++ | Toolchain support varies; many paths remain WASI 0.2 or core modules | Do not promise a uniform WASI 0.3 cross-language target |

Toolchain support changes quickly. The table is a research snapshot, not a permanent compatibility guarantee. Before implementation, pin a specific jco, wit-bindgen, wasm-tools, Wasmtime, Node, and browser matrix and run the same component tests across it.

Sources:
- [JavaScript component tooling](https://component-model.bytecodealliance.org/language-support/javascript.html)
- [Running components in JavaScript and browsers](https://component-model.bytecodealliance.org/language-support/building-a-simple-component/javascript.html)
- [WASI language support matrix](https://wasi.dev/languages)
- [WASI release and toolchain support](https://wasi.dev/releases)
- [Wasmtime Component Model support](https://component-model.bytecodealliance.org/running-components/wasmtime.html)

## 8. How WIT could map onto CGP without replacing CGP

The most promising conceptual mapping is:

| CGP concept | Possible WIT/Component Model representation | What remains CGP-owned |
|---|---|---|
| Module's external ABI | A WIT world | Module identity, version, implementation package, lifecycle |
| Slot contract | A WIT interface | Slot ownership, kind, multiplicity, mutability, ordering, policy |
| Module dependency | WIT import plus CGP manifest requirement | Optionality, provider selection, version range, profile resolution |
| Slot provider | Component export implementing a WIT interface | Which provider is selected and whether the connection is authorized |
| Service call | Typed imported interface function | CGP operation-lane and mutation semantics |
| Dispatch handle | WIT resource handle | Composition scoping, ownership authorization, stale-handle policy |
| Async operation | WIT async function/future/stream | Deterministic completion queue, step assignment, replay policy |
| Composition/profile | CGP composition graph | Entire graph resolution, reproducibility, lifecycle and persistence |

### A possible layered architecture

- WIT defines a versioned typed interface for a Slot contract.
- A module component's world declares which Slot interfaces it imports and exports.
- The CGP manifest declares the module's ownership and graph-level dependencies.
- CGP resolves the profile and chooses the actual provider for each import.
- The host links or instantiates components using those resolved providers.
- Host-defined resource handles expose only authorized, composition-scoped capabilities.
- The CGP runtime retains authority over lifecycle, state mutation, saves, deterministic stepping, and teardown.

This keeps the important distinction intact: **WIT describes what can be called; CGP decides which calls are connected, authorized, scheduled, and meaningful.**

### The registry Slot challenge

CGP Slots can represent more than one provider contribution. A WIT interface naturally describes a typed callable surface, but it does not by itself express CGP's registry semantics, contributor identity, ordering, exclusivity, or nested Slot ownership.

Possible approaches to prototype:
1. One provider component per contribution, with CGP retaining a host-side registry of typed component exports.
2. A WIT resource representing a registry/collection, with explicit contribution registration and lookup methods.
3. A component export representing a service while CGP's manifest and composition graph separately describe registry membership.

Do not assume that WIT component composition automatically reproduces CGP's runtime registry behavior.

## 9. Risks and failure points

1. **Browser parity:** native component binaries do not currently run directly in browsers. Transpilation adds generated code and a second artifact path.
2. **WASI 0.3 ecosystem maturity:** async support is stable in the standard and Wasmtime, but language and JavaScript runtime support remains uneven.
3. **Version mismatch:** WIT package versions, generated bindings, and host implementations must be pinned. Some mismatches appear only at instantiation.
4. **Composition mismatch:** Component Model composition is typed import/export linking; CGP composition includes profiles, nested Slots, provider selection, ownership, and runtime policy.
5. **Resource lifetime:** WIT ownership rules do not automatically implement CGP's composition-scoped authorization or persistence semantics.
6. **Cancellation:** cooperative cancellation can leave a task running and producing side effects after a request. It is not rollback.
7. **Determinism:** async task scheduling and completion order can affect which simulation step consumes an event unless CGP records and schedules completions explicitly.
8. **Toolchain burden:** authors need WIT dependencies, binding generators, componentizers, validators, and runtime-compatible versions.
9. **Artifact size and startup cost:** jco's browser output can include substantial JavaScript and core Wasm artifacts. Benchmark rather than assume it is negligible.
10. **Security overclaim:** typed imports constrain the declared interface surface, but host implementations, grants, resource budgets, artifact provenance, and native host code still require explicit trust policy.

## 10. Recommendation for CGP

Do not replace cgp.abi/1 yet.

Proceed with a **small compatibility prototype** before finalizing M4:

1. Define one minimal WIT package for a CGP-owned service Slot contract.
2. Define a second interface for a registry Slot, including contribution identity and dispatch.
3. Build one guest in Rust and one in JavaScript/TypeScript, both implementing the same WIT contract.
4. Validate the components with wasm-tools and run them under Wasmtime.
5. Transpile the same component artifacts with jco and run them in Node.
6. Run the transpiled artifacts in Chromium and at least one additional browser.
7. Exercise owned and borrowed resource handles, stale handles, cross-composition handles, and release.
8. Exercise async success, failure, cancellation races, and shutdown while a call is pending.
9. Measure artifact size, build time, load time, call overhead, memory, and worker/resource usage against the current cgp.abi/1 implementation.
10. Confirm that deterministic simulation mutations still occur only through the CGP operation lane and explicit commit path.

The prototype should answer whether WIT can be used as:
- the complete guest ABI;
- a typed contract/SDK layer that generates adapters for the current ABI;
- or a server-side-only backend with the current ABI retained for browsers.

No migration should be approved until all three deployment models are compared with actual test results.

## 11. Questions remaining before M4

1. Can the same WIT package and component binary be used unchanged by Wasmtime, Node, and browser-transpiled execution?
2. Which WIT/WASI version should CGP initially pin: 0.2 for wider toolchain support, or 0.3 for native async?
3. Should CGP's deterministic simulation-facing calls remain synchronous even if the broader component ABI supports async?
4. How should registry Slots map to component exports without losing contribution identity and order?
5. Should a Slot contract be one WIT interface, or should a module world expose several Slot interfaces?
6. Can resource handles preserve the exact guarantees of CGP's current composition-scoped WeakMap-branded handles?
7. What is the smallest stable subset of WIT/WASI that CGP needs, so the SDK does not inherit unnecessary system interfaces?
8. How should CGP version its own semantic contract independently of the WIT package version?
9. Does the browser transpilation path preserve the resource and async semantics needed by CGP?
10. What are the measurable performance and artifact-size costs?

## Conclusion

WIT is worth prototyping as CGP's typed contract layer. It provides a standardized vocabulary for interfaces, worlds, rich types, resources, and cross-language calls. WASI 0.3 also makes async composition much more expressive, but introduces cancellation and scheduling behavior that CGP must control carefully.

The best architectural direction is likely **CGP composition and authority above; WIT contracts and Canonical ABI at the isolated module boundary**. That is a hypothesis to validate, not a final design decision.

The immediate next step is a compatibility prototype—not an ABI rewrite. The prototype should prove Node and browser behavior, resource lifetime, registry Slot mapping, deterministic mutation authority, and performance before M4 is finalized.

No CGP implementation code was changed as part of this study.
