# wasmCloud Study 001 — Component Host and Capability Model

**Research date:** 2026-11-14  
**External project:** wasmCloud  
**Architecture studied:** wasmCloud v2  
**Upstream source revision:** [eea4b0dba926e5c71012f8babb248110007d0fba](https://github.com/wasmCloud/wasmCloud/commit/eea4b0dba926e5c71012f8babb248110007d0fba)  
**CGP comparison baseline:** [e6128a26ea41d09dbabb64bb7f48a1eb127e274e](https://github.com/MrWizard94-Compile/Composable-Game-Platform/commit/e6128a26ea41d09dbabb64bb7f48a1eb127e274e)

## Purpose

Study wasmCloud's component-host architecture, capability implementation model, WIT interface contracts, workload boundaries, lifecycle, and security model. Compare them with CGP's explicit module composition, nested Slots, trusted JavaScript backend, and isolated WebAssembly guests.

This is a research note, not an implementation decision. It does not authorize a change to CGP's ABI, backend, manifests, or composition model.

## Executive findings

1. **Use wasmCloud v2 as the current reference.** wasmCloud v1's separate capability-provider processes and NATS data-path model are historical. v2 uses host plugins and long-running service components; NATS is used for control-plane communication between the Kubernetes operator and hosts, not ordinary same-workload component calls.
2. **WIT and the WebAssembly Component Model are the most transferable mechanisms.** They provide typed, versioned, language-neutral imports and exports. They do not, by themselves, provide CGP's composition graph, nested Slots, module ownership, deterministic simulation, persistence, or lifecycle policy.
3. **Do not conflate three different execution roles:** untrusted invocation-oriented components, host-level capability plugins, and long-running stateful service components.
4. **A sandbox is not the whole security model.** Identity propagation, authorization, resource limits, host-plugin trust, control-plane authority, and state partitioning remain separate responsibilities.
5. **CGP already has a meaningful isolation foundation**, but its current cgp.abi/1 is a custom JSON ABI over core WebAssembly Modules, not WIT or the Component Model. Evaluate that boundary in a dedicated study before proposing a replacement.

## 1. Version boundary: wasmCloud v1 versus v2

The term *capability provider* is strongly associated with wasmCloud's earlier architecture. In v1, capability providers were separate processes that actors invoked through the lattice, with NATS participating in the data path. The old design included actors and providers as separately deployed distributed entities.

The current v2 design has changed materially:

- Components are WebAssembly Component Model binaries.
- The host links the WIT interfaces a workload is granted.
- Host plugins implement capabilities in the host, either as native Rust plugins or (when enabled) sandboxed Wasm host-component plugins.
- A workload may also contain one long-running service component.
- Components within one workload can call linked components directly in the host.
- NATS is part of the operator-to-host control plane; it is not the ordinary data path for local component-to-component calls.

The v2 migration documentation describes the shift away from the separate v1 provider model. The old v1 lattice architecture should therefore be treated as historical context, not as the design to copy for CGP.

Sources:
- [wasmCloud v2 architecture](https://github.com/wasmCloud/wasmCloud/blob/eea4b0dba926e5c71012f8babb248110007d0fba/ARCHITECTURE.md)
- [wasmCloud v2 migration guide](https://wasmcloud.com/docs/migration/)
- [Current project overview](https://github.com/wasmCloud/wasmCloud/blob/eea4b0dba926e5c71012f8babb248110007d0fba/README.md)
- [Historical v1 overview](https://wasmcloud.com/docs/v1/overview/)

## 2. The current v2 architecture

The current system separates several responsibilities:

| Part | Responsibility |
|---|---|
| Component | An independently built Wasm Component Model binary; can invoke only imported interfaces that are linked for it |
| Workload | Deployment and isolation unit containing one or more components and at most one long-running service component |
| Host | Runs components through Wasmtime, links granted interfaces, applies workload limits, and manages lifecycle |
| Host plugin | Implements a capability interface for workloads that bind it; can be native Rust or a Wasm host-component plugin |
| wash | Scaffolds, builds, runs locally, and publishes components |
| Runtime Operator | Reconciles Kubernetes workload/host resources and schedules workloads onto hosts |
| NATS | Control-plane transport between the operator and hosts |
| OCI registry | Stores component artifacts which hosts retrieve |

A workload spec is important: it declares the components, interfaces, network destinations, volumes, configuration, secrets, and resource grants that the host applies.

The deploy path is broadly:

1. An operator or local developer submits a workload.
2. A host retrieves the component artifacts and validates/compiles them.
3. The host resolves imports and exports and links only the interfaces the workload is granted.
4. The host establishes the workload's resource and network policy.
5. Components and, if present, the long-lived service are started.
6. The host reports workload status.

wash dev runs the local host path without the Kubernetes operator or NATS control plane. wash-runtime is also designed as an embeddable Rust runtime for custom hosts.

**CGP relevance:** The distinction between a reusable runtime library, a developer CLI, a deployable artifact, and an orchestrator is useful for M4 planning. CGP should not assume it needs Kubernetes or a distributed control plane. The local/embedded runtime and development loop are the closer comparisons.

## 3. WIT interfaces: contracts between independently built components

wasmCloud uses the WebAssembly Component Model and WIT (WebAssembly Interface Type) packages to describe component imports and exports.

A WIT package identifies a namespace, package, and version. A world describes the imports and exports of a component. This makes the component's interface surface explicit and language-neutral.

For example, a component might import a key/value interface and export an HTTP handler. The host uses the component's imports and the workload's grants to determine which host implementations can be linked.

When several components or host plugins can satisfy an interface, the runtime has explicit binding mechanisms. Named implements labels allow a component to identify which implementation it intends to use, rather than silently relying on whichever provider happens to be discovered first.

This gives the host and author a typed contract at the binary boundary. It also allows implementations to change without necessarily rebuilding the importing component, provided the replacement continues to satisfy the interface and its version contract.

**Important distinction:** WIT describes callable interfaces and data types; it does not describe CGP's entire module graph. In particular, WIT does not inherently define nested module-owned Slots, contribution ordering, profile composition, save authority, or caller-driven simulation.

**CGP relevance:** A future public module SDK could expose WIT interfaces for cross-language, isolated module boundaries while retaining CGP's higher-level Slots and composition graph. A WIT interface could become the typed contract behind a particular Slot or service, but this mapping needs an explicit design.

Sources:
- [wasmCloud interfaces overview](https://wasmcloud.com/docs/overview/interfaces/)
- [WebAssembly Component Model guide](https://component-model.bytecodealliance.org/)
- [wasmCloud external interface catalog](https://github.com/wasmCloud/wasmCloud/blob/eea4b0dba926e5c71012f8babb248110007d0fba/API.md)

## 4. Three distinct execution and extension roles

A key lesson from v2 is that "plugin" or "component" does not describe one interchangeable runtime role.

### 4.1 Workload components

These are the ordinary units of application logic:

- Independently built Wasm components.
- Sandboxed by the Wasmtime host.
- Each component can call only the interfaces imported by its binary and linked/granted by the host.
- Components are generally invoked for work rather than retained as a single always-running stateful instance.
- Component instances/stores may be reused only under explicit runtime policy.

They are the closest wasmCloud equivalent to CGP's isolated WebAssembly modules, but the models are not identical. CGP currently has its own hook ABI and module composition/registration contract.

### 4.2 Host plugins

Host plugins implement interfaces which workload components import. The current runtime supports two materially different kinds:

**Native Rust host plugins**
- Implement the HostPlugin trait.
- Declare the WIT world/interfaces they serve.
- Are registered into the host (for example through HostBuilder.with_plugin).
- Run as native host-process code and are trusted with the host's privileges.
- Are not a sandbox boundary.

**Wasm host-component plugins**
- Are themselves WebAssembly components running in a host-managed Wasmtime store.
- Are conditionally compiled behind host-component-plugin and OCI features in the inspected runtime.
- Can provide capability interfaces to workloads and can participate in lifecycle/trigger behavior.
- Can be shared across workloads; the host supplies caller workload identity to the plugin.
- Must use that host-asserted identity for authorization and partition state appropriately.

That last point is especially important: sandboxing a shared plugin does not automatically stop it from leaking one workload's data to another. The plugin serves multiple callers, so its own authorization and state-partitioning logic matter.

### 4.3 Long-running service components

A workload may contain at most one long-running service component in addition to its invocation-oriented components.

A service:
- Is a stateful, long-lived Wasm instance.
- Can listen on its workload's virtual network.
- Has a persistent in-memory state during its lifetime.
- Can receive host-driven ingress/trigger calls.
- May execute concurrent handlers against the same running instance/store context, subject to runtime concurrency controls.

The v2 model has an important asymmetry: a normal component does not simply call a service through the same WIT linked-component path. Service communication is exposed through its network/trigger interfaces, while services can invoke linked component exports. This is a different model from CGP's service Slot, so the two should not be equated.

Sources:
- [Host plugin architecture in source](https://github.com/wasmCloud/wasmCloud/blob/eea4b0dba926e5c71012f8babb248110007d0fba/crates/wash-runtime/src/plugin/mod.rs)
- [Host builder and Host API](https://github.com/wasmCloud/wasmCloud/blob/eea4b0dba926e5c71012f8babb248110007d0fba/crates/wash-runtime/src/host/mod.rs)
- [Workload linking and resolution](https://github.com/wasmCloud/wasmCloud/blob/eea4b0dba926e5c71012f8babb248110007d0fba/crates/wash-runtime/src/engine/workload.rs)
- [Plugin-initiated component/service dispatch](https://github.com/wasmCloud/wasmCloud/blob/eea4b0dba926e5c71012f8babb248110007d0fba/crates/wash-runtime/src/engine/dispatch.rs)
- [Service workload documentation](https://wasmcloud.com/docs/overview/workloads/services/)
- [Host plugins documentation](https://wasmcloud.com/docs/overview/hosts/plugins/)

## 5. Capability binding and policy

A useful separation in wasmCloud is that the component declares the interfaces it imports, while the workload/operator and host configuration decide which implementations and grants are supplied.

The host plugin declares the WIT world it can serve. The host matches workload imports to plugin interfaces and links the selected implementation into the Wasmtime component linker.

The current source also has an explicit binding/configuration layer:
- Host/operator configuration can declare named interface bindings and their config.
- A plugin can provide a schema describing which config keys it owns, which the workload may set, and which values may only be narrowed.
- Workload config policy can be allow, warn, or deny; deny is the default in the documented production configuration.
- The warn mode reports what deny would refuse without silently changing which value wins.
- Named binding labels can make multiple implementations of a package explicit.

This separates **interface compatibility** from **authority to configure or use a capability**.

**CGP relevance:** CGP's manifests already describe capabilities and Slot connections, and its backend policy distinguishes grants that can be enforced from those that cannot. The lesson is not to duplicate wasmCloud's exact configuration mechanism. It is to preserve a clean boundary between:
1. what a module asks for;
2. what the composition resolves;
3. what the host actually grants;
4. what policy the selected backend can genuinely enforce.

A declarative permission field by itself is not enforcement.

Source: [wasmCloud plugin binding implementation](https://github.com/wasmCloud/wasmCloud/blob/eea4b0dba926e5c71012f8babb248110007d0fba/crates/wash-runtime/src/plugin/bindings.rs)

## 6. Security and isolation model

wasmCloud's threat model is valuable because it describes both intended boundaries and known limitations.

### 6.1 Explicit grants, not ambient authority

A Wasm component can call only the imports linked into it. The host's default model is deny-by-default for filesystem, network, configuration, secrets, and other host capabilities.

The host and workload spec jointly determine which interfaces and external destinations are available.

### 6.2 Workload-level separation

Each workload has separate Wasmtime stores, memory, and a virtual network. Components within one workload may be linked to one another; cross-workload access is not implicitly available and must pass through explicit connections/interfaces.

### 6.3 Identity must cross the boundary safely

When a workload calls a plugin, the host supplies the caller's workload identity. A guest cannot choose or forge that identity. Plugins must authorize using the host-provided identity, not an ID supplied in request arguments.

This is a strong principle for any future CGP shared capability service: the host should establish caller identity from its own execution context, and providers should not trust a payload's self-asserted identity.

### 6.4 Resource isolation is multidimensional

The inspected threat model says memory, connections, and file descriptors have workload and/or host limits. It explicitly identifies CPU, instance slots, and scratch-disk size as not yet bounded by the same policy at that source revision.

Some operator flags can weaken security goals or switch enforcement to count-only behavior. The threat model documents those cases rather than presenting all configurations as equally strong.

### 6.5 Native plugins are trusted host code

A native Rust host plugin runs inside the host process. It is not made safe by implementing a trait or advertising a WIT interface. Wasm host-component plugins provide a sandbox boundary, but shared identity/state concerns still apply.

### 6.6 Supply-chain integrity is distinct from runtime sandboxing

The host treats OCI artifacts as untrusted bytes and sandboxes their execution, but the threat model says the host does not verify publisher signatures itself. The release process publishes signed provenance/attestations; the operator/deployment path is responsible for deciding which artifacts to trust.

This distinction matters: artifact integrity, publisher identity, runtime containment, and authorization are separate controls.

Sources:
- [wasmCloud threat model](https://github.com/wasmCloud/wasmCloud/blob/eea4b0dba926e5c71012f8babb248110007d0fba/THREAT_MODEL.md)
- [wasmCloud security self-assessment](https://github.com/wasmCloud/wasmCloud/blob/eea4b0dba926e5c71012f8babb248110007d0fba/SELF_ASSESSMENT.md)
- [Release and artifact verification runbook](https://github.com/wasmCloud/wasmCloud/blob/eea4b0dba926e5c71012f8babb248110007d0fba/RELEASE_RUNBOOK.md)

## 7. Direct comparison with CGP

CGP baseline is commit e6128a26ea41d09dbabb64bb7f48a1eb127e274e. At that revision, the relevant CGP model is:

| Concern | wasmCloud v2 | CGP baseline |
|---|---|---|
| Component boundary | WebAssembly Component Model binary | Core WebAssembly Module with cgp.abi/1 |
| Interface contract | Typed WIT imports/exports and worlds | JSON ABI hooks plus manifest capabilities and Slot contracts |
| Composition unit | Workload | Composition/profile |
| Extension topology | WIT imports linked to components/plugins; workload grouping | Explicit module graph and nested module-owned Slots |
| Capability implementation | Native Rust host plugin or Wasm host-component plugin | Execution backend plus module-provided Slot payloads/services |
| Isolation | Wasmtime component instances/stores and workload resource/network separation | Node/browser workers, one composition execution session, per-guest memory/binary/hook budgets |
| Trusted code | Native host plugins | In-process JavaScript backend |
| Mixed trust | Native and Wasm plugin roles | Cross backend routes Wasm guests to isolate and JavaScript hooks to trusted in-process backend |
| Long-lived service | One service component per workload | Service Slots and module lifecycle/persistent module-owned state |
| Distribution | wash build/publish, OCI component artifacts | Not yet an independent published SDK/distribution workflow |
| Control plane | Kubernetes operator and NATS host control plane | Currently local/embedded host composition; no equivalent cluster control plane is required |

CGP's WebAssembly guest ABI is intentionally smaller and different from WIT:
- It uses UTF-8 JSON messages for hook calls and results.
- A guest exports memory and ABI functions such as cg_alloc, cg_hook, cg_out_ptr, and cg_out_len.
- The only host import currently allowed is cgp.abi.log, when the manifest and policy grant cgp.log.
- Other imports are rejected.
- Host-minted dispatch handles are branded out-of-band and scoped to a composition, so a JSON lookalike or a handle from another composition cannot impersonate one.

CGP also has a cross backend: a composition can execute WebAssembly guests in the isolate while JavaScript hooks use the trusted in-process backend. This is not equivalent to wasmCloud's WIT Component Model linking, and the JavaScript half remains trusted, unbounded host code.

Sources:
- [CGP backend contract](https://github.com/MrWizard94-Compile/Composable-Game-Platform/blob/e6128a26ea41d09dbabb64bb7f48a1eb127e274e/src/foundations/backend.ts)
- [CGP WebAssembly isolate](https://github.com/MrWizard94-Compile/Composable-Game-Platform/blob/e6128a26ea41d09dbabb64bb7f48a1eb127e274e/src/foundations/wasm-isolate.ts)
- [CGP guest runtime](https://github.com/MrWizard94-Compile/Composable-Game-Platform/blob/e6128a26ea41d09dbabb64bb7f48a1eb127e274e/src/foundations/wasm-guest-runtime.mjs)
- [CGP ABI](https://github.com/MrWizard94-Compile/Composable-Game-Platform/blob/e6128a26ea41d09dbabb64bb7f48a1eb127e274e/src/foundations/abi.ts)
- [CGP cross backend](https://github.com/MrWizard94-Compile/Composable-Game-Platform/blob/e6128a26ea41d09dbabb64bb7f48a1eb127e274e/src/foundations/cross-backend.ts)
- [CGP manifest](https://github.com/MrWizard94-Compile/Composable-Game-Platform/blob/e6128a26ea41d09dbabb64bb7f48a1eb127e274e/src/foundations/manifest.ts)

## 8. Transferable lessons for CGP

### High priority: study WIT as a future public ABI option

WIT offers a mature way to describe typed, versioned, language-neutral interfaces. It could be valuable when CGP's independent SDK and distribution model supports more than one implementation language.

Do not assume it should replace cgp.abi/1 immediately. The current ABI is deliberately simple, runs in both Node and browser workers, and carries CGP-specific dispatch handles and JSON state. A migration would need to account for those semantics, tooling, supported runtimes, binary format, and backward compatibility.

### High priority: preserve the distinction between interface and permission

An interface contract says what may be called. A policy says whether this composition is authorized to call it. The backend must enforce the grant, or the host must refuse the policy before guest code runs.

Keep those concepts explicit in CGP's future SDK and packaging specification.

### High priority: define caller identity for shared capabilities

If CGP eventually supports capabilities shared among multiple compositions, the host must provide non-forgeable caller identity and define how providers isolate state and authorize each caller. Do not trust identity carried in ordinary user-controlled arguments.

### Medium priority: treat stateful services as a distinct execution role

wasmCloud demonstrates that a long-running service has different semantics from an invocation-oriented component. CGP should examine whether its SDK needs to distinguish:
- modules invoked by the host;
- reusable capability implementations;
- persistent background services.

This is a question for future design, not a recommendation to add three new module types now. CGP's service Slot should not be assumed to have the same directionality or concurrency model as a wasmCloud service component.

### Medium priority: package and runtime tooling are separate deliverables

wash illustrates how scaffolding, building, local hot reload, artifact publishing, and runtime hosting fit around the runtime. CGP's M4 should plan the public SDK and independent package format, and should separately plan the tools that make those packages practical to author and distribute.

### Medium priority: write an explicit threat model

CGP already has useful truthful trust disclosures about in-process JavaScript and isolated Wasm. As it grows, document:
- actors and which ones are trusted;
- execution and composition boundaries;
- exact enforced resource budgets;
- which backends cannot enforce particular limits;
- artifact provenance and validation;
- cross-composition identity and shared services;
- browser-specific constraints versus Node/server constraints.

## 9. What CGP should not copy

- **Do not adopt the v1 NATS capability-provider data path** as a default for local CGP module calls. That is not the current wasmCloud v2 architecture and would add distributed-system complexity where an in-process/worker boundary is sufficient.
- **Do not import Kubernetes workload scheduling** merely because wasmCloud uses it. CGP's current objective does not require a cluster control plane.
- **Do not equate native host plugins with isolated modules.** They share the host's trust boundary.
- **Do not equate a wasmCloud service component with a CGP service Slot.** Their state, invocation direction, and concurrency semantics differ.
- **Do not treat WIT as a complete composition model.** It can specify interface compatibility without replacing CGP's nested Slot graph and runtime policy.
- **Do not assume a sandbox settles security.** Identity, authorization, resources, side-channel concerns, plugin trust, and artifact trust remain.

## 10. Follow-up questions

1. Can the WebAssembly Component Model and WIT be used consistently in both Node and browser runtimes needed by CGP, with the necessary async/resource support?
2. What would a WIT-backed CGP service Slot look like while preserving nested Slot ownership and composition-local handles?
3. Could the SDK expose a language-neutral contract package while leaving the runtime free to choose a core-module ABI or Component Model adapter?
4. Should reusable host capabilities be composition-scoped by default, with explicit opt-in to shared multi-composition services?
5. What state and concurrency guarantees should a persistent CGP service module have?
6. What additional quotas are needed for CPU/time, worker count, memory, and log output across all supported backends?
7. How should CGP bind artifact digests, module versions, ABI/WIT versions, and save versions into reproducible profiles?

## Conclusion

wasmCloud is a strong reference for the **component-host and capability-boundary** side of CGP. Its most useful contribution is not the old external provider architecture; it is the current v2 separation of typed Wasm components, host-implemented capabilities, workload boundaries, and explicit runtime grants.

For CGP, the strongest next investigation is the WebAssembly Component Model/WIT boundary. That research should compare WIT against CGP's custom JSON ABI and establish whether a typed component ABI can preserve CGP's nested Slots, composition-local handles, browser/Node portability, and deterministic host semantics.

No CGP implementation code was changed as part of this study.
