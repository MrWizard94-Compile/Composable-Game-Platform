# ADR 0019 — Project Lockfiles and Exact Local Resolution

**Status:** Accepted — initial local tooling scope  
**Date:** 2026-11-16  
**Related decisions:** ADR 0008, 0017, 0018

## Context

ADR 0008 defines composition profiles with exact module versions. ADR 0017 gives each release a content identity. ADR 0018 registers validated releases in a local catalog and content-addressed store. A profile alone says which versions a project expects, but it does not record which immutable package bytes were resolved for those pins.

The console also needs a useful way to inspect the store, register prepared releases, and verify a project's pinned packages without moving filesystem responsibilities into Foundations or loading code merely to inspect it.

## Decision

Add a project lockfile and a Node-side exact resolver in `src/packages`. Connect the browser console to this tooling through a loopback-only local HTTP API.

### Lockfile identity

The file uses the closed `cgp.project-lock/1` schema:

~~~json
{
  "schema": "cgp.project-lock/1",
  "profileId": "org.example.local-project",
  "profileDigest": "sha256:<64 lowercase hex>",
  "modules": [
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

Each module record is the local catalog release identity: exact module id and version, package-tree profile/digest, artifact digest, runtime kind, and complete ordinally sorted file list. Unknown and missing fields are rejected. Duplicate module ids are rejected.

The profile digest is computed from a domain-separated canonical JSON representation of `profileId` and the ordered list of exact `moduleId@version` pins. Display name and description are not part of dependency identity. Module order is preserved because the existing composition profile defines an ordered selection.

### Creation

Creating a lock validates the profile and calls exact-coordinate resolution for every pin. Each selected package object is validated from disk before its catalog identity is copied into the lock. If any exact release is absent or its stored bytes fail validation, lock creation fails without publishing a partial lock.

### Resolution

Resolving a lock performs all of the following:

1. Validate the supplied profile and the closed lockfile schema.
2. Recompute the profile digest and require the same profile id, ordered module pins, and exact versions.
3. Require one matching catalog entry for every locked coordinate.
4. Compare the full catalog identity with the lock record.
5. Resolve the exact local coordinate and revalidate the content-addressed object from disk.
6. Compare the verified stored identity with the lock record before returning any resolved package paths.

Resolution does not choose a version, upgrade a pin, solve transitive dependencies, fetch a package, import JavaScript, instantiate WebAssembly, or load code. It returns verified package paths and immutable identities to package tooling.

### Lockfile writes

The console offers separate Generate and Update actions. Generate refuses to overwrite an existing lockfile. Update is explicit and publishes a complete replacement from a same-directory temporary file after all exact packages have been verified. A failed generation or verification does not publish a partial lock.

The standalone commands are `scripts/create-project-lock.ts` and `scripts/check-project-lock.ts`. The console uses the same package-level functions.

### Console API boundary

The browser console cannot access local files directly. The Node server binds to loopback, exposes only the store and project operations needed by the UI, accepts mutating calls only from its same origin, and constrains staging registration to a direct child of the explicitly configured staging root. Request bodies and configured project JSON files have size ceilings. The browser never supplies arbitrary filesystem paths to API operations.

The store screen distinguishes catalog metadata from verification results. A catalog entry is not labelled verified until `verifyLocalStore()` has revalidated its referenced bytes. Project resolution reports success only after exact profile, catalog, and stored-object identities all agree.

## Non-goals

- Dependency range solving or automatic version selection.
- Transitive dependency discovery beyond the explicit profile's pins.
- Remote registries, package downloads, publishing, signatures, provenance, or trust authentication.
- Runtime installation, JavaScript module execution, or Wasm instantiation from the local store.
- Automatic lockfile regeneration when a profile or package changes.
- Lockfile merging, multi-project workspaces, and package garbage collection.

The console's existing Composition view continues to use the bundled proof catalog. Store lock resolution is a separate local package-tooling operation until a deliberate installer/runtime-loading milestone is designed.

## Consequences

- A project lock records the exact bytes expected for each explicitly pinned release.
- Re-running resolution detects a missing, changed, corrupted, or catalog-rebound package before returning a package path.
- Cosmetic profile edits do not invalidate the lock; changing the profile id, module set, pin versions, or pin order does.
- Lockfiles can be regenerated intentionally, but are not silently rewritten.
- Foundations remain unaware of the local content-store layout, lockfile paths, and filesystem access.
- A valid lockfile proves content identity against the local store; it does not authenticate the publisher or make trusted JavaScript safe.
