# ADR 0005 — Module-owned saves

**Status:** Accepted. This is not a world format and not a migration framework.

## Decision

A module may declare `save: { version }` with an exact semantic version. The host does not invent a save for a module that omits it.

`keep(state)` during register stores one value on that composition, not on the module singleton. `exportState` returns JSON. `importState` receives a slice and may mutate the kept value. The host JSON-clones the export and refuses values that do not survive `JSON.stringify`.

`captureSave` walks the active order and records one slice per declaring module. `restoreSave` writes slices back.

Restore rules:

- The document's Foundations API major must match this host. Otherwise nothing is applied.
- A slice major must match the major the module declares now. `1.1.0` may load into a module that declares `1.0.0`. `2.0.0` is refused and that module's current state stays.
- A missing slice is a warning. The module keeps what it has.
- A slice for a module that is not active is a warning and is not read.
- One module's failure does not roll back slices already applied. The report says which ones landed.

`shutdown()` marks the result quiesced. Capture, restore, `publish`, and `runPipeline` then refuse. The contribution list is still readable.

The console may hold the document in browser storage. That store is not part of the host.

## Consequences

Pulse Count can remember how many pulses it saw without the host knowing what a pulse count means. A future module that changes its save major must refuse old slices until it ships an `importState` that understands them. The host will not guess.
