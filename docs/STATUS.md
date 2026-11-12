# Status

Milestone 1 through the nested-composition proof. Working, not a game.

## Implemented

- JSON manifests, closed schema, semantic versions and ranges.
- Discovery of module folders on disk, and the same packages bundled for the console.
- API compatibility, required and optional capability dependencies, duplicate ids.
- Slots: singleton, policy, registry, pipeline, subscriber, service.
- Module-owned slots. A child package connects without changing the parent or the host.
- Cycle detection, depth limit 8, deterministic order, conflict and ambiguity refusal.
- Transactional failure: bad manifests are isolated; graph failures and init exceptions roll back.
- Headless demo and the browser console over one `compose()` function.
- Flora proof (species registry + one growth policy) and Lighting proof (source registry) on the same platform slot.

## Not implemented

- Sandbox, resource limits, package signing.
- Permission enforcement. Declarations are stored and ignored.
- Save data, migrations, networking, replication.
- Hot reload, a frame loop, rendering, input, audio.
- Event fan-out for subscriber slots. Contributions are ordered and stored only.
- A world, entities, or any gameplay rule inside the Foundations.

## Provisional

- Manifest field names and the six slot kinds.
- Foundations API `1.0.0` and max depth 8.
- In-process trusted modules as the only execution mode.
- Contract compatibility is major-version equality, or exact equality when the connection names a full version.
