# CGP Study 005 — Wasm Activation Snapshot Contract

**Research date:** 2026-11-16  
**CGP baseline:** [29a3d3b4d80f60bce4934c13d20dfc2badcf6910](https://github.com/MrWizard94-Compile/Composable-Game-Platform/commit/29a3d3b4d80f60bce4934c13d20dfc2badcf6910)  
**Related research:** CGP Studies 001–004; O3DE Study 002; OSGi Studies 001 and 003; ADRs 0003, 0017, 0018, and 0019.  
**Decision status:** Proposed activation input contract and test plan only. No accepted ADR or runtime implementation is changed by this study.

## Purpose and decision boundary

Study 004 identified verified package activation as the next boundary and recommended a one-shot Wasm-only first milestone. This study narrows that proposal against the actual CGP implementation.

The central question is:

> Once a locked package has been verified, what exact data must cross into Foundations, and how long must the local package object remain protected?

The answer must preserve the existing Foundations lifecycle and Wasm isolate. It must not add store paths, package discovery, archive handling, or garbage collection to Foundations.

This study does not implement activation, change the package descriptor or lock schema, authorize JavaScript execution, add browser loading, add hot replacement, or select a persistent lease database.

## Executive findings

1. **Foundations already accepts the correct Wasm input shape.** A module package supplies its validated manifest and an implementation containing Wasm bytes as a \`Uint8Array\`. The isolate backend owns worker creation, guest validation, instantiation, calls, and termination.
2. **The current store resolver returns paths, not runtime inputs.** \`resolveProjectLock()\` validates the lock, profile, catalog entry, and stored bytes, then returns object directories. It deliberately does not construct module implementations or execute code.
3. **The current Wasm path consumes bytes, not package paths.** The isolate posts the Wasm \`Uint8Array\` to its worker. Node worker messaging clones an \`ArrayBuffer\` not listed in a transfer list; the receiving guest runtime constructs a \`WebAssembly.Module\` and instance from the received bytes. The worker does not reopen the content-store directory.
4. **That changes the lease question.** A Wasm-only activation does not inherently need a package-store lease for the entire runtime lifetime once a complete, verified in-memory snapshot has been produced. A temporary read/activation pin may still be useful to prevent garbage collection from interrupting the snapshot operation. It is not the same thing as a long-lived runtime lease.
5. **Verify and snapshot the entire project before calling \`compose()\`.** If packages are verified one at a time and passed directly into composition, the first module could run its registration hook before a later package fails verification. The orchestrator must finish validating every exact locked package and own all required bytes before any module hook can run.
6. **Hash the bytes that will actually be consumed.** A path, directory name, earlier verification result, or read-only permission is not sufficient. Package-tree and artifact identities must be recomputed from the exact scanned bytes used to build the runtime input.
7. **Preserve the current runtime trust split.** The first activation contract admits Wasm Core packages only, through the existing isolate. JavaScript ESM remains a separate, explicit trusted-in-process path and is rejected by the Wasm-only operation.
8. **No active-generation manager is required for the first slice.** Return one composition result with explicit shutdown. Publication, replacement, draining, and hot reload remain separate future work.

## 1. Evidence from the current implementation

### 1.1 Package resolution

The current \`src/packages/project-lock.ts\` implements:

- strict validation of the closed \`cgp.project-lock/1\` document;
- profile identity checks using the ordered exact module pins;
- catalog-coordinate and release-identity comparison;
- verification of actual stored package content;
- return of the package-tree entry and its object directory.

Its result is intentionally a set of verified package paths. It is not an executable package set.

### 1.2 Package validation

The current \`src/packages/package-directory.ts\` scanner:

- enumerates package files in ordinal path order;
- uses \`lstat\` and refuses symbolic links and special files;
- reads file bytes and checks file identity, size, and modification time before and after each read;
- validates the strict manifest and package descriptor;
- performs static Wasm or JavaScript checks;
- computes the artifact and package-tree identities.

The scanner already holds the bytes used for validation internally, but the public validation result returns a summary rather than those bytes. An activation adapter that validates a directory and then separately reads \`module.wasm\` would perform a second read and reintroduce a verify-then-use gap.

The first activation implementation should refactor the package-directory validation path so the exact scanned byte set can produce both the validation summary and a bounded runtime snapshot. It should not call the validator and then reopen the artifact by path.

### 1.3 Foundations input and lifecycle

The existing public Foundations contract is sufficient for a first Wasm activation prototype:

- \`ModulePackage\` contains \`manifest\` and optional \`implementation\`;
- \`ModuleImplementation.wasm\` is a \`Uint8Array\`;
- \`compose(packages, options)\` applies the execution backend and policy;
- the host owns discover, validate, resolve, prepare, register, initialize, run, and shutdown;
- the Wasm backend owns its composition session and worker resources;
- \`CompositionResult\` exposes \`ok\`, \`runtimeActive\`, diagnostics, phases, and \`shutdown()\`.

The package layer should create this input and delegate. It should not implement a second lifecycle or invoke guest hooks itself.

### 1.4 Byte ownership in the current isolate

The observed path is:

1. \`wasm-isolate.ts\` obtains the Wasm bytes from \`implementation.wasm\`.
2. It sends a \`load\` message containing those bytes through the worker's \`postMessage\` call without a transfer list.
3. \`wasm-worker.mjs\` passes the message to \`createGuestRuntime()\`.
4. \`wasm-guest-runtime.mjs\` reads \`record.wasm\`, constructs a \`WebAssembly.Module\`, constructs a \`WebAssembly.Instance\`, stores the resulting instance and memory in the worker, then replies \`loaded\`.
5. Later hooks use that worker-owned instance and memory. They do not need the original package directory.

Node's Worker documentation states that an \`ArrayBuffer\` omitted from the transfer list is copied, and that the message is cloned immediately. See [Node.js v22 Worker threads — Considerations when transferring TypedArrays and Buffers](https://nodejs.org/download/release/latest-v22.x/docs/api/worker_threads.html#considerations-when-transferring-typedarrays-and-buffers).

This confirms that the Node backend does not lazily import the package path after activation. It does not, by itself, prove that a future backend or adapter will never retain a path. The contract must prohibit such a dependency in the Wasm-only path and test it.

## 2. Separate retention from runtime ownership

The word “lease” currently covers several different problems. Keep them distinct.

| Mechanism | Purpose | Required lifetime |
|---|---|---|
| Project retention pin | Keep a project's locked package objects available across sessions | Until the project explicitly removes or changes that retention |
| Snapshot read pin | Prevent future GC from claiming an object while an activation snapshot is being read | From before the first package read until the complete snapshot is materialized or abandoned |
| In-memory snapshot | Own the verified manifest and executable bytes independently of the store path | Until the runtime input has been handed to Foundations and no longer needs the snapshot |
| Wasm runtime session | Own workers, instances, memories, and guest resource accounting | Until Foundations shutdown completes and the isolate has released its workers |

### 2.1 Proposed Wasm lease boundary

For a Wasm-only path:

- Acquire a read pin before reading package content if a GC implementation exists and can delete objects concurrently.
- Verify the lock/profile/catalog relationship and scan every locked package.
- Compute package-tree and artifact digests from the exact bytes captured by the scan.
- Retain the manifest and executable bytes needed for the runtime input.
- Do not expose any runtime input until every package in the lock has passed validation.
- Release the snapshot read pin only after the complete snapshot owns the required bytes.
- Pass those bytes to Foundations. The runtime session then owns the instantiated guests and is responsible for their cleanup.

The store does not need to remain pinned for the entire life of a Wasm composition if the runtime has no file-backed dependency after snapshot creation. That conclusion is specific to the current byte-fed Wasm backend.

### 2.2 What a read pin does not guarantee

A read pin is a coordination mechanism for availability during snapshotting, not an execution authorization and not a cryptographic integrity check.

The package-tree digest still decides whether the bytes match the lock. A read pin does not make mutable data immutable, authenticate a publisher, or prove code is safe.

The current store has an exclusive writer lock for registration, but it has no reader leases or garbage collector. Do not pretend a reader pin already exists. When GC is designed, its deletion claim must coordinate with snapshot readers. If a deletion wins before snapshot acquisition, activation must fail cleanly. If a read pin wins, GC must not claim those objects until the pin is released.

Without GC, the prototype can test snapshot integrity and failure under missing or changing files. A production guarantee against concurrent destructive store operations requires an explicit store-wide coordination contract.

### 2.3 Why JavaScript is different

JavaScript ESM activation is excluded from this contract. Node ESM loading is not the same byte-input path as Wasm: it may resolve and read module files, and its execution is trusted in-process code.

A future JavaScript path must define an immutable, private runtime snapshot or another verified loader boundary, explicitly authorize the exact package identity for trusted-in-process execution, and demonstrate that the loader cannot silently reopen mutable content-store paths. It must not inherit the shorter Wasm read-pin lifetime by assumption.

## 3. Proposed first activation contract

This is a proposed package-layer operation. It is not a new Foundations API.

### 3.1 Inputs

The operation should require:

- the configured local store root;
- the project's validated profile;
- the exact \`cgp.project-lock/1\` document;
- an explicit Wasm execution policy and a configured Wasm backend;
- a project/profile name for diagnostics.

It should not accept a package ID/version request that causes the resolver to select an alternative. The lock is the source of exact identities.

### 3.2 Runtime admission

The first operation accepts only packages whose locked runtime kind is \`wasm-core\`.

It must reject:

- any \`javascript-esm\` package;
- mixed-runtime projects;
- unknown runtime kinds;
- invalid or unsupported Wasm policy;
- requested limits or capabilities the selected backend cannot enforce.

No silent fallback to bundled modules or in-process JavaScript is permitted.

### 3.3 Snapshot shape

The package layer should produce an internal, short-lived structure equivalent to:

| Field | Meaning |
|---|---|
| \`moduleId\`, \`version\` | Exact locked release coordinate |
| \`packageTreeDigest\` | Verified \`cgp.package-tree/1\` identity |
| \`artifactDigest\` | Verified executable digest |
| \`manifest\` | Strictly parsed and validated runtime manifest |
| \`wasmBytes\` | The exact Wasm bytes whose artifact digest was checked |
| \`fileList\` | Validated canonical package file list for diagnostics |

The structure must not expose mutable store paths as runtime inputs. It should remain private to the activation adapter. The adapter must copy bytes into owned arrays where needed rather than share an array that another caller can mutate after validation.

The implementation must preserve package profile order when creating the \`ModulePackage[]\` passed to \`compose()\`.

### 3.4 Snapshot resource limits

Package format v1 bounds one package, but a project may contain multiple packages. The existing guest binary and memory budgets do not bound every byte temporarily read to verify package trees.

The activation contract therefore needs a separate aggregate snapshot limit, distinct from:

- per-package file and total package limits;
- the Wasm binary size limit;
- guest linear-memory limits;
- worker heap limits;
- aggregate guest resource budgets.

The exact default aggregate value should be selected from measured package and host behavior, not guessed in this study. Exceeding it must refuse activation before any module hook runs.

### 3.5 Composition handoff

Only after the full project snapshot succeeds should the adapter construct the ordered \`ModulePackage[]\` and call the existing \`compose()\`.

The adapter supplies the configured Wasm backend and explicit policy. It does not instantiate Wasm directly, call guest exports, or reproduce Foundations' lifecycle.

A successful activation result requires both \`ok === true\` and \`runtimeActive === true\`. The caller receives the composition result and must eventually call and await its \`shutdown()\`.

This first slice does not publish a global active-generation pointer, replace an existing composition, or provide hot reload. It creates one composition instance under the caller's ownership.

## 4. Activation state model

The first operation should expose explicit phases rather than a single generic “installed” or “active” flag.

| Phase | Meaning | Module code may run? |
|---|---|---|
| Validate request | Validate profile, lock schema, and selected policy | No |
| Resolve identity | Match exact lock entries with catalog records | No |
| Snapshot packages | Read exact package content and verify all identities | No |
| Admit runtime | Confirm Wasm-only package set and backend policy | No |
| Compose | Call Foundations lifecycle with the complete in-memory package set | Yes |
| Active | Foundations reports a successfully initialized runtime | Yes |
| Stopping | Shutdown has been requested and is pending | No new caller work should be admitted |
| Stopped | Foundations shutdown and backend release have completed | No |

Any failure before Compose means no package hook has executed. A failure during Compose uses the existing Foundations rollback behavior and must not return an active result.

“Verified,” “resolved,” “snapshot ready,” and “active” are distinct states. UI labels must not imply execution safety merely because a package digest matched.

## 5. Failure behavior

| Failure | Required result |
|---|---|
| Invalid profile or lock | Refuse before opening or reading package content |
| Profile digest or order mismatch | Refuse; never reorder or select alternatives |
| Missing catalog coordinate or object | Refuse with the exact module/version |
| Catalog identity differs from lock | Refuse before composition |
| Any package tree or artifact digest mismatch | Discard the entire candidate snapshot; no module hook runs |
| Symlink, special file, path collision, or malformed descriptor | Refuse the complete snapshot |
| Package changes during read | Refuse if scan stability or digest checks fail |
| A package disappears during snapshot | Refuse; do not compose the partial set |
| Aggregate snapshot budget exceeded | Refuse before Compose |
| One package is JavaScript ESM | Refuse the Wasm-only activation request |
| Backend policy requests unsupported grants or limits | Refuse before Compose |
| Wasm guest has unauthorized imports or resource declarations | Existing isolate refuses before guest execution |
| Worker creation or binary loading fails | Existing backend releases the failed guest and refunds its reservation |
| Registration or initialization fails | Existing Foundations rollback applies; no active result is returned |
| Shutdown is called more than once | Preserve the existing idempotent/single-flight shutdown behavior |
| A future GC claims an object during snapshot | Shared coordination decides one winner; a failed snapshot never reaches Compose |
| Store changes after snapshot completion | Already-owned bytes remain the runtime inputs; no later path reopen is permitted |

Error reports should include the activation phase and exact package coordinate, but not dump untrusted package contents.

## 6. Required conformance tests before implementation is considered ready

### Identity and all-or-nothing admission

- A lock/profile mismatch refuses before any package read or hook.
- A lock containing one valid package followed by one corrupt package produces no runtime inputs and invokes no hook.
- Reordered lock entries refuse even when they name the same package set.
- A catalog entry that differs from the lock refuses without fallback.
- A missing object and a symlinked object path both refuse.

### Snapshot integrity and ownership

- The snapshot's Wasm bytes hash to the exact artifact digest in the lock.
- Its complete package-tree digest matches the locked tree identity.
- A file mutation after snapshot creation does not change the bytes passed to \`compose()\`.
- The adapter does not reopen the package path after snapshot creation.
- Mutation of a caller-held source buffer cannot mutate the adapter's private runtime bytes.
- A file changing during scanning either yields the exact locked bytes or causes refusal; it must never yield a different accepted artifact.
- The aggregate snapshot budget is enforced across the entire project, not independently per module.

### Runtime and lifecycle

- A JavaScript package is rejected by the Wasm-only operation before \`compose()\`.
- A Wasm guest with an unauthorized import never reaches its hook.
- A registration failure preserves the existing reverse-order rollback.
- An initialization failure preserves the existing reverse-order rollback.
- A loading failure terminates the affected worker and releases its resource reservation.
- Shutdown waits for in-flight work and worker termination before reporting completion.
- Two independent activations have separate sessions and cannot call one another's ABI handles.

### Store/GC coordination

- Until a GC protocol exists, activation does not claim that concurrent destructive store operations are supported.
- Once a reader pin is implemented, a GC deletion claim and snapshot acquisition are mutually exclusive.
- GC cannot delete a package while the snapshot reader owns its pin.
- A crashed snapshot operation cannot leave a permanent pin without a defined recovery path.
- Releasing a snapshot pin after byte materialization does not invalidate the already-owned runtime snapshot.

## 7. Explicitly out of scope

- JavaScript ESM execution or trust prompts.
- Mixed JavaScript/Wasm projects.
- Browser activation or browser byte transport.
- Remote package sources, downloading, archive import, signatures, or provenance.
- Dependency solving or automatic version selection.
- Project retention pins and destructive garbage collection.
- Global generation publication, replacement, or hot reload.
- Parallel activation or automatic retry.
- Any new lifecycle implementation inside Foundations.

## Conclusion and recommended next action

The first activation milestone should be a Node-side, Wasm-only adapter that turns a validated exact project lock into a complete, verified, in-memory package snapshot and then delegates execution to the existing Foundations and Wasm isolate.

The important refinement is that **runtime ownership and store retention are not the same lifetime**. The store must remain available while the exact bytes are being acquired and verified. Once the runtime input owns those bytes, the current Wasm backend no longer needs the store path. A full-runtime package lease should not be implemented unless a future backend or feature demonstrates a file-backed dependency.

The next implementation slice should first add and test the single-scan verified snapshot contract and its aggregate memory bound. Only after those tests pass should the Wasm-only activation adapter be added. GC coordination remains a prerequisite before claiming protection against concurrent destructive store maintenance.

**No CGP implementation code or accepted ADR was changed as part of this study.**
