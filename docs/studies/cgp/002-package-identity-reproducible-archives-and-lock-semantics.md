# CGP Study 002 — Package Identity, Reproducible Archives, and Lock Semantics

**Research date:** 2026-11-15  
**CGP baseline:** [d2e1a830997d0e992bff5e16a63bd9ecc0cbcdb1](https://github.com/MrWizard94-Compile/Composable-Game-Platform/commit/d2e1a830997d0e992bff5e16a63bd9ecc0cbcdb1)  
**Related research:** CGP Study 001 — Independent Module Package, Artifact, and SDK Contract; Cross-architecture Synthesis 001; O3DE Study 001 — Gems, Packaging, and Distribution.  
**Decision status:** Proposed identity and acquisition contract for review. This is not an accepted ADR and does not authorize implementation, publication, or a particular archive format.

## Purpose and decision boundary

Study 001 proposed a separately versioned runtime package, a package descriptor, a local catalog, and a generated lock file. It also identified an unresolved problem: the word package digest can mean the hash of an archive, the hash of the files extracted from it, or the hash of the executable artifact inside it.

Those are different objects and need different identities.

This study investigates:

- reproducible package contents versus reproducible archive bytes;
- exact artifact, package-tree, and archive digest semantics;
- safe and portable package paths;
- lockfile contents, update behavior, and offline/mirror behavior;
- archive extraction and resource-exhaustion risks;
- immutable release coordinates and content-addressed storage;
- the relationship between package identity and CGP's composition fingerprint.

This study does not:

- select ZIP, TAR, TAR.GZ, TAR.ZST, or OCI as the final transport format;
- change the current manifest, profile, or host implementation;
- add an archive parser or extractor;
- introduce a remote registry;
- establish publisher authenticity, package signing, or malware detection;
- change the current cgp.abi/1 boundary or the distinction between JavaScript and isolated WebAssembly;
- authorize a code change or ADR.

The recommendation is to define the package tree and its identity before selecting an archive container. CGP can validate and catalog a local package directory without making a choice that will later constrain every supported platform.

## Executive findings

1. **Use three distinct digests.** An artifact digest identifies the exact executable file; a package-tree digest identifies the complete released package contents; an archive digest identifies the exact compressed or uncompressed transport bytes. They serve different purposes and must not share an ambiguous field name.
2. **Make the package-tree digest the stable logical package identity.** The same files at the same relative paths should produce the same tree digest even when packaged in different archive formats or with different archive metadata.
3. **Retire the unqualified proposed field name packageDigest before it becomes a schema contract.** Use explicit names such as packageTreeDigest, artifactDigest, and archiveDigest.
4. **Hash all released package files.** This includes manifest.json, cgp-package.json, the runtime artifact, documentation, license text, and any shipped assets. The package root directory name is not part of the digest. Volatile catalog, lock, and provenance records remain outside the package tree.
5. **Use a versioned canonical tree-hash profile.** Sort validated relative paths, encode each path and file size unambiguously, and include a cryptographic hash of each file's exact bytes. The profile needs published test vectors before implementation is considered stable.
6. **Keep the first path profile deliberately portable.** A conservative ASCII path subset avoids Unicode normalization differences and common Windows/POSIX path aliasing. This restricts filenames, not file contents. A later package-format version can widen the rules.
7. **Treat package directories as the first normative representation.** The current local-catalog workflow does not require an archive. Archive creation should be a transport adapter over the canonical package tree.
8. **Do not choose ZIP or TAR by familiarity alone.** Both can be made reproducible, but their metadata, path, link, timestamp, compression, and extraction behaviors differ. The final choice should follow an explicit supported-platform and dependency decision.
9. **Keep package identity independent of archive identity.** Different archives may be accepted as equivalent transport encodings only after their extracted package-tree digest matches the lock or catalog expectation.
10. **Pin package-tree and executable-artifact digests in the lock.** Keep retrieval URLs and archive descriptors in the catalog or as optional locator hints. A URL is a location, not identity.
11. **Make moduleId plus exact semantic version immutable.** Once published, that coordinate cannot point to a different package-tree digest. A corrected release needs a new module version. Re-archiving identical tree contents does not create a new logical release.
12. **Use a strict acquisition pipeline.** Bound archive size and expansion, reject traversal paths and links, extract into an isolated staging directory, verify the resulting tree digest, validate metadata, then place the package in immutable storage. Never execute package code as part of acquisition.
13. **Use canonical JSON only where semantic JSON identity is needed.** RFC 8785 JCS can provide a deterministic profile digest, but it requires strict duplicate-property handling and exact Unicode/number behavior. Raw JSON bytes remain part of the package-tree digest.
14. **A lock is a reproducibility record, not a trust root.** Its digests are meaningful only when the lock itself is obtained through a trusted channel and reviewed under the application's change policy.
15. **Separate package identity from runtime execution identity.** Artifact and package digests belong in package/composition identity; backend and effective execution policy belong in runtime execution identity.

## 1. Current CGP context

Study 001 established the following proposed boundaries:

- manifest.json remains the runtime module contract;
- cgp-package.json identifies the released package format and selected runtime artifact;
- a release package contains one selected runtime artifact in format version 1;
- a local catalog is sufficient for the first independent-package workflow;
- profiles express intentional module selection and exact versions;
- a generated lock records the exact package resolution;
- package acquisition must not execute install scripts or build commands.

The repository currently loads packages from local directories. Its current composition profile pins moduleId and exact version but not package content. The existing composition fingerprint describes module IDs and versions, Slot structure, dependency edges, and contribution order. It does not include artifact bytes or a package digest.

The root project remains a private development repository. The current package design is a research proposal, not a released public SDK.

This study builds on those boundaries rather than replacing them.

## 2. Three identities that must not be conflated

### 2.1 Artifact digest

The artifact digest is the hash of the exact executable artifact bytes selected by cgp-package.json.

Examples:

- SHA-256 of module.wasm for a wasm-core package;
- SHA-256 of module.mjs for a javascript-esm package.

The artifact digest answers:

> Are these the exact executable bytes that the lock or catalog expects?

The artifact digest should be calculated over the raw file bytes, not parsed WebAssembly sections, JavaScript syntax trees, or normalized source text.

The artifact digest is useful for:

- verifying the executable before it is handed to a backend;
- identifying executable changes even when the rest of the package is unchanged;
- including the selected runtime artifact in a composition content identity;
- runtime cache keys, where the cache is correctly partitioned by ABI and backend compatibility.

The artifact digest does not identify the whole package. A changed LICENSE, manifest, package descriptor, README, or asset can produce a different released package while leaving the executable artifact unchanged.

### 2.2 Package-tree digest

The package-tree digest is the stable identity of the complete released package directory.

It is calculated from:

- every regular file in the released package;
- each file's relative path from the package root;
- each file's exact byte content.

It deliberately excludes:

- the name of the parent directory containing the package;
- modification, creation, and access timestamps;
- file owner and group IDs;
- host-specific filesystem permission bits;
- archive format and compression settings;
- archive member ordering;
- empty directories;
- catalog URLs, archive records, locks, and external provenance attestations.

The package descriptor and runtime manifest are included. Their content determines the runtime contract and must not be mutable without changing the package-tree digest.

The package-tree digest answers:

> Does this directory contain the exact released package files at the exact relative paths expected by the lock?

This is the recommended primary identity for an immutable CGP package release.

### 2.3 Archive digest

The archive digest is the hash of the exact archive bytes transferred or stored.

It answers:

> Are these the exact archive bytes described by the catalog or transport descriptor?

The archive digest changes if the ZIP/TAR representation changes, even when all extracted files are identical. Differences can arise from timestamps, archive entry order, ownership metadata, extra fields, permissions, compression implementation, or compression parameters.

The archive digest is still important. It allows a consumer to verify the downloaded object before asking an archive parser to process it. The archive record should also include the exact byte size and media type.

The OCI Content Descriptor model is a useful precedent for transport metadata: it combines a media type, a digest, a size, and optional retrieval URLs. CGP can use that concept without adopting OCI image layering or requiring an OCI registry.

### 2.4 Identity comparison

| Change | Artifact digest | Package-tree digest | Archive digest |
|---|---|---|---|
| Executable file bytes change | Changes | Changes | Changes |
| Manifest or package descriptor changes | May stay the same | Changes | Changes |
| README or LICENSE changes | Stays the same | Changes | Changes |
| File path changes | May stay the same | Changes | Changes |
| File timestamps or owner metadata change only | Stays the same | Stays the same | May change |
| ZIP is repacked as TAR with identical files | Stays the same | Stays the same | Changes |
| Same archive bytes are copied to another mirror | Stays the same | Stays the same | Stays the same |

The package-tree digest is therefore not a replacement for the artifact digest or archive digest. Each answers a different verification question.

## 3. Proposed package-tree digest profile

### 3.1 Scope and versioning

Define a named, versioned algorithm, provisionally:

**CGP Package Tree Digest v1**

Use SHA-256 with an explicit algorithm prefix:

~~~text
sha256:<lowercase hexadecimal digest>
~~~

The algorithm identifier should be part of the external digest string. The canonicalization profile version is separate from the hash algorithm. Changing path rules, entry types, or record encoding creates a new tree-digest profile version; it must not silently reinterpret old digests.

The exact profile should be frozen only after independent implementations produce the same results for published test vectors.

### 3.2 Proposed entry rules

For profile version 1:

- The package root is the directory containing manifest.json and cgp-package.json.
- Paths are relative to that root and use forward slashes.
- File path characters are restricted to a portable ASCII subset: letters, digits, period, underscore, and hyphen in path components, with slash used only as a separator.
- Empty path components, leading slash, backslash, colon, NUL, control characters, and components equal to period or double-period are rejected.
- Components ending in a period or space are rejected.
- Windows reserved device names are rejected, including CON, PRN, AUX, NUL, COM1 through COM9, and LPT1 through LPT9, including names with extensions.
- Two paths that collide under ASCII case folding are rejected. For example, README.md and readme.md cannot coexist.
- Duplicate archive entries and duplicate normalized paths are rejected. No parser-specific “first entry wins” or “last entry wins” behavior is allowed.
- All package leaf entries are regular files. Symbolic links, hard links, devices, FIFOs, sockets, and other special entries are rejected.
- Directory structure is implied by file paths. Empty directories are not package content. If a selected archive format permits explicit directory records, those records are structural markers only: their paths must be valid and implied by file entries, and they do not contribute to the digest.
- No path is silently repaired or normalized. An invalid path is rejected rather than rewritten.

This profile is intentionally restrictive. The current release package shape uses simple names such as manifest.json, cgp-package.json, module.wasm, module.mjs, README.md, and LICENSE. Restricting paths does not restrict Unicode text inside the files. A later profile can widen filename support with a carefully specified Unicode normalization and collision policy.

### 3.3 Content rules

- Every file's byte content is hashed exactly as stored.
- Text files are not line-ending normalized.
- JSON files are not reserialized before their file hash is computed.
- Executable files are not parsed or normalized before their artifact hash is computed.
- A package's README, license text, manifest, package descriptor, runtime artifact, and assets all contribute to the tree identity.
- The package-root folder name is excluded so moving or renaming the enclosing local directory does not change package identity.
- Catalog indexes, lockfiles, archive descriptors, signatures, and provenance attestations are stored outside the package tree. This avoids circular references where a package contains a digest or attestation that itself refers to the digest of the package.

### 3.4 Proposed unambiguous hash construction

One candidate encoding is:

~~~text
SHA256(
  UTF8("CGP-PACKAGE-TREE" || NUL || "v1")
  || UINT64_BE(fileCount)
  || for each regular file sorted by path bytes:
       UINT64_BE(pathByteLength)
       || pathBytes
       || UINT64_BE(fileSize)
       || SHA256(fileBytes)
)
~~~

Where:

- fileCount is the number of regular files;
- pathBytes are the exact ASCII bytes of the validated relative path;
- fileSize is the exact byte length of the file;
- SHA256(fileBytes) is the 32-byte binary digest of the file content;
- UINT64_BE means an unsigned 64-bit big-endian integer;
- files are sorted by ascending path-byte order, not host filesystem iteration order or locale collation.

Length-prefixing makes record boundaries unambiguous. Including both path and content digest means the same bytes at a different path produce a different package-tree digest. Including file size provides an explicit length check and prevents a consumer from confusing a truncated content stream with a complete file.

This is a proposed profile, not an existing standard. It must have conformance vectors for:

- an empty package tree;
- a package with one file;
- multiple files in different filesystem iteration orders;
- the same files in different parent directories;
- a changed path with unchanged bytes;
- a changed file byte with unchanged path;
- a changed README or LICENSE;
- duplicate paths and case-fold collisions;
- invalid paths and forbidden entry types.

An implementation must refuse integer overflow, excessive file count, path length, file size, and total package size before allocation or hashing work exceeds its configured limits.

### 3.5 Why not hash just the concatenated file bytes?

A naive hash of concatenated file contents is ambiguous. For example, the byte sequences AB plus C and A plus BC yield the same concatenation. It also omits path identity.

The proposed length-prefixed records, deterministic ordering, and path inclusion establish a defined package-tree representation. A future implementation could use a Merkle tree for incremental verification, but that is not required to establish the first package identity contract.

## 4. Archive formats and reproducibility

### 4.1 Reproducibility is a property of a defined build profile

An archive is reproducible when the same inputs and defined packaging rules produce byte-for-byte identical output. Merely invoking the same archive command twice is insufficient if the source metadata or environment differs.

Relevant sources of variation include:

- source filesystem enumeration order;
- timestamps and time zones;
- file creation or access times;
- file permissions and umask;
- user and group names or numeric IDs;
- archive extra fields;
- archive format extensions;
- compression library and compression parameters;
- locale-dependent sorting;
- platform-specific path or attribute encoding.

The Reproducible Builds archive guidance documents these variables for TAR and ZIP. GNU TAR's manual separately describes sorting entries and normalizing timestamps, ownership, and permissions. These are not cosmetic concerns: they can change the archive digest without changing the package files that CGP executes.

### 4.2 ZIP trade-offs

Advantages:

- familiar to Windows, macOS, Linux, and many browser-side tooling ecosystems;
- broad library and user-tool support;
- straightforward single-file distribution;
- supports stored and compressed file members.

Reproducibility and interoperability concerns:

- timestamps have format and precision constraints;
- timezone interpretation can matter;
- ZIP extra fields can carry additional timestamps and platform metadata;
- Unix permission and link information may be represented through external attributes;
- compression output can vary with the implementation and parameters;
- archives can contain duplicate names, path traversal entries, or symlink entries;
- ZIP64 and filename encoding add cases that the validator must define.

Reproducible Builds guidance recommends suppressing ZIP extra fields and using UTC consistently when creating and extracting ZIP files. This is evidence that an ordinary ZIP command is not a sufficient canonicalization contract.

Security concerns:

- directory traversal entries can escape the extraction root;
- symbolic-link entries can cause later reads or writes to escape intended boundaries;
- decompression bombs can consume excessive disk, memory, or CPU.

ZIP is viable, but its convenience does not remove the need for an explicit package path policy and a hardened extraction pipeline.

### 4.3 TAR trade-offs

Advantages:

- straightforward streaming archive structure;
- widely supported on Unix-like systems and by modern cross-platform libraries;
- reproducible creation can be expressed through explicit ordering and metadata normalization;
- archive member types are visible and can be restricted.

Reproducibility and interoperability concerns:

- timestamps, owner/group IDs, and mode bits are represented in headers;
- PAX extensions may carry extra metadata such as atime and ctime;
- some implementations add process-specific or environment-specific PAX metadata;
- USTAR has path and metadata limits;
- GNU TAR and PAX variants are not interchangeable without a defined profile;
- gzip adds another layer whose header and compression settings must also be controlled;
- TAR supports links and special file types that CGP should not accept in package releases.

The Reproducible Builds guidance shows how deterministic TAR creation requires sorting file entries and normalizing timestamp, owner/group, and metadata fields. It also points out that PAX metadata must be handled deliberately.

TAR is viable, but “a TAR archive” is not a complete format contract. CGP would need to name a specific accepted profile and reject unsupported variants.

### 4.4 Compression is a separate decision

TAR, gzip, and Zstandard are separate layers:

- TAR describes a sequence of files and metadata.
- gzip or Zstandard compresses a byte stream.
- the archive digest is calculated over the exact final bytes sent or stored.
- the package-tree digest is calculated from the extracted canonical file tree.

Different compression levels or compressor versions can produce different archive digests for identical TAR content. This does not change the package-tree digest.

CGP should avoid a release format whose reproducibility silently depends on an unpinned compression library or on an undocumented set of command-line defaults.

### 4.5 Recommendation: defer the canonical archive choice

Do not make ZIP or TAR mandatory in the first package contract.

The current milestone can prove independent packaging with a validated package directory and a package-tree digest. That is enough for local catalog add/list/show, package validation, lock generation, and locked composition.

Before remote archive distribution is adopted, define the actual support matrix:

- Node versions and operating systems;
- whether browser-side package acquisition is required;
- whether packages can contain large assets;
- whether the CLI can depend on a native archive tool or needs a bundled library;
- whether packages must be created reproducibly across Windows, macOS, and Linux;
- whether compressed archives materially reduce distribution size for the expected artifacts.

Then choose one versioned archive profile and test independent packers and extractors against the same corpus. The archive format must not determine package identity.

A later catalog can support more than one archive representation for the same package-tree digest. A consumer accepts any representation only after safe extraction and matching tree-digest verification.

## 5. Catalog and release-record semantics

### 5.1 Release coordinate immutability

The logical release coordinate remains:

~~~text
moduleId + exact semantic version
~~~

For example:

~~~text
org.example.beacon@1.0.0
~~~

Once a coordinate is registered, its packageTreeDigest is immutable.

Rules:

- Registering the same moduleId and version with the same packageTreeDigest is an idempotent operation.
- Registering the same moduleId and version with a different packageTreeDigest is an immutability conflict and must fail.
- A changed runtime artifact necessarily changes the packageTreeDigest because the artifact is included in the package tree.
- A changed manifest, descriptor, license, README, or asset also changes the packageTreeDigest.
- A package rebuilt or repacked with identical package files keeps the same packageTreeDigest.
- A new logical release with changed files requires a new module version.
- Deprecation, yanking, or security revocation is separate metadata. It must not silently rewrite the old coordinate to new bytes.

A publisher cannot “fix” an already published version by replacing the package in place. Consumers with an existing lock must continue to detect the old digest or refuse if an explicit revocation policy blocks it.

### 5.2 Catalog release record

The catalog record should separate the logical release from one or more transport objects.

Illustrative shape:

~~~json
{
  "moduleId": "org.example.beacon",
  "version": "1.0.0",
  "packageTreeDigest": "sha256:...",
  "packageFileCount": 5,
  "unpackedSize": 184320,
  "runtime": {
    "kind": "wasm-core",
    "entry": "module.wasm",
    "abi": "cgp.abi/1",
    "artifactDigest": "sha256:..."
  },
  "archives": [
    {
      "mediaType": "application/zip",
      "size": 74210,
      "digest": "sha256:...",
      "urls": ["https://packages.example.invalid/beacon-1.0.0.zip"]
    }
  ],
  "source": {
    "repository": "https://example.invalid/beacon",
    "commit": "..."
  }
}
~~~

This is illustrative, not an accepted schema. The URLs and archive records can change as mirrors are added or archives are repacked. The module coordinate and package-tree digest cannot.

The catalog should not treat the URL as the release identity. A URL can redirect, move, expire, or serve changed bytes. The archive digest and package-tree digest are the verification points.

The record should include:

- moduleId and exact version;
- packageTreeDigest;
- package file count and total unpacked size;
- runtime kind, entrypoint, ABI where applicable, and artifactDigest;
- one or more archive descriptors, each with media type, exact size, digest, and retrieval locations;
- source repository and immutable commit where available;
- license and publisher/provenance references as metadata, not authentication by assertion.

### 5.3 Same tree, different archive

A package publisher may produce a ZIP and a TAR representation of the same validated directory. Those representations have different archive digests but the same packageTreeDigest and artifactDigest.

This is not a package release conflict. It is a new transport representation for the same immutable release.

The local catalog can model this by keeping one logical release record with one or more archive descriptors. Each descriptor is independently verified before extraction. The extracted package tree must still match the logical release's expected packageTreeDigest.

The consumer must not accept arbitrary alternate archives merely because their filenames or module coordinates match. The alternate archive must be associated with the same trusted catalog release and must yield the exact expected tree digest.

## 6. Proposed lock semantics

### 6.1 Profile intent and lock resolution remain separate

The profile expresses which modules and exact versions the application owner intends to compose.

The lock records the exact package contents selected for that profile.

The lock should include every selected module package required by the profile, including all nested composition modules selected by the profile. It should not invent a second package-dependency system.

Important distinction:

- CGP manifest requires/provides are capability relationships used by composition.
- Package acquisition describes where the released package bytes come from.
- A future external build/runtime dependency graph would be a separate graph with separate semantics.
- A capability name is not an npm package dependency and does not by itself identify a package to download.

This preserves the graph separation established in Cross-architecture Synthesis 001.

### 6.2 Proposed lock contents

A revised illustrative lock shape:

~~~json
{
  "lockFormat": 1,
  "profileId": "org.example.game",
  "profileDigest": "sha256:...",
  "foundationsApi": "1.0.0",
  "modules": [
    {
      "moduleId": "org.example.beacon",
      "version": "1.0.0",
      "packageTreeDigest": "sha256:...",
      "runtime": {
        "kind": "wasm-core",
        "entry": "module.wasm",
        "abi": "cgp.abi/1",
        "artifactDigest": "sha256:..."
      }
    }
  ]
}
~~~

This remains a proposal. The schema needs to match the eventual profile identity fields and package descriptor.

The lock should contain:

- lock format version;
- profile identity;
- a semantic digest of the profile input;
- the exact Foundations API version used for resolution;
- every selected moduleId and exact module version;
- packageTreeDigest for every released package;
- every execution-selecting field from the package descriptor, including runtime kind, entrypoint, Wasm ABI or JavaScript named export and trust classification, plus artifactDigest;
- any additional host/backend compatibility data that is part of package selection rather than runtime execution policy.

The lock's runtime summary must be derived from cgp-package.json and checked against it. It must not create a second independently editable runtime declaration.

The lock should not require a single permanent archive URL. Retrieval location belongs to the catalog. A lock may optionally contain a preferred catalog identifier or locator hint, but it must not treat that location as the content identity.

### 6.3 Why pin both package tree and artifact?

The packageTreeDigest proves the complete release package is identical. The artifactDigest explicitly identifies the executable bytes selected by the package descriptor. For JavaScript, the runtime summary must also preserve the named export and trusted-in-process classification; for WebAssembly, it must preserve the ABI identifier.

Because the executable is inside the package tree, the artifact digest is technically redundant as a check against package alteration. It remains useful as a named runtime identity and makes it possible to:

- compare executable changes independently from documentation-only changes;
- include the artifact in runtime cache and execution identity;
- report exactly which code bytes are being handed to the backend;
- diagnose a mismatch between package metadata and executable selection.

The validator must confirm that the runtime entry declared in cgp-package.json is the same file whose artifactDigest is recorded in the lock.

### 6.4 Profile digest

The profile digest should represent semantic JSON content rather than incidental whitespace or property order.

RFC 8785, the JSON Canonicalization Scheme (JCS), is a possible basis for this operation. It defines deterministic JSON serialization and property sorting for hashable data. It also requires I-JSON-compatible input, including no duplicate object property names, and specifies exact Unicode and number handling.

If CGP adopts JCS for profileDigest:

- use a conformant implementation, not ordinary JSON.stringify with hand-written key sorting;
- reject duplicate JSON property names before a normal parser silently overwrites one;
- reject invalid Unicode and values outside the supported JSON number model;
- preserve array order;
- do not Unicode-normalize strings during canonicalization;
- publish canonicalization test vectors.

JCS is an informational RFC, not an Internet Standards Track specification. Its value here is its precise, interoperable definition, not an implied standards mandate.

The package-tree digest remains a raw-file-content digest. JCS must not be used to rewrite manifest.json or cgp-package.json before hashing the package tree.

### 6.5 Deterministic lock generation

Lock generation should be deterministic:

- sort module entries by moduleId using the defined ASCII ordering;
- emit one entry per selected module coordinate;
- reject duplicate module IDs;
- serialize with stable property order and formatting;
- avoid timestamps, local paths, machine names, and other environment-specific fields;
- fail if the profile cannot be resolved unambiguously;
- fail if catalog metadata and package contents disagree.

Repeated lock generation with the same profile, catalog release set, and Foundations API should yield byte-identical lock output.

npm's package-lock provides a useful precedent: its purpose is to record a specific dependency tree, and its descriptors include resolved locations and integrity values. CGP should borrow the exact-resolution principle, not npm's package installation model or dependency semantics.

### 6.6 Locked execution and explicit update

A locked operation must:

1. Parse the lock with strict duplicate-property rejection.
2. Verify the profile semantic digest and Foundations API compatibility.
3. Locate each exact module coordinate from the catalog or local store.
4. Obtain an archive representation if the package is not already cached.
5. Verify archive byte size and archive digest when an archive descriptor is used.
6. Safely extract the package to a private staging directory.
7. Compute and verify packageTreeDigest.
8. Parse and validate manifest.json and cgp-package.json.
9. Check that moduleId and version inside the package match the lock.
10. Check that runtime kind, entrypoint, ABI, and artifactDigest match the lock.
11. Check backend support and host policy.
12. Pass only verified package contents to composition.

Any missing, mismatched, unsupported, ambiguous, or revoked package must fail closed. Locked execution must not select a newer version or silently replace an unavailable package with another version.

An explicit update operation may re-resolve the profile and regenerate the lock. It should show:

- module coordinates added or removed;
- version changes;
- package-tree digest changes;
- artifact digest changes;
- runtime kind or ABI changes;
- any catalog source or trust-policy changes.

The application owner reviews and commits the resulting diff. Updating the catalog must never rewrite existing locks.

### 6.7 Lock trust boundary

A lockfile is not self-authenticating. If an attacker can change the lock in the application's repository, they can point it at a different package digest. Verification will faithfully confirm the attacker-selected bytes.

Therefore:

- protect the application repository and review lock changes;
- use the repository's normal authenticated review/signature process;
- treat changes to package digests as code changes, not routine metadata refreshes;
- apply publisher/source trust policy separately;
- allow explicit revocation policy to block an otherwise digest-valid package when there is credible security evidence.

A digest proves that bytes match an expected digest. It does not prove who produced them or that they are safe.

## 7. Safe package acquisition and extraction

An archive is untrusted input until it has passed the complete acquisition process. A correct digest does not make an archive structurally safe; it only proves that its bytes match the expected digest.

### 7.1 Acquisition sequence

Recommended pipeline:

~~~text
Catalog record
    |
    v
Download into private temporary storage
    |
    v
Enforce compressed-byte limit and verify archive size/digest
    |
    v
Inspect archive entries and validate paths/types/counts/sizes
    |
    v
Extract with bounded streaming into a fresh staging directory
    |
    v
Compute canonical packageTreeDigest
    |
    v
Compare to lock/catalog expectation
    |
    v
Strictly parse and validate manifest + package descriptor
    |
    v
Verify artifact digest and static runtime constraints
    |
    v
Atomically promote to immutable content-addressed storage
    |
    v
Allow explicit composition/runtime testing
~~~

No package code runs during acquisition, validation, or catalog insertion.

### 7.2 Verify transport before expensive processing

Where an archive descriptor exists:

- enforce a maximum compressed archive byte size before retaining an unbounded download;
- calculate archiveDigest over the exact received bytes;
- compare the exact byte size and digest with the catalog descriptor;
- reject mismatch before decompression;
- use a temporary file or bounded stream, not an unbounded in-memory buffer.

This follows the useful OCI descriptor sequence: verify expected size and byte digest before trusting content from an untrusted source, and avoid heavy processing before digest verification.

### 7.3 Validate archive entries before extraction

The archive format profile must define entries relative to the package root, with no variable enclosing directory name. The archive parser may accept explicit directory records only as structural markers; it must validate them against the same path rules and must not preserve empty directories.

The archive parser and extractor must reject:

- absolute paths;
- parent traversal components such as double-period;
- backslash path separators;
- drive-qualified or UNC paths;
- NUL or control characters;
- paths that become invalid or collide under the package path rules;
- duplicate entry names;
- case-fold collisions;
- symbolic links and hard links;
- device nodes, FIFOs, sockets, and unknown entry types;
- archive formats or extensions outside the selected archive profile;
- encrypted entries unless a future explicit encryption contract is designed;
- malformed headers and inconsistent declared sizes.

Do not normalize a dangerous archive path into an acceptable one. Reject it.

OWASP documents archive directory traversal (often called Zip Slip), where unvalidated archive paths such as parent-directory references escape the intended extraction directory. OWASP also documents archive symlink attacks and decompression bombs. These risks apply to TAR as well as ZIP where the relevant entry types or compression layers are supported.

### 7.4 Bound expansion and resource use

Enforce independent limits for:

- compressed archive bytes;
- number of archive entries;
- maximum path length;
- maximum path depth;
- maximum individual uncompressed file size;
- maximum total uncompressed package size;
- maximum compression ratio as an additional guard;
- extraction time or CPU budget;
- temporary disk usage.

Do not trust archive-reported sizes alone. Count actual bytes written while decompressing and stop when a limit is exceeded.

The exact numerical limits should be selected as explicit policy defaults after testing representative modules and expected asset sizes. They should not be guessed in this study. Limits must be configurable within safe host ceilings and recorded when relevant to runtime policy.

### 7.5 Safe staging and filesystem behavior

- Extract into a newly created private staging directory.
- Never extract directly over an installed package or an existing content-store directory.
- Create files exclusively; do not overwrite an existing path.
- Do not follow symlinks while scanning local package directories or writing extracted files.
- Create only regular files and implicit directories.
- Normalize installed file permissions to the host's safe read-only policy; package permissions do not grant execution authority.
- Avoid relying only on a string prefix or a post-extraction realpath check. Filesystem race conditions and symlink swaps can invalidate naive containment checks.
- Use safe no-follow/exclusive filesystem operations supported by the target platform.
- Compute packageTreeDigest over the staged result and compare it with the expected digest.
- Promote the verified directory atomically into a content-addressed store on the same filesystem. If atomic promotion cannot be guaranteed, fail rather than expose a partially installed package.
- Do not permit an existing digest-addressed package directory to be modified in place.

For local authoring directories, the packer must also inspect filesystem entry types and refuse symlinks or special files rather than silently following them outside the project root.

### 7.6 Validation is not execution

Maintain three distinct operations:

1. **Static validation:** paths, metadata schema, package shape, artifact digest, and structural runtime checks.
2. **Runtime smoke test:** deliberate execution in the selected backend and policy, with known resource limits.
3. **Production composition:** use of a verified package under the application's locked profile and execution policy.

Study 001 already identified that the current WebAssembly checker calls compose() and therefore executes the guest lifecycle. That is a smoke test, not a purely static validator. The future CLI should make this distinction explicit.

For JavaScript, static validation must not import or evaluate the module as a side effect of validating the package. JavaScript remains trusted in-process code under the current runtime trust model; package verification does not sandbox it.

For WebAssembly, structural checks do not prove that a guest is benign. The selected backend must still enforce the existing import, memory, table, time, worker, and aggregate resource policies.

## 8. Composition and runtime identity

### 8.1 Package/composition content identity

Once packageTreeDigest exists, the composition's content identity should include:

- moduleId;
- exact module version;
- packageTreeDigest;
- artifactDigest and runtime ABI/entrypoint;
- existing Slot contracts and connections;
- dependency resolution results;
- deterministic contribution structure and order.

This prevents two different released packages with the same module coordinate from appearing as the same content composition.

A change to documentation or license changes packageTreeDigest even if the executable remains the same. That is appropriate for package identity. Artifact digest separately identifies the executable bytes.

### 8.2 Runtime execution identity

Backend identity and effective runtime policy affect execution but are not package content. A separate runtime execution identity may be cleaner than continuously expanding the package/composition fingerprint.

It may include:

- composition content identity;
- backend implementation and version;
- guest ABI/runtime version;
- effective policy values that materially affect execution;
- host API/runtime compatibility.

Care is needed because policies may be supplied at runtime and an identifier such as backend ID may not uniquely capture backend configuration.

The package-tree digest must not be mistaken for a deterministic simulation result, save compatibility guarantee, security certification, or proof that two different backends execute identically.

## 9. Failure cases and required behavior

| Condition | Required result |
|---|---|
| Same moduleId/version, different packageTreeDigest | Reject as immutable-release conflict |
| Same moduleId/version and same tree, different archiveDigest | Treat as another transport representation; verify it fully |
| Archive byte size or digest mismatch | Reject before extraction |
| Archive contains traversal path, link, duplicate, or special entry | Reject archive |
| Archive expands beyond any configured bound | Stop and reject; clean staging data |
| Extracted packageTreeDigest differs from lock | Reject; do not compose |
| Artifact digest differs from lock or descriptor | Reject; do not execute |
| Manifest ID/version differs from lock | Reject |
| Unknown package/lock format version | Refuse; do not guess |
| Duplicate JSON property names | Reject before schema processing |
| Profile digest differs from lock | Require explicit lock regeneration |
| Package is missing or unavailable | Fail locked operation; do not upgrade implicitly |
| Catalog locator changes but expected tree remains available | Resolve by trusted catalog policy and verify the same tree |
| Lock points to a digest-valid but revoked package | Apply explicit revocation policy; do not silently substitute |
| Static validation succeeds but runtime smoke test fails | Preserve the validation result and report a distinct runtime failure |

All failure paths should clean temporary files and staging directories. Cleanup itself should be tested under interrupted downloads, extraction exceptions, disk-full conditions, and process termination.

## 10. Recommended design decisions for a future ADR

The following are the strongest recommendations from this study:

1. Adopt separate artifactDigest, packageTreeDigest, and archiveDigest fields with non-overlapping meanings.
2. Make packageTreeDigest the immutable logical identity of a release.
3. Define a versioned canonical package-tree digest profile with conformance test vectors.
4. Use the canonical package directory as the normative first representation.
5. Defer the mandatory archive format until the supported platform matrix and archive tooling are decided.
6. Keep transport archive descriptors in the catalog, separate from package metadata and runtime manifest.
7. Pin packageTreeDigest and artifactDigest in the generated lock, together with profile digest and Foundations API compatibility.
8. Make moduleId plus exact version immutable with respect to packageTreeDigest.
9. Require strict path validation, bounded extraction, link rejection, private staging, and post-extraction tree verification.
10. Keep package validation separate from runtime execution.
11. Keep package/composition content identity separate from effective runtime execution identity.
12. Keep lockfile changes reviewable and explicit; never silently update a lock because a catalog changed.

These are recommendations for ADR review, not accepted architecture.

## 11. Open questions

The following decisions remain open:

- Should the canonical package-tree hash use the exact proposed length-prefixed record encoding, or a formally specified Merkle structure?
- Is the ASCII-only path rule acceptable for the first independent module ecosystem, or does CGP have a demonstrated need for Unicode filenames from day one?
- Should the release package permit arbitrary safe regular-file assets, or should package format v1 define a tighter allowlist?
- Which operating systems and runtimes must create and consume archives in the first distribution milestone?
- Which archive library or toolchain is acceptable for a future ZIP or TAR profile?
- If a remote archive is mirrored or repacked, should the lock optionally pin one exact archive digest for delivery audit, or should only the package-tree digest be mandatory?
- Should the catalog support multiple archive media types for one immutable package coordinate from its first version?
- What concrete compressed-size, unpacked-size, file-count, path-depth, and time ceilings match the first supported module workloads?
- Should content-addressed storage use the complete packageTreeDigest only, or also keep a separate artifact cache keyed by artifactDigest plus ABI?
- What is the minimal source-repository, commit, publisher, and provenance metadata required before CGP supports remote catalogs?
- Should an explicit package revocation record be separate from deprecation/yanking, and who can issue it?
- Which JSON parser/canonicalizer can reject duplicate property names and conform to RFC 8785 consistently in Node and browser builds?

Do not resolve these by adding options without a use case. The local directory workflow can establish the content identity and lock semantics before remote distribution is selected.

## 12. Suggested implementation sequence after ADR review

1. Add package-tree digest specification and test vectors only after the encoding and path profile are approved.
2. Implement safe local-directory scanning using filesystem metadata checks that do not follow symlinks.
3. Implement package validation and artifact hashing without importing JavaScript or instantiating WebAssembly.
4. Add package-tree digest verification to local catalog insertion and duplicate-coordinate checks.
5. Define and implement the lock schema, deterministic generation, profile digest, and locked verification.
6. Include packageTreeDigest and artifactDigest in package/composition content identity.
7. Add hostile-path and resource-limit test fixtures for archive ingestion.
8. Select one archive profile after supported runtime/OS requirements are explicit.
9. Test reproducible archives with independent builds and verify that alternative archives yield the same packageTreeDigest.
10. Add provenance and publisher verification as separate trust features, not as substitutes for content hashing.
11. Only then consider remote catalog and mirror behavior.

No implementation or accepted ADR changes are made by this study.

## 13. Research references

### Reproducible archives

- [Reproducible Builds — Archive metadata](https://reproducible-builds.org/docs/archives/) — timestamp, file ordering, owner/group, PAX metadata, file permissions, ZIP extra fields, and archive normalization.
- [GNU TAR manual — Making tar Archives More Reproducible](https://www.gnu.org/software/tar/manual/html_node/Reproducibility.html) — sorting, POSIX/PAX behavior, timestamp normalization, owner/group normalization, and modes.

### Content descriptors and content identity

- [Open Container Initiative — Content Descriptors](https://github.com/opencontainers/image-spec/blob/main/descriptor.md) — media type, digest, size, retrieval URLs, digest verification, and content addressability.
- [Open Container Initiative — Image Manifest](https://github.com/opencontainers/image-spec/blob/main/manifest.md) — artifact packaging guidance and the distinction between layer digest and uncompressed layer DiffID.
- [RFC 8785 — JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html) — deterministic JSON representation for hashing/signing, duplicate property restrictions, Unicode and number rules, and property ordering.

### Lockfiles and acquisition safety

- [npm CLI v11 — package-lock.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/) — an established example of a generated exact dependency-tree record containing resolved locations and artifact integrity.
- [OWASP Web Security Testing Guide — Upload of Malicious Files](https://wstg.owasp.org/latest/4-Web_Application_Security_Testing/10-Business_Logic/09-Upload_of_Malicious_Files/) — archive directory traversal, symbolic-link attacks, and decompression bombs.

## Conclusion

CGP should not make its package identity depend on an archive implementation. First define a canonical package directory, a versioned package-tree digest, immutable release coordinates, and a lock that pins exact package contents and executable bytes. Then choose an archive transport and define its deterministic metadata and extraction rules.

This sequence keeps the local catalog useful, preserves future ZIP/TAR/OCI options, and prevents a transport detail from becoming a foundational runtime contract.