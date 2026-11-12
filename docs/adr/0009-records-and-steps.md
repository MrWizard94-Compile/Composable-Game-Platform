# ADR 0009 — Records and caller-driven steps

**Status:** Accepted. These are modules. They are not a world simulation.

## Decision

World Core owns three service slots: spawn, remove, and list. World Store is the only provider. It keeps a list of `{ id, record }` and a save slice. A record is JSON. The host does not read it.

Step Core owns an advance service and a subscriber slot. Step Clock increments a count when that service is called. A separate caller publishes the result to listeners. Step Witness records the counts it hears. Nothing in this path schedules itself.

Physics, rendering, input, audio, networking, hot reload, permission enforcement, and resource limits are not provided by these modules.

## Consequences

A composition can remember entities and count steps. It still does not move, draw, or replicate them. The Foundations stay free of those words' behavior.
