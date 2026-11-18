# CGP Study 004 — Verified Package Installation and Runtime Activation

**Research date:** 2026-11-16  
**CGP baseline:** [0a0606133923beea57c44e148a8b9999a02ec171](https://github.com/MrWizard94-Compile/Composable-Game-Platform/commit/0a0606133923beea57c44e148a8b9999a02ec171)  
**Related research:** CGP Studies 001–003; O3DE Study 002 — ModuleManager and Native Module Lifecycle; OSGi Studies 001 and 003; ADRs 0003, 0010, 0011, 0012, 0017, 0018, and 0019.  
**Decision status:** Research and proposed design only. This is not an accepted ADR and does not authorize runtime-loading implementation.

## Purpose and decision boundary

CGP now has independent release packages, a content-addressed local store, exact project lockfiles, and a console that can register, verify, and resolve locked package objects. It intentionally does not load those store objects into a live composition.

This study investigates the missing boundary between **verified package content** and **active runtime modules**.

Questions:

- What does install mean when the package bytes are already in a content-addressed store?
- Which layer turns a locked package record into a runtime-readable module package?
- When and how are bytes verified relative to loading?
- How do runtime trust policy and package runtime kind affect activation?
- How does activation use the existing Foundations lifecycle and execution backends?
- What must be retained while a composition is being prepared or running?
- What does failure rollback guarantee?
- How could a future project replacement avoid exposing a mixed or partially initialized generation?
- How should the console report package, activation, and runtime states without conflating them?

This study does not:

- implement an installer, loader, activation manager, lease manager, or runtime update mechanism;
- change the package descriptor, lockfile, manifest, ABI, or Foundations API;
- authorize JavaScript from the store to execute automatically;
- authorize dynamic loading in the browser console;
- introduce hot reload or in-place module replacement;
- choose a new runtime, archive format, database, or trust/signature system.

The primary recommendation is to keep package management outside Foundations and make activation a separate orchestration layer that supplies already-verified packages to the existing composition API.

## Executive findings

1. **Installation, resolution, activation, and execution are distinct states.** A package can be registered and verified without being installed into a project; a project can be locked without its bytes being present; a package can be resolved without being trusted to execute; and a runtime can be prepared without being published as the active project generation.
2. **A lockfile is an identity contract, not an authorization token.** It proves which exact package-tree and artifact identities the project expects. It does not prove publisher identity, approve JavaScript execution, or grant runtime capabilities.
3. **Do not add package-store paths or filesystem operations to Foundations.** A Node-side package manager should turn a verified lock into a validated set of runtime inputs, then call the existing Foundations entry point.
4. **Revalidate at the activation boundary.** Resolution-time verification can become stale before loading. The activation pipeline must verify the bytes it actually consumes, or consume an immutable verified snapshot whose lifetime is protected against mutation and collection.
5. **Do not silently trust JavaScript because it is in the local store.** JavaScript ESM remains trusted in-process code with filesystem, network, and OS access. A separate explicit trust decision is required before import. A manifest permission list is not a sandbox.
6. **Wasm is the safer first activation target, not a reason to weaken policy.** The existing Wasm isolate and import allow-list should be reused. All binary, memory, table, ABI, hook, and aggregate budget checks remain mandatory before guest execution.
7. **Acquire package retention before activation work begins.** A composition lease must protect every exact package object from the moment it is selected for activation until the composition has shut down and its runtime workers have terminated. Lease acquisition must be coordinated with garbage collection.
8. **Activation should be transactional at the composition-generation boundary.** Prepare and initialize the complete candidate composition before exposing it. If any package, backend, registration, or initialization step fails, release the candidate and keep the previous published generation untouched.
9. **Do not hot-swap individual modules.** If replacement is introduced, build a separate complete composition generation and publish it as one unit. Existing OSGi refresh research shows why old revisions and dependent wiring cannot be retired merely because a new version exists.
10. **Keep the first activation milestone narrow.** Start with an explicit, one-shot activation of a project lock into a new composition, with explicit trust policy and complete shutdown. Defer automatic updates, in-place replacement, remote acquisition, dependency solving, and background activation.
11. **Browser activation is a separate transport problem.** The browser cannot consume arbitrary Node filesystem paths. A future browser path must transfer bounded, verified bytes through a controlled same-origin API and preserve the same package identity and runtime policy checks. It must not pretend a local path is a browser module URL.
12. **No architecture decision is accepted by this study.** A later ADR should settle activation input contracts, trust policy, lease ownership, and publication semantics before implementation.

## 1. Current CGP baseline

### 1.1 What exists

At baseline commit `0a0606133923beea57c44e148a8b9999a02ec171`:

- Release package v1 describes one runtime artifact per package: Wasm Core or JavaScript ESM.
- Package validation checks the closed descriptor, manifest, portable file paths, artifact digest, package-tree digest, and runtime-specific static constraints.
- The local store registers immutable package-tree objects and catalog coordinates.
- Project lock `cgp.project-lock/1` records exact module IDs, versions, package-tree identities, artifact digests, runtime kinds, and file lists.
- Lock resolution compares the current profile, lock record, catalog entry, and actual stored object bytes before returning exact package paths.
- The console exposes package registration, store verification, lock creation/update, and exact lock resolution.
- Foundations accepts caller-supplied module packages and owns validation, dependency/Slot resolution, execution policy, initialization, dispatch, save coordination, and shutdown.
- The existing Wasm backend owns workers and enforces the isolate boundary. JavaScript remains trusted in-process code.

### 1.2 What does not exist

There is no implemented operation that:

- takes a resolved project lock and obtains a protected set of package objects;
- turns each package directory into a runtime package without weakening validation;
- makes an explicit per-project/per-session decision to trust JavaScript;
- holds store objects against garbage collection during preparation and execution;
- owns both the package lease and runtime session through shutdown;
- publishes an activated composition as the current project runtime;
- atomically replaces an active project generation.

The Composition view still exercises bundled proof modules. It must not be described as loading the local store.

### 1.3 Existing lifecycle is the execution contract

ADR 0003 defines the lifecycle:

`discover → validate → resolve → prepare → register → initialize → run`, followed by shutdown.

The host has deliberate rollback behavior: if registration fails, every module whose registration was entered is shut down in reverse entry order; if initialization fails, every module whose initialization was entered is shut down in reverse entry order. A module that has not entered the relevant phase is not shut down. Contributions are discarded.

Activation should not create a parallel lifecycle implementation. It should prepare trustworthy package inputs and delegate composition lifecycle to Foundations.

## 2. Vocabulary: do not collapse these operations

| Term | Meaning | Durable effect |
|---|---|---|
| Acquire | Obtain exact package bytes from a local store or approved source | May create a local content object |
| Register | Add a validated release coordinate to a catalog | Catalog metadata changes |
| Verify | Check bytes against the expected package identity | No identity change |
| Lock | Record exact project package identities | Project lock changes only on explicit update |
| Resolve | Match the lock to catalog entries and verified local objects | Produces an exact package set |
| Install | Make the locked package set available to a project under a retention policy | Project retention metadata changes |
| Activate | Prepare and initialize a runtime composition from the locked package set | Creates a runtime generation |
| Publish | Make a successfully prepared generation available to callers | Changes active-generation pointer |
| Deactivate | Stop accepting new work and shut down one generation | Runtime resources are released |
| Uninstall | Remove project retention references, subject to active leases and other pins | May make objects eligible for future GC |

The word “install” is overloaded across ecosystems. CGP should define it precisely. With a content-addressed store, installation need not copy every package into a project-specific folder. A project retention pin can preserve the exact digests while the shared store remains the single byte owner.

A project lock and a project retention pin are also different: the lock says what the project expects; the pin says the local store must retain those bytes.

## 3. Proposed layer boundaries

A conceptual flow:

```text
Project profile + lock
        |
        v
Package Manager / Activation Orchestrator
        |
        +--> Exact lock resolver
        +--> Store lease / project retention manager
        +--> Package byte verifier
        +--> Runtime policy / trust decision
        +--> Package-to-runtime adapter
        |
        v
Foundations compose(ModulePackage[], policy, backend)
        |
        v
Composition generation
        |
        v
Explicit publish / dispatch / save / shutdown
```

### 3.1 Package manager

Responsibilities:

- read the selected project profile and lock;
- resolve exact identities against the local catalog;
- obtain the package set in profile order;
- acquire the appropriate store lease before a package can be collected;
- verify package bytes at the activation boundary;
- enforce runtime-specific policy before any import or instantiation;
- construct runtime inputs for Foundations;
- own the package lease for the full lifetime of the composition;
- release resources in a deterministic order after shutdown.

It should not own Slot semantics, dependency graph rules, module initialization order, save mutation lanes, or guest lifecycle internals. Those remain Foundations/backend responsibilities.

### 3.2 Foundations

Foundations should continue to receive already-prepared package inputs. It should not know:

- content-store directory layout;
- catalog JSON or database schema;
- project lockfile paths;
- staging directories;
- package download or archive extraction;
- project retention pins;
- garbage-collection metadata.

The package manager may call Foundations validators, but it must not duplicate or fork their rules.

### 3.3 Runtime adapters

A runtime adapter converts a validated package into the exact in-memory or backend-specific representation Foundations expects.

The adapter must preserve the immutable package identity alongside the runtime input. A path alone is insufficient identity.

Runtime adapters should be separate for JavaScript ESM and Wasm Core. A generic “load any package” function risks accidentally applying the weaker JavaScript trust model to Wasm or vice versa.

## 4. Proposed activation sequence

The following is a candidate sequence, not an accepted protocol.

1. **Read project inputs.** Parse the profile and lock using the existing strict validators. Reject unknown fields, duplicate IDs, profile mismatch, reordered pins, and stale identities.
2. **Resolve exact package set.** Resolve every locked coordinate. Do not solve ranges, select alternate versions, or fall back to bundled packages.
3. **Acquire composition lease.** Atomically retain all package-tree digests before the activation pipeline can yield control or perform expensive validation. If any lease cannot be acquired, abort without starting runtime work.
4. **Verify consumed bytes.** Recompute package-tree and artifact identities from the exact bytes that will be loaded. Refuse symlinks, special files, changed files, missing files, and identity mismatch.
5. **Apply trust policy.** Determine which runtimes are allowed for this activation. A valid package is not automatically an authorized package.
6. **Build runtime inputs.** Parse and validate manifests and descriptors. Construct Wasm byte inputs or an explicitly trusted JavaScript loader input. Do not execute code during this stage unless the caller has passed the required trust gate.
7. **Compose candidate generation.** Pass the full package set to the existing Foundations composition entry point. Preserve profile order and deterministic resolution.
8. **Prepare and initialize.** Let Foundations execute its documented lifecycle and rollback rules. Any failure prevents publication.
9. **Publish generation.** Only after composition succeeds, make it visible to callers through one host-owned generation reference.
10. **Run under one generation.** Dispatch, service calls, simulation steps, save capture, and restore must be associated with one composition generation. A call must not cross generations midway.
11. **Deactivate.** Stop admitting new work, quiesce or drain operations according to the existing Foundations contract, call shutdown once, await backend release, and only then release the package lease.

A failure before step 9 must not publish a partially initialized generation. If a prior generation exists, it remains the published generation.

## 5. Runtime trust and execution policy

### 5.1 JavaScript ESM

JavaScript ESM is trusted in-process code under the current design. It can use the host process's filesystem, network, and operating-system access. A manifest capability declaration cannot revoke those privileges.

Therefore:

- local registration is not consent to execute;
- successful hash verification is not consent to execute;
- a project lock is not consent to execute;
- an explicit trust policy must be supplied by the caller or project owner;
- policy must identify the exact package identity, not merely a module ID or version string;
- the UI must make the trusted-in-process consequence visible before activation;
- a policy requesting limits the in-process backend cannot enforce must be refused.

A future signing/provenance system could provide evidence about origin, but signatures alone should not automatically grant execution permission. Origin authenticity and runtime authorization are separate decisions.

### 5.2 WebAssembly Core

Wasm packages should use the existing isolate backend and preserve its enforced import allow-list, guest memory/table validation, per-hook time limits, aggregate budgets, and worker ownership.

The package manager must not instantiate Wasm directly as a shortcut around the backend. It should provide verified bytes to the backend that already enforces the runtime contract.

### 5.3 Mixed projects

A project may contain both Wasm and JavaScript packages. This does not make the whole project sandboxed.

A cross-backend composition can route Wasm hooks through the isolate and JavaScript hooks through the trusted backend, but JavaScript still has the trusted backend's grants. The activation report should show the runtime and trust mode per package and should not display a project-wide “sandboxed” status when any module runs in-process.

### 5.4 Policy identity

A future activation record should identify at least:

- project profile digest;
- lockfile identity or digest;
- exact ordered package identities;
- runtime backend selection;
- effective policy identity/version;
- trust decision for every JavaScript package;
- relevant backend budget values;
- CGP/Foundations compatibility version.

This record is diagnostic and reproducibility metadata. It is not a replacement for the lockfile.

## 6. Store leases, integrity, and time-of-check/time-of-use

### 6.1 Lease lifetime

Study 003 proposed composition leases that protect package content from resolution through shutdown. Activation makes that lease essential.

Acquire the lease before package bytes are handed to an adapter. Keep it until:

- new dispatch has been stopped;
- in-flight work has reached the documented quiescent point;
- Foundations shutdown has completed;
- every Wasm worker has terminated;
- runtime adapter resources have been released.

If shutdown reports errors but the backend still has resources in flight, the package lease must not be released early. The lease owner must be able to distinguish “shutdown requested” from “runtime resources actually released.”

### 6.2 Lease versus project retention

A project retention pin keeps locked content available while a project is installed. A composition lease protects the exact content used by one live generation. They have different owners and lifetimes.

Removing a project pin while a generation is active must not allow GC to delete its objects. The active generation's lease remains authoritative until deactivation completes.

### 6.3 Garbage collection race

The critical race is:

1. activation resolves an object;
2. GC decides the object is unreferenced;
3. GC deletes the object;
4. activation tries to load it.

The design must make lease acquisition and GC's transition to deleting mutually exclusive. Checking a lease file before or after resolution without a shared synchronization protocol is insufficient.

A safe state machine should refuse a new lease once an object has entered a deletion claim. GC must recheck roots and leases while holding the same coordination mechanism before moving an object to a tombstone/deleting state.

### 6.4 TOCTOU and immutable files

Read-only permissions and content-addressed names reduce accidental mutation but are not a security boundary against a process with the same user privileges.

A verify-then-import sequence can still race with a writer that changes files after verification. Candidate mitigations include:

- opening and reading exact bytes once, then passing those bytes to the runtime adapter;
- using a private, verified, immutable activation snapshot;
- using file-descriptor-based loading where the runtime supports it;
- rechecking identity immediately before runtime consumption.

The correct choice depends on runtime support. Node ESM import, browser module loading, and Wasm byte instantiation have different input constraints. Do not claim TOCTOU closure without testing the actual loader path.

## 7. Transactional activation and generation publication

### 7.1 Candidate generation

Treat a complete composition as one generation:

- generation ID;
- profile and lock identity;
- ordered package identities;
- effective runtime policy;
- Foundations composition/session;
- package lease;
- activation diagnostics and state.

The generation is not active merely because the package set resolved. It becomes active only after every required lifecycle phase succeeds.

### 7.2 Publication

For a future application host that supports replacement, use a host-owned active-generation reference. Candidate preparation occurs away from that reference. Publication is one synchronous authority-controlled transition after successful initialization.

The old generation remains active during candidate preparation. If preparation fails, discard the candidate and keep the old generation.

This requires care: two generations may temporarily consume resources simultaneously. Aggregate host ceilings, per-composition budgets, and package leases must account for both. If there is insufficient capacity to prepare a second generation, the operation should refuse or require a separately specified stop-first mode. It must not silently exceed limits.

### 7.3 Draining and retirement

After publication, the previous generation must stop accepting new calls. Existing calls and save/simulation operations must follow a defined drain policy. Only after no caller can use its handles and its backend has released workers can the old generation shut down and release its package lease.

The first activation milestone need not implement replacement. It can activate one generation and require explicit shutdown before another. The generation model should nevertheless avoid designing in-place replacement accidentally.

### 7.4 Why not hot-reload individual modules

OSGi Study 003 documents revision coexistence, removal-pending wiring, and refresh of dependent closures. CGP has different semantics, but the transferable lesson is that provider replacement affects consumers, handles, and lifecycle state—not just a file path.

CGP should not add individual module hot reload until it can define:

- affected consumer closure;
- in-flight call behavior;
- stale handle behavior;
- save and state migration semantics;
- deterministic simulation step boundaries;
- rollback when the new provider fails;
- atomic publication and retirement.

A complete new composition generation is easier to reason about than mutating a live graph.

## 8. Browser console implications

The current console's loopback API can inspect and resolve packages, but the browser does not own the Node filesystem.

A browser activation path would need a deliberate transport design:

- Node verifies the exact object and reads the selected files;
- the API returns bounded bytes or a bounded package payload, never an arbitrary filesystem path;
- the browser verifies the received bytes against the lock's expected identity;
- runtime adapters consume bytes using supported browser mechanisms;
- Wasm continues through the existing worker isolate;
- JavaScript ESM remains subject to the explicit trusted-code policy and browser-origin/CSP constraints.

Blob URLs, dynamic imports, relative imports, source maps, and module dependency semantics need specific tests before claiming JavaScript ESM packages can be activated in-browser. The current v1 “one executable artifact” rule reduces complexity but does not by itself prove every browser loading strategy is safe or portable.

A Node-only activation command/API is a reasonable first experiment because the local store and package tooling already run in Node. Browser activation should be a separate milestone rather than an assumed consequence of adding a button to the console.

## 9. Failure matrix and required behavior

| Failure point | Required result |
|---|---|
| Profile or lock malformed | Refuse before lease acquisition or runtime work |
| Lock does not match profile | Refuse; do not select alternate packages |
| Catalog entry missing or changed | Refuse; report exact coordinate |
| Object missing or corrupt | Refuse; no runtime code executes |
| Lease acquisition races with GC | One side wins under shared coordination; loser fails safely |
| Package bytes change during preparation | Refuse before execution; quarantine/report if appropriate |
| JavaScript package lacks explicit trust | Do not import it |
| Runtime policy asks backend for unsupported limits | Refuse before hooks execute |
| Wasm import/memory/table validation fails | Refuse before guest execution |
| One module registration fails | Foundations rolls back entered registrations in reverse order |
| One module initialization fails | Foundations rolls back entered initializations in reverse order |
| Candidate composition fails | Do not publish candidate; release its runtime and package resources |
| Publication precondition fails | Keep previous generation active |
| Shutdown throws | Continue cleanup according to backend contract; do not release package lease before backend resources are actually gone |
| Process crashes while a lease is held | Recovery identifies stale owner/lease; never infer safety from TTL alone |
| Disk full during persistent metadata update | Do not publish a partial install/activation record |
| Browser transport truncates or alters bytes | Digest mismatch; refuse execution |

Diagnostics should identify the phase and exact package identity without dumping untrusted package content into logs.

## 10. Recommended staged implementation plan

These are proposed slices, not authorization to implement them.

### Slice A — Activation contract and tests

- Define an activation input that references a validated lock and explicit runtime policy.
- Define activation result and phase-specific diagnostics.
- Define package lease ownership and shutdown ordering.
- Add test doubles for package adapters and runtime backends.
- Prove no package hook executes before identity and policy gates pass.

### Slice B — Wasm-only activation prototype

- Build an adapter from a verified v1 Wasm package to the existing Wasm package input.
- Activate one exact locked package set through the existing Foundations API.
- Test Node isolate first; then test browser transport separately.
- Exercise malformed bytes, altered artifacts, disallowed imports, resource budgets, init failure, and cleanup.

### Slice C — Project retention and composition leases

- Implement explicit project pins and active composition leases in the package layer.
- Serialize lease acquisition against GC claims.
- Add crash-recovery and multi-process contention tests.
- Keep destructive GC disabled until lease invariants are proven.

### Slice D — Explicit JavaScript trust path

- Define a user-controlled trust record tied to exact package identity.
- Require explicit trusted-in-process opt-in.
- Verify import path and package bytes at the actual loader boundary.
- Document that in-process JavaScript can access host process resources.
- Test that untrusted or unapproved JS is never imported.

### Slice E — Generation host and publication

- Introduce a host-owned generation object.
- Publish only fully initialized compositions.
- Keep one active generation initially; require explicit shutdown before replacement.
- Add two-generation replacement only after capacity, draining, stale handles, save lanes, and simulation boundaries have tests.

### Slice F — Console integration

- Show resolved, installed/retained, activation-ready, active, stopping, and failed states distinctly.
- Require an explicit Activate action and display trust consequences.
- Keep package verification and runtime execution as separate actions.
- Do not use a generic green “verified” label to imply that code is safe or active.

## 11. Conformance tests

| Test | Required property |
|---|---|
| Lock resolves but package object is missing | Activation refuses before runtime hooks |
| Lock resolves to two packages and second fails verification | Neither package executes |
| GC attempts to delete during lease acquisition | Lease and GC claim are serialized |
| Activation fails after lease acquisition | Lease is released exactly once after runtime cleanup |
| JS package is present and hash-valid but not trusted | No ESM import occurs |
| JS package is explicitly trusted | Import occurs only after exact identity and policy checks |
| Wasm package contains unauthorized import | Guest never starts |
| Wasm worker is still loading when activation fails | Release waits for worker termination before lease release |
| Module registration fails | Existing Foundations rollback semantics are observed |
| Module initialization fails | Candidate is not published |
| Candidate succeeds | One complete generation is published |
| Candidate fails while old generation is active | Old generation remains callable |
| Two generations temporarily coexist | Host resource ceilings account for both |
| Old generation has an in-flight call | Its package lease remains held until safe retirement |
| Lock order changes | Profile digest mismatch refuses activation |
| Package bytes change after an earlier verification | Activation-boundary verification detects the change |
| Browser payload is truncated or oversized | Browser refuses before instantiation |
| Browser receives a valid Wasm payload | Existing isolate policy remains in force |
| Process crashes with an active lease | Recovery does not prematurely collect live content |

## 12. Open questions

- Should the first activation prototype be Node-only, or should Wasm browser activation be proven at the same time?
- Does “install” mean only a durable project retention pin, or should CGP also materialize a project-specific deployment snapshot?
- Should project retention pins be explicit lockfile-adjacent files, catalog records, or a separate project state document?
- What is the smallest trustworthy lease protocol that works across multiple local processes and crash recovery?
- Should the activation manager own a single active generation, or should callers own multiple independent compositions?
- What exact operation lane is required to prevent publication from racing with save, restore, or deterministic simulation steps?
- Should JavaScript trust be a local user decision, a project policy, an external allowlist, or a combination?
- What evidence, if any, should signatures/provenance provide to that trust decision?
- Can Node ESM loading consume verified bytes without reopening a mutable path, or does the first implementation need a private snapshot?
- How should activation diagnostics represent a partially cleaned-up backend after a shutdown failure?
- When should GC be introduced, and what proof is required before enabling destructive collection?
- Does CGP need generation replacement at all for its intended use, or is explicit stop-then-start sufficient?

## Conclusion

CGP has completed the important identity and resolution groundwork, but exact package bytes are not yet runtime inputs. The next architecture boundary is not “make the console load files”; it is a package-management and activation orchestrator that preserves immutable identity, explicit trust, store lifetime, existing Foundations lifecycle, and deterministic publication.

The safest first experiment is a one-shot activation of a locked Wasm-only project through the existing isolate backend, with an explicit composition lease and no hot replacement. JavaScript activation requires a separate trusted-in-process authorization path. Browser activation requires a separate bounded-byte transport design.

**No CGP implementation code or accepted ADR was changed as part of this study.**
