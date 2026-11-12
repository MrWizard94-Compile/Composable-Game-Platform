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

## Run the tests

```sh
node --experimental-strip-types --test \
  src/foundations/semver.test.ts \
  src/foundations/host.test.ts \
  src/modules/composition.test.ts
```

Headless proof:

```sh
node --experimental-strip-types src/modules/headless-demo.ts
```

## Layout

- `src/foundations` — host, manifest validator, semver, discovery. No gameplay vocabulary.
- `src/modules/*` — one folder per module: `manifest.json` and optional `module.ts`.
- `docs/adr` — language, slots, and trust decisions.
- `docs/STATUS.md` — what is real and what is not.

The browser console is a viewer. It calls the same `compose()` function. It is not a second implementation.

## Honest limits

Modules are trusted in-process code. Permissions are not enforced. Nothing here is sandboxed, saved, replicated, or hot-reloaded. See [docs/STATUS.md](docs/STATUS.md).
