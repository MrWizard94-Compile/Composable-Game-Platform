# Composable Game Platform

A minimal host for independently packaged game systems. The Foundations know how to load, validate, order, and shut down modules. They do not know what a tree, a light, or a weapon is.

This repository is separate from STRATA.

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

## Run the tests

```sh
node --experimental-strip-types scripts/build-wasm-module.ts
node --experimental-strip-types scripts/verify-wasm.ts
node --experimental-strip-types --test \
  src/foundations/semver.test.ts \
  src/foundations/host.test.ts \
  src/foundations/dispatch.test.ts \
  src/foundations/save.test.ts \
  src/foundations/authoring.test.ts \
  src/foundations/profile.test.ts \
  src/foundations/isolation.test.ts \
  src/foundations/browser-isolation.test.ts \
  src/foundations/browser-wasm.test.ts \
  src/foundations/stress.test.ts \
  src/modules/composition.test.ts
npx tsc -p tsconfig.foundations.json --noEmit
node --experimental-strip-types scripts/check-wasm-module.ts examples/third-party-module
node --experimental-strip-types scripts/browser-wasm.ts
```

Headless proof:

```sh
node --experimental-strip-types src/modules/headless-demo.ts
```

## Layout

- `src/foundations` — host, manifest validator, semver, discovery. Import the barrel, `src/foundations/index.ts`, from a module.
- `src/modules/*` — packaged proofs. One folder per module.
- `examples/starter-module` — a copyable JavaScript package. See [docs/authoring.md](docs/authoring.md).
- `examples/wasm-module` — a copyable WebAssembly guest. `module.wasm` only.
- `examples/third-party-module` — a guest authored as `guest.json`. Another toolchain can omit that file and still be checked.
- `profiles/*.json` — composition pins. A different packaged version refuses the chip. The host does not upgrade.
- `docs/adr` — language, slots, and trust decisions.
- `docs/STATUS.md` — what is real and what is not.

The browser console is a viewer. It calls the same `compose()` function. It is not a second implementation.

## Honest limits

Discovery reads manifests and WebAssembly bytes. It does not import or instantiate module code. Guests run through the `wasm-isolate` backend: one worker and one memory each, a maximum memory, a time limit that stops the isolate, and no filesystem, network, or operating-system imports. The in-process backend still runs only as an explicit opt-in and cannot enforce those limits. Save slices are plain JSON and restore across those backends. A world module can store entity records, and a step counts only when a caller asks. Nothing here is a renderer, a physics engine, or a tick that runs itself. See [docs/STATUS.md](docs/STATUS.md) and [docs/abi.md](docs/abi.md).
