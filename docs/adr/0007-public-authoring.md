# ADR 0007 — Public authoring surface

**Status:** Accepted. This does not add a sandbox.

## Decision

`src/foundations/index.ts` is the only import a module author should use. The package export `"."` points at that file. The other Foundations files are internal.

The barrel includes composition, dispatch, save, manifest checks, profiles, and the slot payload contract (`isCallablePayload`, `slotRequiresCallable`). `compose({ trust })` accepts only `trusted-in-process`.

`examples/starter-module` is a copyable package. It is not part of the proof composition and it is not discovered with the packaged modules. `validateManifest` accepts its manifest. `compose` loads it when a caller passes the package.

The console check runs `validateManifest` on pasted JSON. It does not import or execute an implementation. Code still enters through `compose`.

Permissions stay declared and unenforced. The template does not imply a boundary.

## Consequences

A module written against the barrel can be validated, loaded, and diagnosed without editing the host. A change inside an unexported file is not a break. A change to an exported type is.
