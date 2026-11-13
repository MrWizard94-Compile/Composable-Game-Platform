# ADR 0013 — Portable-module toolchain and licenses

**Status:** Accepted.

## Decision

The repository is MIT, including the copyable examples and the first-party modules. `LICENSE` is the text. A module's `license` field, when present, must be an SPDX expression (`MIT`, `Apache-2.0`, `MIT OR Apache-2.0`) or `LicenseRef-Proprietary`. The placeholder "Not yet licensed" is a validation error. The host checks the shape. It does not fetch license text and it does not grant rights to a guest on the author's behalf. Omitting the field is still allowed for a package that has not chosen, but the examples and the modules in this repository set `MIT`.

A portable module is produced, not hand-edited. `scripts/build-wasm-module.ts` writes `examples/wasm-module/module.wasm` from `templateGuest()` and writes Dune Growth's `module.wasm` and `bytes.ts` from `duneGrowthGuest()`. `scripts/verify-wasm.ts` fails when those bytes drift. The foundations workflow runs that check, the host tests, the browser-isolate tests, and `tsc -p tsconfig.foundations.json` on Node 22.

## Consequences

Copying `examples/wasm-module` or `examples/starter-module` is permitted under MIT. An author who changes the copied manifest's `license` is stating their own terms. A binary that does not match the generator is a failed build, not a guest the host will treat as source.
