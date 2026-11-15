# CGP Study 001 — Independent Module Package, Artifact, and SDK Contract

**Research date:** 2026-11-15  
**CGP baseline:** [7b3a1719e81a8db3388cd27a9cd76376425b4dcc](https://github.com/MrWizard94-Compile/Composable-Game-Platform/commit/7b3a1719e81a8db3388cd27a9cd76376425b4dcc)  
**Related research:** O3DE Study 001 — Gems, Packaging, and Distribution; wasmCloud Studies 001–002; Extism Studies 001–002; CGP Architecture Synthesis 001.  
**Decision status:** Proposed package and authoring contract for review. This is not an accepted ADR and does not authorize implementation or publication.

## Purpose and decision boundary

Define what an independently authored and distributed CGP module should look like, how its runtime contract relates to its compiled artifact, how a consumer obtains and pins it, and what the CGP SDK and tools must provide.

The investigation starts from CGP's current implementation and the packaging lessons from O3DE, wasmCloud, and Extism. It also uses current Node.js, npm, SPDX, and SLSA documentation where those standards affect the proposed workflow.

This study does not:
- publish the current repository to npm;
- change the root package.json or make it public;
- change the accepted module manifest or profile schemas;
- replace cgp.abi/1 with WIT;
- add a public remote registry;
- add install-time code execution;
- implement package signing or claim a complete software supply-chain trust system;
- change any execution backend or weaken the current isolation boundary.

The output is a proposed minimal contract and a sequence of implementation decisions that can later be reviewed as an ADR.

## Executive findings

1. **A module authoring project is not the same thing as a released module package.** Source, tests, build toolchains, development dependencies, and authoring configuration belong to the project. The released package should contain the validated runtime contract and the built artifact needed by the selected backend.
2. **Keep the existing manifest as the runtime module contract.** It describes module identity, version, Foundations API compatibility, capabilities, Slot connections, permissions, save schema, author, and license. Do not overload it with catalog URLs, archive digests, build provenance, or npm metadata.
3. **Add a small package descriptor alongside the runtime manifest.** A versioned cgp-package.json can identify the package format and explicitly select one runtime artifact and its ABI. This avoids relying on filename guessing or runtime source imports.
4. **A release should select one execution artifact in package-format version 1.** The first format should distinguish a core WebAssembly guest using cgp.abi/1 from a compiled JavaScript ESM artifact that is explicitly trusted in-process. Multi-target releases can be designed later.
5. **Ship executable JavaScript, not repository-relative TypeScript source.** A released JavaScript module should have a compiled ESM entrypoint. Its build-time SDK dependency must not resolve into the CGP source repository. Node's TypeScript type stripping is not a substitute for a published build artifact or type checking.
6. **Separate module identity from immutable artifact identity.** moduleId and semantic version identify the logical release; the package digest identifies the exact package bytes. A lock file must pin the digest, not just the version.
7. **Keep profile intent and package lock separate.** The profile selects the intended module IDs and versions. A generated lock records the exact package release and artifact digest resolved from a local or remote catalog. Locked execution refuses drift.
8. **Start with a local catalog.** A directory-backed catalog and a generated JSON index are enough to prove discovery, installation, validation, and reproducibility. A public registry, OCI distribution, or marketplace is not a prerequisite.
9. **Integrity, provenance, publisher identity, and runtime safety are different claims.** A digest checks bytes against a trusted expected digest. Provenance helps establish where and how the artifact was built. A signature can bind a publisher key to a release. None proves that code is benign or safe.
10. **The current release path has important gaps.** The root npm package is marked private; the TypeScript starter imports the Foundations from a relative repository path; the profile pins only module ID/version; the current composition fingerprint does not include artifact bytes; and the package checker for WebAssembly performs a runtime composition test rather than only static inspection.
11. **The package format must preserve the security distinction between JavaScript and WebAssembly.** A JavaScript artifact is trusted in-process code with ambient host privileges. A WebAssembly artifact is subject to the isolated backend's import and resource policy. Packaging does not change those guarantees.
12. **The best first milestone is a reproducible local package workflow, not a public package store.** Build, validate, pack, hash, catalog, lock, verify, and compose one third-party package without importing anything from the CGP repository.

## 1. Evidence boundary and current CGP state

### 1.1 Current runtime manifest

The current closed manifest in src/foundations/manifest.ts includes:

- moduleId, name, description, and exact module version;
- moduleApi, a version range that must admit the Foundations API;
- requires and provides capability declarations;
- connectsTo declarations for Slot contracts;
- exposesSlots and their kind, contract, required state, and service mutability;
- permissions;
- optional save version;
- optional author and license.

Unknown fields are rejected. The manifest is intentionally concerned with module behavior and composition, not package acquisition.

The manifest does not currently declare:
- the executable artifact kind or entrypoint;
- the guest ABI version as a standalone manifest field;
- artifact or package digests;
- source repository and immutable source revision;
- release archive location;
- build provenance;
- target runtime/platform matrix.

These omissions are reasonable for the current local-folder prototype. They become significant once packages are acquired independently.

### 1.2 Current package loading

src/foundations/discover-node.ts scans direct child folders for manifest.json and, when present, reads module.wasm as bytes. It does not import module.ts during discovery. loadInProcessImplementations is a separate explicit operation that imports module.ts.

The current JavaScript starter imports ModuleImplementation as a type from ../../src/foundations/index.ts. That is appropriate inside the source repository but is not an independent package dependency.

The current WebAssembly package uses manifest.json and module.wasm. The checker accepts an externally built package without guest.json and refuses a portable package containing module.ts. guest.json is a build input for the repository's small guest generator, not a universal WebAssembly package standard.

### 1.3 Current profile and fingerprint identity

CompositionProfile currently pins moduleId and exact version. resolveProfile:
- groups available packages by moduleId;
- refuses if no package exists;
- refuses if more than one package with the same moduleId is present;
- validates the manifest;
- refuses if the declared version differs from the profile pin.

It does not compare an artifact digest, because the package model does not currently carry one.

The current fingerprint in src/foundations/host.ts includes backend ID, ordered module IDs and versions, Slot contract/status/contributor structure, dependency edges, and contribution IDs/order. It does not include the contents or digest of a selected implementation artifact.

Consequently, two distinct artifacts that claim the same moduleId and version and produce the same visible composition structure can produce the same fingerprint. The fingerprint is useful for the current composition proof, but it is not yet a content identity or supply-chain lock.

### 1.4 Current authoring and release status

The root package.json has private set to true and exports the Foundations barrel directly from src/foundations/index.ts. npm documentation states that private:true prevents npm publication. That is an intentional safety guard in the current repository, not a reason to simply remove the field.

The current starter is source-first and has no independently published SDK dependency. The WebAssembly starter is artifact-first. These are useful proofs, but they do not yet form one complete authoring and release pipeline.

## 2. Terminology: five separate objects

The package design should use distinct names for distinct responsibilities.

| Object | Meaning | Primary owner |
|---|---|---|
| Authoring project | Source files, tests, compiler configuration, SDK development dependencies, and build instructions | Module author |
| Module runtime manifest | CGP module identity, API compatibility, capabilities, Slots, permissions, save contract, author/license declarations | Module author and Foundations validator |
| Released module package | Runtime manifest, package descriptor, selected executable artifact, and release documentation/license files | Module author and packager |
| Catalog release record | Where a package is found, its immutable digest, source provenance, and release metadata | Catalog/registry publisher |
| Profile and lock | Intended module selection and the exact package bytes resolved for execution | Application owner and lock generator |

These objects may be stored in the same repository or distribution service. Their schemas and authority should remain distinct.

### 2.1 Runtime manifest is not a package catalog

The manifest answers: “What module is this, what does it provide, what does it require, and how may it connect?”

It should not answer:
- where to download its ZIP/TAR archive;
- which Git branch currently contains its source;
- what CI workflow built it;
- which registry mirrors carry it;
- what digest the catalog expects.

Putting mutable distribution URLs into the runtime manifest would couple the runtime contract to one publishing system and make offline package validation harder.

### 2.2 Package artifact is not source code

A source repository can contain TypeScript, Rust, C, C++, WIT, guest.json, build scripts, tests, and generated files. The runtime should consume a specific built artifact, not infer which source file to execute.

This matches the distinction in O3DE between a Gem package and the native module produced from a Code Gem, and the distinction in wasmCloud between a component artifact and its workload/deployment specification.

## 3. Proposed released package format, version 1

### 3.1 Package directory

The recommended first package format is deliberately small:

~~~text
org.example.beacon/
├── manifest.json
├── cgp-package.json
├── module.wasm              # or module.mjs, not both in format v1
├── README.md
└── LICENSE                  # or the declared license text/terms
~~~

Rules:

- manifest.json is the existing CGP runtime manifest.
- cgp-package.json declares the package format and the one runtime artifact.
- The entrypoint is a compiled runtime artifact.
- A release package does not require source code, build scripts, tests, node_modules, or a local guest generator input.
- README.md and license documentation are release documentation, not runtime code.
- A package may be distributed as a directory for local development or as an immutable archive for transfer.
- The release validator must reject ambiguous or unsupported entrypoint declarations.
- A package must not run install scripts, post-install hooks, or arbitrary build commands when acquired.

A package must be self-contained for the execution mode it declares. It must not rely on a file outside its package root or on a path into the CGP Git checkout.

### 3.2 Package descriptor

The proposed cgp-package.json contains a package-format version and one explicit runtime artifact.

WebAssembly example:

~~~json
{
  "formatVersion": 1,
  "runtime": {
    "kind": "wasm-core",
    "entry": "module.wasm",
    "abi": "cgp.abi/1"
  }
}
~~~

Compiled JavaScript ESM example:

~~~json
{
  "formatVersion": 1,
  "runtime": {
    "kind": "javascript-esm",
    "entry": "module.mjs",
    "export": "implementation",
    "executionTrust": "trusted-in-process"
  }
}
~~~

The descriptor should use a closed schema. Unknown fields and unknown runtime kinds should fail validation, rather than being guessed or ignored.

The package descriptor does not repeat moduleId, module version, moduleApi, license, or save version. Those already belong to manifest.json. It does not embed the archive's own digest: the digest belongs in the catalog/lock so it can be computed over the finished package bytes without a self-reference.

### 3.3 One artifact per release in format v1

The first package format should select exactly one runtime artifact:
- wasm-core uses module.wasm and an explicit CGP guest ABI identifier;
- javascript-esm uses module.mjs and a named implementation export, with trusted-in-process execution explicitly declared.

Do not accept both module.wasm and module.mjs as competing entrypoints in the same format-v1 package. The existing cross-backend composition can mix different module packages and backends; it does not require one package to contain multiple implementations.

A later package-format version may introduce multiple target variants if a real deployment requirement justifies:
- target selection rules;
- identical logical behavior across variants;
- per-variant artifact digests;
- per-target compatibility and availability;
- fingerprint and lock semantics;
- a defined fallback/refusal policy when a target is unavailable.

Until those rules exist, one runtime artifact per release avoids ambiguity.

### 3.4 WebAssembly package requirements

The WebAssembly package keeps the current cgp.abi/1 boundary:
- module.wasm is the executable artifact;
- the guest uses the existing ABI exports and JSON calling convention;
- its imports are inspected before instantiation;
- only host-authorized imports are linked;
- the backend's memory, binary, table, time, worker, and aggregate policies remain in force.

guest.json is optional build input for CGP's example generator. It is not required in a release and should not be treated as the source of truth for arbitrary third-party guest binaries. An author using another compiler ships the binary and runtime metadata.

The package validator should not assume that a WebAssembly module is safe merely because it passes structural checks. Runtime execution still occurs through the selected backend and policy.

### 3.5 JavaScript package requirements

The release artifact should be a built ESM JavaScript file, module.mjs, with the named implementation export.

The authoring project may use TypeScript, but the build step must emit executable JavaScript and type declarations separately as appropriate. A release must not import ../../src/foundations/index.ts or any other repository-relative source.

The published JavaScript artifact should:
- use one documented ESM entrypoint;
- bundle its runtime dependencies or otherwise declare and lock them through a future explicit dependency mechanism;
- avoid resolving undeclared application packages from the host's ambient node_modules;
- declare the module's runtime trust classification as trusted-in-process;
- never be presented as sandboxed.

For the initial SDK, ESM-only output is preferable to shipping both ESM and CommonJS. Node's package documentation warns about the dual-package hazard for packages whose two entrypoints can create parallel state. A dual format can be considered if consumer requirements justify the added compatibility surface.

Node's built-in TypeScript type stripping is a useful development convenience, but it does not type-check the code, ignores tsconfig.json, and only supports syntax erasable without code generation. Its history also differs across Node release lines. A built JavaScript artifact is more predictable for independent consumers.

### 3.6 Source project versus release package

A JavaScript authoring project may look like:

~~~text
beacon-project/
├── package.json
├── tsconfig.json
├── manifest.json
├── cgp-package.json          # generated/copied package descriptor
├── src/
│   └── module.ts
├── tests/
│   └── module.test.ts
└── dist/
    └── module.mjs
~~~

The build copies validated runtime metadata and the compiled module.mjs into a clean release directory. The published module package does not need the source tree or development dependency tree.

A WebAssembly authoring project may include Cargo.toml, Rust source, WIT files, guest.json, or other toolchain inputs. The release contains module.wasm and runtime metadata. The package contract must not dictate that every guest is built by CGP's own example compiler.

The source project and the release package may both be version-controlled, but the pack command must select an explicit release allowlist. It must never simply archive the entire Git checkout.

## 4. Identity and versioning

The following identifiers must remain distinct:

| Identifier | What it identifies |
|---|---|
| moduleId | Stable logical identity of a module family |
| module version | Author-declared semantic release of module behavior/contract |
| package format version | Schema/layout version of the distributable envelope |
| Foundations API range | Which host API versions the module supports |
| guest ABI version | Binary call contract for a WebAssembly artifact |
| save version | Module-owned durable data schema |
| package digest | Exact bytes of the complete released package |
| artifact digest | Exact bytes of the selected runtime artifact |
| source revision | Immutable source commit that produced the release |
| composition fingerprint | Resolved composition structure and selected release identities |
| runtime session ID | One live execution session of a composition |

These values should not be substituted for one another.

### 4.1 Immutable release coordinate

The logical coordinate is moduleId plus semantic version. Once a coordinate is published, it must be immutable: the same moduleId and version must not be republished with different package bytes.

A corrected release should receive a new module version. A catalog containing two distinct package digests for the same moduleId/version should report a release immutability conflict, not silently pick one.

The digest still matters even when release immutability is enforced. A lock must verify downloaded bytes because catalogs, mirrors, caches, or local files can be corrupted or substituted.

### 4.2 Compatibility versioning is multi-dimensional

moduleApi is not the module's own version and not the guest ABI version. Likewise, save.version is not the package format version.

The package descriptor makes the runtime artifact kind and ABI explicit. The manifest continues to declare Foundations compatibility. The lock records the actual resolved versions/digests.

If WIT is introduced later, a WIT package version must not silently replace the CGP semantic contract or the module version. It is another independently versioned interface dependency.

## 5. Package digest, catalog record, and lock file

### 5.1 Catalog release record

The local catalog should be a simple JSON index that points to immutable package artifacts.

Illustrative record:

~~~json
{
  "moduleId": "org.example.beacon",
  "version": "1.0.0",
  "packageFormat": 1,
  "package": {
    "uri": "./packages/org.example.beacon-1.0.0.cgp",
    "sha256": "sha256:REPLACE_WITH_REAL_PACKAGE_DIGEST",
    "size": 48231
  },
  "artifact": {
    "kind": "wasm-core",
    "abi": "cgp.abi/1",
    "sha256": "sha256:REPLACE_WITH_REAL_ARTIFACT_DIGEST"
  },
  "source": {
    "repository": "https://example.invalid/org/example-beacon",
    "revision": "FULL_IMMUTABLE_COMMIT"
  },
  "license": "MIT",
  "provenance": null
}
~~~

This is an illustrative schema, not an approved file format. The example digest values are placeholders, not valid release metadata.

Catalog metadata can additionally include:
- display description and tags;
- documentation URL;
- publisher identity or signing-key reference;
- target runtime/platform support;
- release time and release notes;
- provenance and attestation references;
- deprecation or revocation status.

A catalog entry does not become authoritative merely because it is hosted by a repository. The consumer must verify the content digest and apply its configured source/publisher trust policy.

### 5.2 Local catalog first

The first catalog should be a local folder plus a generated index. It should support:
- listing available module IDs and versions;
- inspecting a release and its runtime artifact;
- validating a package;
- adding a local release without changing its bytes;
- detecting a duplicate moduleId/version with different digests.

A remote HTTP registry, npm-based module store, OCI registry, marketplace, account system, or dependency-solving service is not required for this milestone.

A local catalog can later be mirrored by an HTTP service or stored in an OCI-compatible artifact store without changing the runtime manifest or the package coordinate.

### 5.3 Profile intent versus lock

Keep profiles readable and intentional. They select module IDs and exact versions, as they do now.

Add a separate generated lock document for immutable resolution. Illustrative form:

~~~json
{
  "lockFormat": 1,
  "profileId": "org.example.game",
  "profileDigest": "sha256:REPLACE_WITH_PROFILE_DIGEST",
  "foundationsApi": "1.0.0",
  "modules": [
    {
      "moduleId": "org.example.beacon",
      "version": "1.0.0",
      "packageDigest": "sha256:REPLACE_WITH_PACKAGE_DIGEST",
      "artifact": {
        "kind": "wasm-core",
        "abi": "cgp.abi/1",
        "entry": "module.wasm",
        "sha256": "sha256:REPLACE_WITH_ARTIFACT_DIGEST"
      }
    }
  ]
}
~~~

A lock should contain every selected module package required by the profile, not only top-level entries. The moduleId/version in the lock must agree with manifest.json inside the digest-verified package.

A locked operation must:
1. locate the exact package release;
2. verify the package digest before trusting its contents;
3. validate package descriptor and runtime manifest;
4. verify artifact path, kind, ABI, and artifact digest;
5. verify Foundations API/backend compatibility;
6. refuse if any package is missing, altered, ambiguous, or unsupported;
7. pass only verified packages to composition.

The lock must never silently resolve a newer version or substitute a same-version artifact with a different digest.

An explicit update command can regenerate the lock, show the changed module coordinates and digests, and require the application owner to review the diff. Updating a catalog must not rewrite a lock.

### 5.4 Composition fingerprint

When package identity is available, the composition fingerprint should incorporate at least:
- moduleId;
- module version;
- package digest or another stable content identity;
- selected artifact kind and ABI version;
- the current Slot/contract/dependency/contribution information;
- backend identity and any execution-policy values that materially affect the resolved runtime configuration.

This needs careful design because policy may be partially supplied at runtime and backend IDs may not fully identify backend configuration. A separate package/composition identity and a runtime execution identity may be cleaner than continually expanding one fingerprint.

At minimum, two different artifact digests must not have the same content identity merely because their manifests and contributions happen to look the same.

## 6. SDK and authoring tool boundaries

CGP should distinguish the runtime host package from the tools and types module authors need.

### 6.1 Foundations runtime package

This is the library an application embeds to validate and compose packages.

Its public entrypoint should be explicit and stable. The current src/foundations/index.ts barrel is a good conceptual boundary. Internal implementation files must remain unexported.

A distributable runtime package should:
- build JavaScript output into a dist directory;
- ship declarations for its public TypeScript API;
- declare supported Node/browser runtime targets accurately;
- use package.json exports to expose only documented public entrypoints;
- include a strict files allowlist for release contents;
- include README and LICENSE;
- test installation from the packed artifact, not only from the monorepo.

Node recommends package exports for a well-defined public surface and subpath encapsulation. npm's files and ignore rules determine which files enter the published package; the packed output must be inspected before publication.

### 6.2 Module author SDK

The module SDK should provide:
- stable ModuleImplementation and context types;
- manifest and package descriptor types/schema;
- helper functions that are explicitly part of the supported API;
- package validation;
- a starter generator;
- test harnesses for module hooks and contribution contracts;
- an isolated guest build/check workflow for supported WebAssembly toolchains;
- clear distinction between type-time imports and runtime imports.

Do not make module authors import from a relative path into CGP's source tree. The SDK should be installed as a declared package or referenced through a supported local workspace during development.

The SDK's own version may be different from the Foundations API version. The supported compatibility relationship must be documented; it must not be inferred from npm package version alone.

### 6.3 CLI

A small CLI can wrap the SDK and package library with commands such as:

- init — create an authoring project;
- build — compile the implementation into a release directory;
- validate — statically validate package structure and metadata;
- test — deliberately execute the package in the selected test backend;
- pack — produce an immutable archive and digest;
- catalog add/list/show — operate on the local catalog;
- profile lock — resolve profile intent into exact package digests;
- verify — check locked packages before composition.

The exact command names are provisional. The important contract is that static validation and runtime execution are separate operations.

### 6.4 Separate npm package boundaries

Do not remove private:true from the current root package.json as a shortcut to publishing. npm documents that the flag prevents publication, and it is currently protecting the monorepo package from accidental release.

When distribution is ready, move the distributable runtime and SDK into explicit package directories/workspaces with their own package.json, exports, type declarations, files allowlist, README, LICENSE, repository metadata, and release checks. The root project may remain private.

Prefer ESM first. Do not add CommonJS output without a demonstrated consumer requirement and a plan to avoid duplicate singleton state across dual entrypoints.

## 7. License, provenance, and publisher trust

### 7.1 License declaration

The runtime manifest already accepts an SPDX-like license expression when supplied. That is a useful starting point, but the current validation checks expression shape rather than consulting the official SPDX License List for every identifier. The package validator should use a proper SPDX expression parser and a version-pinned license/exception list if full identifier validation is required.

The release package should include the applicable license text or explicit license terms, where the license requires or the author intends them. A module using LicenseRef-Proprietary must include the referenced terms in a documented form.

The author field is a self-declared display value, not publisher authentication. The presence of "MIT" is not proof that the publisher owns the code or has authority to license every dependency.

### 7.2 Integrity versus authenticity

The package and artifact SHA-256 values answer: “Are these the same bytes as the expected digest?”

They do not answer:
- who built the artifact;
- whether the source repository is the claimed repository;
- whether the build process was compromised;
- whether the author is the publisher;
- whether the code is malicious.

A digital signature or trusted publisher mechanism can provide additional identity evidence, but it requires a trust root and key-management policy.

### 7.3 Build provenance

SLSA provenance describes where, when, and how an artifact was produced, including its builder, build definition, output subject digest, and resolved dependencies. It is a useful interoperability target for release attestations.

npm trusted publishing can generate provenance attestations under specific conditions. Current npm documentation identifies supported cloud CI/CD providers and requires repository metadata to match the publishing repository; public provenance availability has limitations for private repositories. These are npm-specific constraints, not universal CGP package requirements.

CGP should not create a proprietary provenance format merely to store source commit and builder strings. It should reference standard in-toto/SLSA attestations if and when automated publishing is introduced.

Provenance increases verifiability; it does not mean that the artifact is safe, reviewed, reproducible, or free of vulnerabilities.

### 7.4 Suggested release evidence levels

A pragmatic phased model:

| Level | Evidence | Appropriate stage |
|---|---|---|
| Local development | Package and artifact digests computed locally | First local catalog |
| Reproducible release | Immutable source revision, toolchain versions, build command, artifact digest | First third-party release tests |
| CI-attested release | Signed/verified provenance from a trusted build platform | Public publishing |
| Publisher trust policy | Configured publisher/key/identity allowlist, revocation and incident response | Shared ecosystem with multiple publishers |

Do not imply that the first digest-only local catalog provides publisher authenticity.

## 8. Package acquisition and validation security

Package acquisition is itself an attack surface. The validator must treat downloaded package contents as untrusted data.

At a minimum, a future pack/unpack implementation should:
- enforce maximum compressed and expanded package sizes;
- enforce file-count and path-depth ceilings;
- reject absolute paths, parent traversal, malformed paths, duplicate normalized paths, and path collisions;
- reject symlinks and hard links in the initial format unless a later specification explicitly defines safe behavior;
- reject archive entries that escape the staging directory;
- stage unpacking in a newly created private temporary directory;
- avoid executing package scripts, compiler commands, or install hooks during acquisition;
- hash the exact package bytes and verify them before accepting package contents;
- reject duplicate moduleId/version releases with conflicting digests;
- parse JSON with size and depth ceilings;
- inspect WebAssembly structure and imports before any guest is instantiated;
- keep JavaScript package loading separate from static validation and require the explicit trusted-in-process policy for execution.

### 8.1 Static validation versus runtime smoke testing

The current scripts/check-wasm-module.ts calls compose() with a WebAssembly backend and therefore runs the guest lifecycle hooks. It is an integration/smoke test, not a purely static package validator.

The future tooling should expose two clearly named operations:

**Static validation**
- checks package paths, JSON schemas, format version, manifest identity, artifact existence, digest, size, WebAssembly imports/exports/memory/table constraints, and supported ABI;
- does not import or execute JavaScript;
- does not instantiate or call WebAssembly guest functions.

**Runtime test**
- explicitly creates the selected backend;
- applies a constrained test policy;
- executes register/initialize and any selected test calls;
- reports the test's execution policy and result;
- always releases the session;
- is never run as an implicit side effect of installation or catalog indexing.

Static inspection cannot prove runtime behavior. Runtime smoke tests cannot prove arbitrary code safe. Those limits must remain visible.

## 9. Dependency categories

The word dependency is overloaded. CGP should name the category.

| Dependency category | Example | Resolution owner |
|---|---|---|
| Foundations API dependency | moduleApi admits host API 1.x | Foundations compatibility validation |
| Runtime capability requirement | requires a capability contract | Composition resolver |
| Slot contract dependency | connectsTo a module-owned Slot | Composition resolver |
| Build dependency | TypeScript compiler, Rust crate, WIT compiler | Author's build toolchain |
| Packaged runtime dependency | Library imported by a JavaScript runtime artifact | Bundler or future explicit runtime dependency resolver |
| Guest ABI/WIT dependency | cgp.abi/1 or a WIT package | Package/ABI validation and future SDK tooling |
| Platform/runtime requirement | Node version or browser worker target | Package validator and backend selection |

A module's existing requires array is a capability contract, not a generic npm dependency list and not a complete package installation plan.

For the first package format, prefer self-contained runtime artifacts:
- bundle JavaScript runtime dependencies into module.mjs;
- use the existing host imports for WebAssembly capabilities;
- do not load npm dependencies or arbitrary secondary files implicitly at runtime.

If external runtime dependencies later become necessary, give them their own pinned, digest-verified model. Do not silently reuse development dependencies.

## 10. Minimal end-to-end local workflow

The first implementation should prove a fully local journey:

1. **Initialize:** create a module authoring project from the CGP SDK template.
2. **Author:** edit manifest.json and module source without importing the CGP repository.
3. **Build:** compile JavaScript to module.mjs or compile a guest to module.wasm.
4. **Stage:** create a clean release directory with manifest.json, cgp-package.json, one artifact, README, and license material.
5. **Static validate:** check schemas, paths, artifact format, compatibility declarations, size limits, and import/export rules without executing module code.
6. **Runtime test:** explicitly run the package against a chosen backend under a restrictive policy.
7. **Pack:** create an immutable package archive and compute package and artifact digests.
8. **Catalog:** add the release to a local catalog; reject an existing moduleId/version with different bytes.
9. **Profile:** select moduleId/version as application intent.
10. **Lock:** resolve the profile and generate cgp.lock.json with exact package and artifact digests.
11. **Verify:** retrieve the package from the catalog, verify digests and compatibility, and refuse drift.
12. **Compose:** pass only verified ModulePackage objects to the existing composition host.

The most valuable proof is that a separately authored package can be copied to a clean project, installed from a local catalog, locked, verified, and composed without any path or import into this CGP repository.

## 11. Failure cases and required refusal behavior

| Failure | Required behavior |
|---|---|
| Missing manifest or package descriptor | Reject package before composition |
| Unknown package format version | Refuse; do not guess compatibility |
| Manifest moduleId/version disagrees with catalog coordinate | Refuse |
| Two entries for the same moduleId/version with different digests | Catalog/release immutability error |
| Package or artifact digest mismatch | Refuse before loading or instantiating code |
| Missing or ambiguous runtime artifact | Refuse; never select by directory scan order |
| Both JS and WebAssembly entrypoints in format v1 | Refuse as ambiguous |
| Unknown runtime kind or ABI version | Refuse before backend open |
| Foundations API range excludes host | Refuse before module hooks |
| Required capability/Slot absent or ambiguous | Preserve existing composition refusal semantics |
| Module requires a backend that is unavailable | Refuse; do not silently fall back to trusted JavaScript |
| JavaScript package is selected without explicit trust | Refuse before importing the module |
| WebAssembly has unauthorized imports or invalid limits | Refuse before worker instantiation |
| Archive path traversal, symlink escape, excessive size, or duplicate normalized path | Refuse extraction; remove staging directory |
| License expression identifier is invalid or license file is inconsistent | Warn or refuse according to an explicitly documented release policy; do not infer permission |
| Provenance is required by policy but missing or invalid | Refuse release under that policy; otherwise mark provenance unverified |
| Runtime smoke test fails after partial hook execution | Report failure and release the isolated test session; do not label it a static-validation failure |
| Lock entry differs from catalog/profile | Refuse locked execution; require an explicit lock update |

No error path should leave partially extracted files in the catalog, publish an incomplete lock, or execute code as a side effect of static validation.

## 12. Recommended implementation sequence after contract review

This is a candidate sequence, not an authorization to change accepted ADRs.

| Step | Work | Exit condition |
|---|---|---|
| 1 | Finalize package descriptor and directory format | Example JS and Wasm release packages validate from a clean folder |
| 2 | Split authoring source from release artifact | TypeScript starter builds to module.mjs with no repository-relative import |
| 3 | Define distributable Foundations and module SDK boundaries | Clean project installs SDK and host package through explicit package references |
| 4 | Implement static package validator | Invalid paths, descriptors, hashes, imports, and formats are refused without execution |
| 5 | Implement runtime package smoke test | JS and Wasm execute only through their selected trust/backend policy |
| 6 | Implement deterministic pack and digest | Same staged files produce documented package identity; digest mismatch is refused |
| 7 | Add cgp.lock.json | Locked execution refuses different package/artifact bytes |
| 8 | Add local catalog | Independent module can be discovered, inspected, installed, and locked offline |
| 9 | Bind digest into composition identity | Same module version with different artifact bytes cannot share a content fingerprint |
| 10 | Add CI release provenance | Attestations identify immutable source revision and output digest |
| 11 | Consider remote distribution | Local package, catalog, and lock contracts have passed cross-project tests |

Before publishing npm packages, split their release boundaries into dedicated workspace packages with explicit public exports and file allowlists. Keep the current root private until that separation and its release tests are complete.

## 13. Open questions before an ADR

1. Should the package descriptor be named cgp-package.json, or should package-format metadata be placed elsewhere?
2. Is one executable artifact per release sufficient for the first independently distributed modules?
3. Should a JavaScript release artifact bundle all runtime dependencies, or is a small explicit runtime dependency model required immediately?
4. What Node/browser versions are official targets for JavaScript and WebAssembly packages?
5. Should a lock pin the digest of the archive bytes, a canonical package-tree digest, or both?
6. What archive format and deterministic packing rules should be adopted?
7. Should source provenance be mandatory for local/private packages or only for shared/public releases?
8. Which publisher identity mechanism should CGP support first, if any?
9. Should an application profile remain a human-authored module list with a separate generated lock, as proposed here?
10. Should Foundations runtime and module authoring SDK be separate npm packages or one package with distinct public subpaths?
11. Should JavaScript runtime modules be permitted to use Node built-ins by default, or should a later host API offer a narrower in-process convention? This does not create a sandbox either way.
12. How should a future multi-target package express a JavaScript and WebAssembly implementation of the same logical module?
13. What is the minimum release policy for proprietary modules and LicenseRef-Proprietary material?
14. What trust policy should apply to unsigned local packages versus remote catalog packages?

## Conclusion

CGP already has a real module contract and a working isolated guest path. It does not yet have a complete independent release boundary. The next step is to standardize that boundary without disturbing the existing Foundations composition model.

The strongest proposed design is deliberately layered:

- keep manifest.json as the runtime module contract;
- add a small versioned package descriptor that selects one executable artifact;
- compile JavaScript authoring projects into ESM and keep them explicitly trusted in-process;
- retain module.wasm and cgp.abi/1 for isolated guest packages;
- keep catalog metadata and digests outside the runtime manifest;
- add a lock that pins exact package bytes;
- start with a local catalog and a no-install-scripts package validator;
- add provenance only when the release pipeline can produce verifiable attestations.

The most important reproducibility improvement is to bind immutable package identity into the lock and eventual composition fingerprint. The most important security improvement is to ensure package acquisition and static validation never execute arbitrary module code.

This is a proposed contract for review. It should become an accepted ADR only after the package examples, lock behavior, archive digest method, SDK boundary, and trust policy are agreed.

**No CGP implementation code, package manifest, profile, lock file, or accepted ADR was changed as part of this study.**

## Sources

### Existing CGP research and implementation

- [O3DE Study 001 — Gems, Packaging, and Distribution](../o3de/001-gems-packaging-and-distribution.md)
- [wasmCloud Study 001 — Component Host and Capability Model](../wasmcloud/001-component-host-and-capability-model.md)
- [wasmCloud Study 002 — Component Model and WIT](../wasmcloud/002-component-model-and-wit.md)
- [Extism Study 001 — Plugin Host Architecture, Guest SDKs, and Lifecycle](../extism/001-plugin-host-architecture-and-lifecycle.md)
- [Extism Study 002 — State Persistence, Failure Recovery, and Runtime Security](../extism/002-state-persistence-failure-recovery-and-runtime-security.md)
- [CGP Architecture Synthesis 001](../synthesis/001-cross-architecture-synthesis.md)
- [Current authoring guide](../../authoring.md)
- [Current ABI specification](../../abi.md)
- [ADR 0007 — Public Authoring Surface](../../adr/0007-public-authoring.md)
- [ADR 0013 — Portable-Module Toolchain and Licenses](../../adr/0013-authoring-toolchain-and-license.md)
- [ADR 0014 — Host Accounting and Third-Party Guests](../../adr/0014-accounting-and-third-party-guests.md)

### Official packaging and runtime documentation

- [Node.js Packages — package exports and encapsulation](https://nodejs.org/api/packages.html)
- [Node.js TypeScript — type stripping and its limitations](https://nodejs.org/api/typescript.html)
- [Node.js Learn — Publishing a package](https://nodejs.org/learn/modules/publishing-a-package)
- [npm package.json — files, ignore rules, repository metadata](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm provenance statements and limitations](https://docs.npmjs.com/generating-provenance-statements/)
- [SPDX License List](https://spdx.org/licenses/)
- [SLSA Build Provenance v1](https://slsa.dev/spec/v1.2/build-provenance)
- [SLSA Build Requirements](https://slsa.dev/spec/v1.2/build-requirements)

The npm, Node.js, SPDX, and SLSA documentation is maintained upstream. Re-check the relevant versions and publisher restrictions before implementing or publishing against them.
