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
node --experimental-strip-types --test \
  src/foundations/semver.test.ts \
  src/foundations/host.test.ts \
  src/foundations/dispatch.test.ts \
  src/foundations/save.test.ts \
  src/foundations/authoring.test.ts \
  src/foundations/profile.test.ts \
  src/modules/composition.test.ts
```

Headless proof:

```sh
node --experimental-strip-types src/modules/headless-demo.ts
```

## Layout

- `src/foundations` — host, manifest validator, semver, discovery. Import the barrel, `src/foundations/index.ts`, from a module.
- `src/modules/*` — packaged proofs. One folder per module.
- `examples/starter-module` — a copyable package. See [docs/authoring.md](docs/authoring.md).
- `profiles/*.json` — composition pins. A different packaged version refuses the chip. The host does not upgrade.
- `docs/adr` — language, slots, and trust decisions.
- `docs/STATUS.md` — what is real and what is not.

The browser console is a viewer. It calls the same `compose()` function. It is not a second implementation.

## Honest limits

Modules run only as `trusted-in-process` code. Asking for any other execution trust refuses the composition before module code runs. Permissions are not enforced. Nothing here is sandboxed, replicated, or hot-reloaded. A save is JSON a module exports. The composition fingerprint includes module versions, slot contracts, and contribution order. See [docs/STATUS.md](docs/STATUS.md).
