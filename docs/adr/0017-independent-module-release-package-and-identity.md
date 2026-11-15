# ADR 0017 — Independent Module Release Package and Identity

**Status:** Accepted — 2026-11-15.  
**Date:** 2026-11-15  
**Decision owners:** CGP maintainers  
**Related accepted ADRs:** 0001, 0007, 0008, 0010, 0011, 0013  
**Related research:** CGP Studies 001–003; Package Architecture Review 001  
**Implementation status:** Not yet implemented.

## Context

CGP currently accepts module packages as caller-supplied objects. A module folder has a runtime manifest and may contain either TypeScript implementation source or WebAssembly bytes. Discovery reads manifests and Wasm bytes without importing JavaScript or instantiating a guest. Loading trusted JavaScript is a separate operation.

The current authoring guide uses a repository-relative TypeScript import from the starter module. That is suitable for a copyable in-repository example, but it is not yet an independent release artifact that can be built, copied to another project, and consumed without access to the CGP source tree.

The package studies identified five distinct objects:

1. An authoring project containing source, tests, build inputs, and toolchain configuration.
2. A released package containing runtime metadata and one selected executable artifact.
3. A catalog/source record advertising a module release and its content identity.
4. A content-store object holding the immutable released package files.
5. An application profile and generated lock selecting exact package releases.

This ADR decides only the released package format and its content identity. It does not decide the local catalog database, archive transport, package lock schema, source trust, package leases, garbage collection, SDK publication, or remote registry.

The package contract must preserve these existing boundaries:

- manifest.json remains the CGP runtime module manifest.
- The module's moduleApi range remains distinct from the package format version.
- The current WebAssembly interface remains cgp.abi/1.
- JavaScript remains trusted in-process code and is not made safe by being packaged or hashed.
- Foundations remains unaware of catalog URLs, content-store paths, archive formats, and package installation.
- One moduleId plus exact semantic version must not silently identify different released bytes.

## Decision

Adopt the following version-1 independent module release contract.

### 1. Released package directory

A format-v1 package is a directory with this minimum structure:

~~~text
org.example.beacon/
├── manifest.json
├── cgp-package.json
├── module.wasm          # wasm-core package
└── README.md             # optional release documentation
~~~

or:

~~~text
org.example.beacon/
├── manifest.json
├── cgp-package.json
├── module.mjs            # javascript-esm package
├── README.md             # optional release documentation
└── LICENSE               # optional license text/terms
~~~

Rules:

- manifest.json is required and uses the existing closed CGP runtime manifest schema.
- cgp-package.json is required and uses the new closed package descriptor schema below.
- Exactly one selected runtime artifact is required.
- Documentation, license material, and additional regular data files may be included.
- Every included regular file contributes to packageTreeDigest, whether or not the current runtime uses it.
- Empty directories are not package content.
- The package root directory name is not part of package identity.
- A release does not require source code, tests, build scripts, generated compiler inputs, node_modules, or a package manager installation step.
- Format-v1 packages must not contain package.json or any node_modules directory. CGP package loading does not use npm package metadata or dependency resolution.
- module.ts is reserved as authoring source and must not be present in a format-v1 release.
- guest.json has no runtime meaning. An authoring tool may use it as a build input; the release builder should omit it unless the author deliberately includes it as an ordinary data file.
- A release packer must construct a clean release directory. It must not copy an author's whole workspace by default.
- Runtime package acquisition never executes install scripts, post-install hooks, or build commands.
- A local package directory is the normative representation for format v1. This ADR does not select a ZIP, TAR, or other archive format.

The package loader must not infer module identity or executable choice from the directory name or file presence. It uses the validated manifest and package descriptor.

### 2. Runtime manifest remains unchanged

manifest.json keeps its current fields and semantics:

- moduleId identifies the module.
- name and optional description are human-readable metadata.
- version is the module's exact semantic version.
- moduleApi is the compatibility range for the Foundations API.
- requires, provides, connectsTo, and exposesSlots remain CGP composition contracts.
- permissions retain their existing meaning and enforcement limitations.
- save, author, and license retain the meanings already accepted in prior ADRs.

The package descriptor must not repeat moduleId, name, module version, moduleApi, capability requirements, Slot relationships, permissions, or save version. Those remain the responsibility of manifest.json.

This ADR does not weaken or replace ADR 0007's single supported Foundations authoring surface. The authoring SDK may improve how authors obtain types and build artifacts, but a released artifact must not depend on a relative import into the CGP repository.

### 3. Package descriptor

The package descriptor is cgp-package.json. It is a closed JSON object with a required integer formatVersion and one runtime object.

#### 3.1 WebAssembly Core module

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

Rules:

- kind is exactly wasm-core.
- entry is exactly the root-relative filename module.wasm in format v1.
- abi identifies the CGP guest interface. For the first format version it must be cgp.abi/1.
- The package contains one WebAssembly Core module entrypoint. It is not a WebAssembly Component Model package.
- The host continues to enforce the imports, exports, memory, table, worker, time, and aggregate resource restrictions already defined in docs/abi.md and the accepted execution ADRs.
- The Wasm Core specification version implemented by a particular engine is not the CGP guest ABI version. The ABI string identifies CGP's own host/guest contract.

#### 3.2 JavaScript ECMAScript module

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

Rules:

- kind is exactly javascript-esm.
- entry is exactly the root-relative filename module.mjs in format v1.
- export is exactly the named export implementation.
- executionTrust is exactly trusted-in-process.
- The entrypoint is a self-contained ESM artifact. Relative imports, bare third-party package imports, and dynamic import() are not part of format v1.
- Static imports may target Node built-in modules using explicit node: specifiers. Doing so does not reduce the trusted-in-process grants.
- Runtime dependencies from third parties must be bundled into module.mjs.
- The CGP loader does not resolve packages from an ambient application node_modules tree.
- The module is loaded only after the caller has selected the trusted-in-process execution path.
- The package format is not a JavaScript sandbox and does not make filesystem, network, or operating-system access enforceable.
- The initial package-loader target for javascript-esm is the current Node ESM host. This ADR makes no claim that the dynamic package loader works in the browser console. Browser package loading requires a separately supported resolver/loader path.

Node treats .mjs files explicitly as ECMAScript modules. This is why format v1 selects module.mjs instead of relying on ambiguous .js interpretation or a package.json type field.

### 4. Closed schema and strict JSON input

Both manifest.json and cgp-package.json are UTF-8 JSON documents.

A release validator must:

- reject malformed UTF-8;
- reject a UTF-8 BOM;
- reject duplicate object property names before ordinary object construction;
- reject comments and trailing commas;
- reject unknown fields at every defined schema level;
- reject wrong field types and unsupported format versions;
- reject unknown runtime kinds, export values, ABI identifiers, and trust classifications;
- reject absolute entry paths, parent traversal, and paths outside the package root.

Duplicate property names must be rejected even though RFC 8259 describes uniqueness as a SHOULD. The RFC explains that receiver behavior is unpredictable when object names are duplicated. A package validator must not depend on parser-specific first-value or last-value behavior.

Raw JSON file bytes are included in packageTreeDigest exactly as stored. The validator does not rewrite, pretty-print, normalize whitespace, reorder properties, or canonicalize manifest.json or cgp-package.json before computing the package tree.

A later lock/profile ADR may select RFC 8785 JSON Canonicalization Scheme for semantic profile identity. That is a different operation and does not alter this package-tree rule.

### 5. One executable artifact per release

Format v1 selects exactly one executable artifact.

- A wasm-core package uses module.wasm and does not include module.mjs as an alternative executable.
- A javascript-esm package uses module.mjs and does not include module.wasm as an alternative executable.
- module.ts is authoring source, not a released executable, and must not be included as a runtime implementation in a format-v1 release.
- The package descriptor explicitly names the one entrypoint. The loader must not guess.
- Additional package files are data/documentation/license material. They are not implicitly loaded as further runtime modules.

An authoring project may contain multiple targets and source files. The release builder selects one target and emits one format-v1 package.

This rule has a material limitation: the same moduleId and exact version cannot be published once as JavaScript and once as Wasm with different package bytes. Such releases would conflict with the immutable coordinate rule below. Until multi-target packages are designed, authors must use distinct release coordinates or wait for a later package format that explicitly defines target variants and selection semantics. Do not create an implicit backend fallback.

### 6. Authoring source versus release artifact

An authoring project can contain TypeScript, Rust, C/C++, WIT, guest.json, tests, toolchain configuration, generated code, and multiple target builds. Those are build inputs, not automatically part of the runtime release.

For format v1:

- TypeScript may be used by the authoring project.
- The JavaScript release output is module.mjs.
- TypeScript imports used only for types must be erased from the release artifact.
- The release artifact must not contain a relative import into the CGP repository.
- Third-party runtime dependencies must be bundled into the single ESM artifact.
- guest.json may be used as an authoring/build input for a supported Wasm toolchain. It is not required by the runtime package format and is not interpreted by the host.
- The release builder must use an explicit clean staging directory rather than treating the authoring workspace as the package.
- The root repository package remains private. This ADR does not authorize publishing the monorepo as an npm package or removing private=true.

The package descriptor and runtime files describe the built release. They do not describe the build process.

### 7. Package path profile

Define the initial path profile as cgp.package-path/1.

The package root contains only relative paths. Each path is represented with forward-slash separators independent of the source operating system.

For each path component:

- Characters are limited to ASCII letters, digits, period, underscore, and hyphen.
- A component may not be empty, exactly period, or exactly double-period.
- A component may not end in a period.
- Leading periods are allowed.
- Backslash, colon, NUL, control characters, whitespace, Unicode, drive designators, and network/UNC path syntax are not permitted.
- Windows device names are rejected case-insensitively, including CON, PRN, AUX, NUL, COM1 through COM9, and LPT1 through LPT9, including names followed by an extension.
- A path component equal to node_modules, using ASCII case-insensitive comparison, is forbidden.
- The ASCII-only rule also excludes the superscript-digit variants Windows recognizes for COM and LPT device names.
- Paths that collide under ASCII case folding are rejected. For example, README.md and readme.md cannot coexist.
- A file/directory path collision is rejected. A path cannot be both a regular file and an ancestor directory of another package file.

This rule deliberately favors cross-platform portability over unrestricted filenames. It does not restrict Unicode text inside file contents.

The package format defines path syntax and identity. It does not set one universal maximum file size, total package size, file count, path depth, or path length in this ADR. The packer/store must apply explicit documented resource limits for the host and target filesystem; a package exceeding those limits is refused rather than truncated or rewritten.

### 8. Package entry types

The logical package tree contains regular files only.

- Symbolic links and special filesystem entries are rejected during local directory scanning.
- Archive symlink, hard-link, device, FIFO, socket, and unknown entry types must be rejected by any future archive importer.
- A local source hard link, if encountered, is copied as ordinary file bytes into staging. The hard-link relationship is not preserved and is not part of package identity.
- Directories are implied by file paths. Empty directories are ignored and do not affect the digest.
- No path is silently normalized or repaired.
- A package packer must not follow a symlink outside the package root.

An archive format is not selected here. When an archive importer is defined, explicit directory records may be treated only as structural markers after path validation; they do not create empty-directory identity.

### 9. Package-tree digest

Define the package-tree digest profile as cgp.package-tree/1.

The profile identifier and digest value are separate data:

- packageTreeProfile is exactly cgp.package-tree/1.
- packageTreeDigest uses the string form sha256:<64 lowercase hexadecimal characters>.

Catalog records, package locks, and content-store keys must carry or derive both the profile identifier and digest value. The profile is part of object identity; the same SHA-256 hex value under a different tree profile is not assumed to identify the same package tree.

The content-store key is conceptually the tuple:

~~~text
(cgp.package-tree/1, sha256, <64 lowercase hexadecimal characters>)
~~~

The profile identifier is not written into the released package. It is external metadata so that the digest is not self-referential.

#### 9.1 Files included

The package-tree digest includes every regular file below the package root, including:

- manifest.json;
- cgp-package.json;
- the selected runtime artifact;
- README and documentation files;
- license and notice files;
- additional regular data files.

It excludes:

- the name of the parent package directory;
- timestamps, ownership, group IDs, and filesystem permission bits;
- filesystem inode identity and hard-link relationships;
- empty directories;
- source catalog records and source URLs;
- lockfiles;
- archive bytes and archive metadata;
- signatures and provenance attestations stored outside the package tree.

Changing any included file's path or bytes changes the package-tree digest. The package descriptor and runtime manifest are part of the tree and therefore cannot change without changing package identity.

#### 9.2 Hash construction

For the sorted list of validated package files, calculate:

~~~text
SHA256(
  UTF8("CGP-PACKAGE-TREE" || NUL || "v1")
  || UINT64_BE(fileCount)
  || for each file sorted by ascending path-byte order:
       UINT64_BE(pathByteLength)
       || pathBytes
       || UINT64_BE(fileSize)
       || SHA256(fileBytes)
)
~~~

Definitions:

- fileCount is the number of regular files.
- pathBytes are the exact ASCII bytes of the normalized relative path using forward slashes.
- fileSize is the exact byte length of the file.
- SHA256(fileBytes) is the 32-byte binary SHA-256 digest of the exact raw file bytes.
- UINT64_BE is an unsigned 64-bit big-endian integer encoding.
- Files are sorted by ascending bytewise path order, not locale collation, filesystem enumeration order, or archive member order.
- The final digest is represented as sha256:<lowercase hex>.

The profile must not hash a naive concatenation of file bytes. It uses explicit record lengths and path identity so that file boundaries and file names are unambiguous.

The proposed formula is a CGP-defined profile, not an external standard. Before implementation is considered interoperable, publish test vectors for empty trees, one file, multiple files, different enumeration orders, changed paths, changed file bytes, changed documentation/license, forbidden paths, case-fold collisions, and forbidden entry types.

### 10. Artifact digest

artifactDigest is the SHA-256 digest of the exact raw bytes of the selected executable file:

- module.wasm for wasm-core;
- module.mjs for javascript-esm.

It is calculated over the exact file bytes. It is not a digest of parsed Wasm sections, JavaScript syntax trees, or normalized source.

artifactDigest and packageTreeDigest are distinct:

- artifactDigest identifies executable bytes.
- packageTreeDigest identifies the complete released package.
- A README or LICENSE change changes packageTreeDigest but not artifactDigest.
- An executable change changes both.

The package descriptor must not contain either digest. Digests belong in the catalog, lock, and store metadata outside the package tree.

### 11. Immutable release coordinate

The immutable release coordinate is:

~~~text
moduleId + exact semantic version
~~~

For each coordinate in the CGP release namespace:

- the first accepted release record binds the coordinate to one packageTreeProfile and packageTreeDigest;
- re-registering the same coordinate with the same profile and digest is idempotent;
- registering the same coordinate with a different profile or digest is an immutable-release conflict;
- a changed executable, manifest, package descriptor, README, license file, or other package file requires a new semantic version;
- adding a mirror or producing a different archive representation for identical package files does not create a new logical release;
- deprecation or revocation metadata must not silently replace the package digest.

Two sources that advertise the same coordinate and same package-tree identity are advertisements of the same content. Two sources that advertise the same coordinate but different package-tree identities must produce an ambiguity/conflict; source order must not select one.

A private fork should normally use a distinct moduleId. Source-qualified overrides are not part of this ADR.

### 12. Version axes remain separate

The following identifiers serve different purposes:

| Identifier | Meaning |
|---|---|
| manifest.version | Exact semantic version of this module release |
| manifest.moduleApi | Foundations API compatibility range |
| cgp-package.json formatVersion | Schema/semantics version of the package descriptor |
| runtime.abi | CGP guest ABI identifier for a Wasm package |
| runtime.executionTrust | Required trust classification for the JavaScript package |
| packageTreeProfile | Canonical package-tree digest algorithm/profile |
| SDK/toolchain version | Authoring tool compatibility; not part of runtime package identity unless separately declared |

A formatVersion change must not be inferred from module version or moduleApi. A cgp.abi version change must not be inferred from WebAssembly Core specification version.

### 13. License metadata remains under ADR 0013

This ADR does not change manifest.license or the existing rule that the field is optional.

The package-tree digest includes any license and notice files that the author includes. The package format does not infer legal rights from a filename, author field, SPDX expression, signature, or digest. A LicenseRef-Proprietary declaration should be accompanied by the author's applicable terms, but the package validator does not establish that those terms are legally complete or that the publisher owns the rights.

Any future stricter SPDX expression parsing or License List version pinning should be handled as a separate toolchain/license decision. It must not silently change the accepted runtime manifest schema.

## Consequences

### Positive

- A module can be released without depending on its original source repository or a relative path into CGP.
- The runtime manifest and package descriptor have separate responsibilities.
- The package format can support both existing JavaScript and Wasm execution paths without mixing trust semantics.
- Exact executable bytes and complete package contents have distinct verifiable identities.
- Package identity is stable across parent-directory renames and archive re-encodings.
- A future local catalog can use the package-tree identity as a content-addressed object key.
- A future lock can pin exact package content without embedding download URLs or archive format.
- Static validation can inspect package metadata and bytes without executing module code.

### Costs and restrictions

- Authors need a build/staging step; a source folder is not automatically a release package.
- JavaScript runtime dependencies need to be bundled into the single module.mjs entrypoint.
- The ASCII path profile restricts package filenames.
- Every package file, including documentation and license text, contributes to packageTreeDigest. A documentation-only release therefore needs a new module version under immutable release coordinates.
- One artifact per release means one moduleId/version cannot publish separate JavaScript and Wasm artifacts with different digests.
- Strict JSON duplicate-property detection may require a parser beyond the current JSON.parse path.
- The hash profile requires conformance vectors and cross-implementation tests before third-party package interoperability is claimed.
- Hash identity does not authenticate the publisher or make executable code safe.

## Alternatives considered

### A. Reuse manifest.json for runtime artifact selection

Rejected. It would combine module composition semantics with executable packaging and distribution details. The package descriptor is a separate concern and keeps existing manifests stable.

### B. Use npm package.json as the CGP package contract

Rejected for format v1. An npm package has a different publishing, dependency, and installation model. CGP packages must not require npm installation or lifecycle scripts. A future Foundations SDK may itself be distributed through npm without making module release packages npm packages.

### C. Identify packages only by moduleId and version

Rejected. The current profile pins moduleId and version but cannot distinguish two different byte sets published under the same coordinate. Package content identity is required for immutability and reproducible locking.

### D. Hash only module.wasm or module.mjs

Rejected. That omits the manifest, package descriptor, license, documentation, and other released files. artifactDigest already serves the executable-only purpose.

### E. Hash the archive bytes as package identity

Rejected. Repacking the same files can change timestamps, entry ordering, compression, and metadata. archiveDigest is a transport digest; packageTreeDigest is the logical package identity.

### F. Ship both JavaScript and Wasm alternatives in one release

Deferred. This requires target selection, fallback/refusal behavior, per-variant digests, compatibility rules, lock semantics, and an explicit definition of behavioral equivalence. One artifact avoids those unresolved choices in format v1.

### G. Permit arbitrary Unicode paths immediately

Deferred. Unicode normalization and cross-platform case/path collisions require a wider canonical path specification. The initial examples and SDK use ordinary portable filenames. The first format can widen this in a later profile if real module assets require it.

## Compatibility with accepted ADRs

| ADR | Compatibility |
|---|---|
| 0001 — Language, runtime, and first target | Compatible. Does not change the headless TypeScript host or browser viewer role. |
| 0007 — Public authoring surface | Compatible. Retains src/foundations/index.ts as the author-facing Foundations API. |
| 0008 — Composition profiles | Compatible. Profile schema remains exact moduleId/version intent; lock schema is deferred. |
| 0010 — Execution boundary | Compatible. JavaScript remains trusted in-process and Wasm remains governed by an execution backend. |
| 0011 — Isolated WebAssembly guests | Compatible. Package discovery and static validation do not instantiate guests. |
| 0013 — Portable-module toolchain and licenses | Compatible with a release staging extension. Existing license semantics remain unchanged. |

No accepted ADR is superseded by this proposal.

## Required conformance tests before implementation

A format-v1 implementation must eventually demonstrate:

1. A clean authoring project can produce a release directory without importing CGP source at runtime.
2. Both provided descriptor examples validate with the correct corresponding artifact.
3. Unknown descriptor fields and unknown runtime kinds are refused.
4. Wrong entrypoint names, wrong export names, wrong trust strings, and unsupported Wasm ABI identifiers are refused.
5. manifest.moduleId and manifest.version are the release coordinate and are not duplicated in the package descriptor.
6. A JavaScript package with relative imports, bare third-party imports, or dynamic import() fails static package validation.
7. A JavaScript static validator does not dynamically import or evaluate module.mjs.
8. A Wasm static validator checks the binary and import/export declarations without instantiating a guest.
9. A runtime smoke test is a separate deliberate operation and uses the selected backend/policy.
10. Unknown JSON members, duplicate JSON property names, malformed UTF-8, and a BOM are refused.
11. Absolute, parent-traversal, backslash, colon, invalid-character, reserved-device, and case-colliding paths are refused.
12. Symlinks and special filesystem entries are refused; archive link/special entries are refused if archive support is later implemented.
13. A source hard link is copied as regular file content into staging; link relationships are not preserved.
14. Empty directories do not change packageTreeDigest.
15. Different parent-directory names and filesystem enumeration orders produce the same packageTreeDigest for identical package files.
16. Changing any included regular file or path changes packageTreeDigest.
17. Changing only README or license text leaves artifactDigest unchanged but changes packageTreeDigest.
18. Changing executable bytes changes both artifactDigest and packageTreeDigest.
19. Package-tree test vectors match independently implemented hashers.
20. Re-registering a coordinate with the same packageTreeProfile/digest is idempotent, while a different digest is an immutable-release conflict.
21. A JavaScript and Wasm package cannot both occupy the same moduleId/version coordinate with different package digests.
22. A package containing package.json, a node_modules directory, or module.ts is refused.

## Deferred decisions

The following are explicitly outside this ADR:

- local catalog schema and metadata database;
- content-store directory layout and registration transaction;
- project locks, package-set identity, and locked resolver;
- project pins, composition leases, stale lease recovery, and garbage collection;
- archive format, reproducible ZIP/TAR profile, and archive cache;
- remote registries, mirrors, TUF, signatures, publisher identity, and provenance enforcement;
- multiple runtime artifacts or target variants per release;
- browser-native JavaScript package loading;
- a JavaScript sandbox;
- external runtime dependency resolution;
- hot module replacement and save migration;
- package size/count limits beyond the requirement for documented host resource ceilings.

## External references

- [RFC 8259 — The JSON Data Interchange Format](https://www.rfc-editor.org/rfc/rfc8259.html) — JSON object member names and interoperable parser behavior.
- [RFC 8785 — JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html) — deterministic JSON serialization for semantic hashing; used here only as a possible future profile/lock technique, not for raw package-file hashing.
- [Node.js v26.13.1 — Modules: Packages](https://nodejs.org/api/packages.html) — explicit ESM file markers, including .mjs.
- [Node.js — ECMAScript Modules](https://nodejs.org/api/esm.html) — ESM imports, exports, and module behavior.
- [Microsoft — Naming Files, Paths, and Namespaces](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file) — Windows reserved characters, device names, case behavior, and trailing period restrictions.
- [WebAssembly Core Specification 3.0, Candidate Recommendation Draft](https://www.w3.org/TR/wasm-core/) — current WebAssembly Core module standard; distinct from the CGP-specific cgp.abi/1 contract.
- [SPDX Specification 3.0.1 — License expressions](https://spdx.github.io/spdx-spec/v3.0.1/annexes/spdx-license-expressions/) — normative license expression syntax. This ADR preserves the current ADR 0013 validation behavior.

## Accepted decision scope

The maintainers accepted the following decisions:

- manifest.json remains unchanged;
- cgp-package.json formatVersion 1 and the two runtime descriptor shapes are sufficiently precise;
- one runtime artifact per release is acceptable for the first format;
- the package path profile is appropriately portable;
- the package-tree digest profile and external profile identifier are unambiguous;
- the immutable moduleId/version mapping is acceptable, including its multi-target limitation;
- the stated compatibility and non-goals match the intended CGP boundaries.

This ADR records an accepted package contract. Acceptance does not mean implementation or conformance tests are complete. It does not authorize the deferred capabilities listed above, and it does not change existing accepted ADRs.