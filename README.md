# Composable Game Platform

A minimal host for independently packaged game systems. The Foundations know how to load, validate, order, and shut down modules. They do not know what a tree, a light, or a weapon is.

This repository is separate from STRATA.

## CGP browser console

Run the branded local console against a local content store and a project profile:

```sh
npm ci
npx playwright install chromium
npm run console -- --store ./out/cgp-store --staging ./out/staging --profile examples/project.json --lock ./out/local-project.cgp.lock.json
```

Open the loopback URL printed by the server (default `http://127.0.0.1:4173`). The console has separate views for the bundled examples, the local content store, and a configured project lockfile. It uses the real local catalog, verifies referenced object bytes, registers validated staging snapshots, creates an immutable project lock from exact profile pins, and resolves that lock only when the profile, catalog entries, and stored package bytes all match.

### Prepare the example project packages

The sample project pins one Wasm package and one JavaScript ESM package. Build their release and staging snapshots:

```sh
node --experimental-strip-types scripts/build-module-package.ts --source examples/third-party-module --release ./out/releases/beacon-1.0.0 --stage ./out/staging/beacon-1.0.0
node --experimental-strip-types scripts/build-module-package.ts --source examples/starter-module --release ./out/releases/starter-1.0.0 --stage ./out/staging/starter-1.0.0
```

Then start the console using the command above. In **Package Store**, register the two validated staging snapshots. Run **Verify all objects** to revalidate the bytes. In **Project**, generate the project lockfile, then use **Verify & resolve lock** to check each exact pin against the catalog and the content-addressed object.

For an existing project, replace `examples/project.json` with your project profile and pass its path to `--profile`. Select an explicit output path with `--lock`. An existing lockfile is never overwritten by Generate; use the separate Update action when you intentionally want to refresh its recorded identities.

The local API binds only to `127.0.0.1`, accepts same-origin browser writes, limits request size, and only accepts staging directory names below the configured staging root. The browser never receives arbitrary filesystem paths for use as requests.

**Runtime boundary:** the browser console's lock resolver validates and returns exact package object locations and identities; the console does not dynamically load or execute packages from the local store, and its Composition view still exercises the bundled proof modules. Node host code can separately call `activateWasmProject()` from `src/packages/wasm-activation.ts` to activate a complete exact Wasm-only lock after all package bytes have been verified and snapshotted. That adapter uses the existing `wasm-isolate` backend and requires the caller to shut the composition down. JavaScript ESM and mixed-runtime activation are not supported; JavaScript package artifacts remain trusted-in-process code and are not sandboxed.

Useful options:

- `--store <directory>` selects the local content store (default: `.cgp-store`).
- `--staging <directory>` enables registration from validated staged package subdirectories.
- `--profile <file>` selects the exact-version project profile.
- `--lock <file>` selects the generated project lockfile.
- `--port <number>` changes the loopback port.

The project lock tooling is also available from the command line:

```sh
npm run project:lock -- --profile examples/project.json --store ./out/cgp-store --output ./out/local-project.cgp.lock.json
npm run project:check -- --profile examples/project.json --lock ./out/local-project.cgp.lock.json --store ./out/cgp-store
```

## Local retention and garbage-collection preview

Registering a validated staging package creates a persistent local-import pin by default. Removing that pin does not remove catalog metadata or package bytes; it only makes the object eligible for consideration once every other retention root is gone.

Pin the exact packages in a project lock:

```sh
npm run store:retention -- --store ./out/cgp-store --action pin-project --project-id my-game --lock ./out/local-project.cgp.lock.json
```

Remove a project pin or local-import pin explicitly:

```sh
npm run store:retention -- --store ./out/cgp-store --action unpin-project --project-id my-game
npm run store:retention -- --store ./out/cgp-store --action unpin-local --digest sha256:<package-tree-digest>
```

A local pin can be restored with `--action pin-local`. Project IDs are stable operator-chosen identifiers; the store does not scan arbitrary project directories or infer pins from lockfiles it cannot see.

Preview verified, unreferenced package objects without changing lifecycle state or deleting them:

```sh
npm run store:gc-preview -- --store ./out/cgp-store --dry-run --grace-hours 24
```

The preview verifies package-tree digests, reports byte sizes, age and release associations, checks local/project pins, and applies the configured grace period. Catalog release metadata is not itself a retention root: an explicitly unpinned release may remain known in the catalog after its content is eventually collected. A dry run creates only its temporary reader-coordination marker; it does not write lifecycle metadata, create deletion claims, or delete package objects. The CLI has no apply mode.

A guarded deletion-claim primitive can mark an unpinned, verified, old object as `deleting`, preventing new readers and pins. It does not remove bytes; a matching token can release an unapplied claim. Actual deletion, tombstones, interruption recovery, and automatic stale-claim reconciliation remain future work.

See [the CGP visual identity guide](assets/brand/README.md) for marks, icons, palette, and component usage.

## Proof

```text
Foundations
└── platform.systems          registry, opaque payloads
    ├── Flora Core
    │   ├── flora.plant-species    registry
    │   │   └── Forest Plants      oak, pine, fern
    │   └── flora.growth-model     policy, exactly one
    │       └── Seasonal Growth
    └── Lighting Core
        └── lighting.sources       registry
            ├── Point Lights
            └── Directional Lights
```

Forest Plants is a separate folder from Flora Core. A test also connects a module that exists only in the test file. Enabling a second growth policy refuses the composition instead of picking a winner. Reversing input order does not change the fingerprint.

Signals Core is another package on the same platform slot. It owns a subscriber slot and a pipeline slot. `publish` calls every listener in contribution order and continues after a throw. `runPipeline` folds a value and stops at the first failure. Nothing runs until a caller asks. There is no tick.

Pulse Count listens on that same slot and owns a save slice. `captureSave` asks it for JSON. `restoreSave` hands a slice back only when the major version matches. The host does not interpret the number. After `shutdown()`, dispatch and save refuse.

Query Core owns a service slot. `callService` invokes the one provider and returns its value unchanged. A second provider makes the slot ambiguous, and neither function is called.

Simulation Core is another package on the same platform slot. It owns a pipeline of systems and a ledger those systems do not write. A caller outside the host requests one integer step. Movement proposes positions. A WebAssembly boundary clamps them. The ledger changes only when the whole step is accepted. Save and restore repeat the rest of a run. Nothing in that path schedules itself.

## Run the tests

```sh
npm ci
npx playwright install chromium
node --experimental-strip-types scripts/build-wasm-module.ts
node --experimental-strip-types scripts/verify-wasm.ts
npm test
npx tsc -p tsconfig.foundations.json --noEmit
node --experimental-strip-types scripts/browser-wasm.ts
npm run console:check
```

`npm ci` installs the development dependencies in `package.json`: TypeScript, `@types/node`, esbuild, and Playwright. Chromium is installed after that, and the typecheck runs only once those packages are present.

Headless proof:

```sh
node --experimental-strip-types src/modules/headless-demo.ts
```

## Layout

- `src/foundations` — host, manifest validator, semver, discovery. Import the barrel, `src/foundations/index.ts`, from a module.
- `src/packages` — Node-side release validation, staging, local content storage, catalog, project locks, verified snapshots, and the one-shot Wasm activation adapter. It is not part of the Foundations runtime.
- `src/modules/*` — packaged proofs. One folder per module.
- `apps/console` — maintained branded browser console.
- `examples/project.json` — sample local-store project profile.
- `examples/starter-module` — a copyable JavaScript package. See [docs/authoring.md](docs/authoring.md).
- `examples/wasm-module` — a copyable WebAssembly guest. `module.wasm` only.
- `examples/third-party-module` — a Wasm guest authored as `guest.json` and carrying a v1 release descriptor. Another toolchain can omit `guest.json` and still be checked.
- `examples/javascript-module` — a self-contained JavaScript ESM v1 release example.
- `profiles/*.json` — bundled composition pins. A different packaged version refuses the selection. The host does not upgrade.
- `assets/brand` — CGP logo, platform mark, app icon, favicon, reusable concept icons, design tokens, and UI reference. See [the visual identity guide](assets/brand/README.md).
- `docs/adr` — language, slots, and trust decisions.
- `docs/STATUS.md` — what is real and what is not.

The console is a browser-facing control surface. It calls the same `compose()` function as the headless host for bundled proofs; local lock resolution is separate Node-side package tooling.

## Honest limits

Discovery reads manifests and WebAssembly bytes and does not import or instantiate. The in-process backend cannot revoke filesystem, network, or operating-system access, and cannot enforce time or memory limits. The Wasm isolate enforces its import allow-list and configured budgets. Save slices are plain JSON and restore across those backends. A world module can store entity records, and a step counts only when a caller asks. A simulation runner, also outside the host, can ask several systems to share one integer step. The ledger refuses an out-of-range, stale, or unopened commit, and a failed step does not publish. Nothing here is a renderer, a physics engine, or a clock that runs itself. See [docs/STATUS.md](docs/STATUS.md) and [docs/abi.md](docs/abi.md).
