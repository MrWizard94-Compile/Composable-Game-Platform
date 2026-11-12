# ADR 0008 — Composition profiles

**Status:** Accepted. A profile is not a world.

## Decision

A composition profile is a JSON document. It names a profile id, a display name, and a list of module ids with exact versions. Unknown fields are errors. A module id may appear once. A version is `major.minor.patch`, not a range.

`resolveProfile` selects those packages from a catalog the caller already has. Order in the document is the input order. It is not the execution order.

A missing module, two packages with the same id, an invalid manifest, or a packaged version that is not the pin refuses the whole selection. The host does not upgrade, and it does not compose the packages that did match. An empty `compose()` is a different result and is not used as a stand-in.

The console chips are these documents. A selection that matches no profile is custom, and the packaged versions are used as they are.

## Consequences

Changing a module's version without changing the profile makes that chip refuse. Adding a module to a chip is a change to a JSON file, not to the host.
