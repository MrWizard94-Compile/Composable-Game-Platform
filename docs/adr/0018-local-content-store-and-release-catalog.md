# ADR 0018 — Local Content Store and Release Catalog

**Status:** Accepted — initial local tooling scope  
**Date:** 2026-11-15  
**Related decisions:** ADR 0008, 0010, 0011, 0017

## Context

ADR 0017 defines immutable release coordinates and `cgp.package-tree/1` identity, but deliberately defers local catalog and content-store behavior. The release packer produces a validated staging directory. This decision registers those staged bytes locally without making Foundations aware of storage paths or catalog metadata.

## Decision

Implement a local, single-writer content store and catalog as package tooling outside Foundations.

### Store layout

~~~text
<store>/
  catalog.json
  .cgp-store.lock
  objects/
    cgp.package-tree/
      1/
        sha256/
          <64-lowercase-hex>/
            manifest.json
            cgp-package.json
            module.mjs | module.wasm
            ...
~~~

The object key is the full tuple `(packageTreeProfile, hash algorithm, digest)`. The profile is part of the key. The object directory contains exact logical package files only; it contains no catalog record, lock, timestamps, or generated metadata.

### Catalog schema

`catalog.json` is strict UTF-8 JSON using the closed `cgp.local-catalog/1` schema:

~~~json
{
  "schema": "cgp.local-catalog/1",
  "entries": [
    {
      "moduleId": "org.example.beacon",
      "version": "1.0.0",
      "packageTreeProfile": "cgp.package-tree/1",
      "packageTreeDigest": "sha256:<64 lowercase hex>",
      "artifactDigest": "sha256:<64 lowercase hex>",
      "runtime": "wasm-core",
      "files": ["cgp-package.json", "manifest.json", "module.wasm"]
    }
  ]
}
~~~

Entries are sorted by moduleId then exact version using ordinal string ordering. File paths are sorted ordinally. Timestamps, source URLs, publisher identity, signatures, trust decisions, and mutable descriptions are excluded. The validated package manifest remains authoritative for the release coordinate and the package descriptor for runtime kind.

### Registration transaction

1. Validate the supplied staging directory as a format-v1 release. Never trust a packer summary file.
2. Acquire the store's exclusive writer lock. If a lock already exists, fail closed; do not guess whether its owner is dead or remove it automatically.
3. Read and validate the existing catalog. A malformed or unknown catalog is an error, never an invitation to overwrite it.
4. Check the immutable coordinate. An identical profile and package digest is idempotent. A different digest or profile for the same moduleId/version is a hard conflict.
5. If the content object already exists, validate it and require exact digest, artifact digest, coordinate, runtime, and file-list agreement. Do not repair a corrupt object in place.
6. Otherwise copy only regular package files into a temporary sibling directory, validate the copied object, verify both digests and metadata, make it read-only, then atomically rename it into its content-addressed location.
7. Write a complete new catalog to a unique temporary file, flush it, and atomically rename it over `catalog.json`.
8. Release the lock.

If a process stops while copying, an unreferenced `.cgp-object-*` temporary directory may remain. If it stops after object publication but before catalog replacement, an unreferenced content object may remain. Neither is catalog-visible. A later registration of the same release can verify and reuse a completed object; incomplete temporary directories require manual inspection/removal after confirming no writer is active. Automatic garbage collection and temp recovery are deliberately deferred.

### Locking and crash behavior

The first implementation uses one exclusive lock file per store, created with exclusive-create semantics. This serializes writers across processes and keeps the object/catalog update simple. A crashed process can leave a stale lock. The tool reports the lock path and refuses to break it automatically; an operator must first verify that no writer is active before removing it. There is no PID-based stale-lock guessing.

Atomic rename is used only within the same store filesystem. Temporary objects are created beside their final object directory. The store does not promise power-loss durability on every filesystem; file flush is performed before catalog replacement, while filesystem-specific directory-flush semantics remain a future hardening item.

### Verification and immutability

Stored objects are revalidated from disk when registered as existing content and when explicitly verified. Read-only permissions prevent accidental mutation but are not a security boundary against the store owner, administrator, or privileged process. A digest detects changed bytes; it does not authenticate a publisher or make JavaScript safe.

A catalog record is not proof that the current object still matches. Consumers that need integrity assurance must verify the object before use. The initial implementation provides explicit whole-store verification and exact-coordinate resolution that verifies the selected object before returning its path. A future consumer may use that verified path, but resolution does not load or execute module code.

### Resource limits

Local store import and verification enforce the same ceilings as the release packer: 4,096 files, 64 MiB per file, 128 MiB total file content, 240 UTF-8 bytes per path, and 16 path components. Exceeding a limit refuses the operation without truncation.

## Non-goals

This decision does not add remote registries, network fetching, publisher authentication, signatures, provenance, TUF, archive import/export, project lockfiles, dependency solving, installation into a running host, runtime loading, package leases, garbage collection, or browser storage.

The store is a local package-tooling concern. Foundations and `src/foundations/index.ts` remain unaware of catalog files and content-store paths.

## Consequences

- Identical package content deduplicates by content identity.
- A module release coordinate cannot be silently rebound to different bytes.
- Store writes are serialized and fail closed when lock state is uncertain.
- Interrupted registration may leave harmless orphan objects, but must not create catalog references to incomplete objects.
- Catalog and store data remain verifiable from immutable package files, but catalog reconstruction tooling is not part of this first implementation.
- Store paths are local implementation details, not a public cross-machine transport format.
