import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { compose, FOUNDATIONS_API, PLATFORM_SLOTS, type ModulePackage } from "./host.ts";
import { validateManifest } from "./manifest.ts";

const here = dirname(fileURLToPath(import.meta.url));

function pkg(manifest: unknown, register?: ModulePackage["implementation"]): ModulePackage {
  return { manifest, implementation: register };
}

function moduleManifest(id: string, extra: Record<string, unknown> = {}) {
  return {
    moduleId: id,
    name: id.split(".").at(-1) ?? id,
    version: "1.0.0",
    moduleApi: ">=1.0.0 <2.0.0",
    ...extra,
  };
}

function codes(result: { diagnostics: Array<{ code: string }> }): string[] {
  return result.diagnostics.filter((item) => item).map((item) => item.code);
}

describe("foundations stay free of gameplay", () => {
  it("does not name a genre system in the host sources", () => {
    const banned = ["flora", "fauna", "plant", "oak", "pine", "fern", "lighting", "combat", "crafting", "weapon"];
    for (const file of readdirSync(here)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const text = readFileSync(join(here, file), "utf8").toLowerCase();
      for (const word of banned) {
        assert.equal(text.includes(word), false, `${file} contains "${word}"`);
      }
    }
  });

  it("exposes one generic system registry and nothing domain-specific", () => {
    assert.deepEqual(
      PLATFORM_SLOTS.map((slot) => slot.slotId),
      ["platform.systems"],
    );
    assert.equal(FOUNDATIONS_API, "1.0.0");
  });
});

describe("manifest validation", () => {
  it("rejects an inexact version and an unknown field", () => {
    const result = validateManifest({
      moduleId: "org.example.broken",
      name: "Broken",
      version: "1.0",
      moduleApi: ">=1.0.0 <2.0.0",
      extra: true,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.some((error) => error.path === "version"));
    assert.ok(result.errors.some((error) => error.message.includes("extra")));
  });

  it("rejects a self-owned slot connection", () => {
    const result = validateManifest(
      moduleManifest("org.example.loop", {
        exposesSlots: [
          {
            slotId: "example.box",
            contract: "example.box",
            contractVersion: "1.0.0",
            kind: "registry",
          },
        ],
        connectsTo: [{ slot: "example.box", contract: "example.box/1" }],
      }),
    );
    assert.equal(result.ok, false);
  });
});

describe("composition", () => {
  it("activates an empty profile", () => {
    const result = compose([]);
    assert.equal(result.runtimeActive, true);
    assert.equal(result.ok, true);
    assert.equal(result.order.length, 0);
    assert.equal(result.slots[0]?.slotId, "platform.systems");
  });

  it("isolates a bad package without dropping a valid neighbor", () => {
    const good = pkg(
      moduleManifest("org.example.good", {
        connectsTo: [{ slot: "platform.systems", contract: "platform.system/1" }],
      }),
      {
        register(ctx) {
          ctx.contribute("platform.systems", { id: "good", payload: { ok: true } });
        },
      },
    );
    const bad = pkg({ moduleId: "org.example.bad", name: "Bad", version: "1.0", moduleApi: ">=1.0.0 <2.0.0" });
    const result = compose([bad, good]);
    assert.equal(result.runtimeActive, true);
    assert.equal(result.ok, false);
    assert.equal(result.modules.find((item) => item.moduleId === "org.example.good")?.status, "active");
    assert.equal(result.modules.find((item) => item.moduleId === "org.example.bad")?.status, "rejected");
    assert.equal(result.contributions.some((item) => item.id === "good"), true);
  });

  it("isolates a module built for a future host API", () => {
    const result = compose([
      pkg(moduleManifest("org.example.future", { moduleApi: ">=2.0.0 <3.0.0" })),
    ]);
    assert.equal(result.runtimeActive, true);
    assert.ok(codes(result).includes("api.incompatible"));
    assert.equal(result.modules[0]?.status, "rejected");
  });

  it("refuses duplicate module ids", () => {
    const manifest = moduleManifest("org.example.twin");
    const result = compose([pkg(manifest), pkg(manifest)]);
    assert.ok(codes(result).includes("module.duplicate"));
    assert.equal(
      result.modules.every((item) => item.status === "rejected"),
      true,
    );
  });

  it("does not treat declared permissions as a sandbox", () => {
    const result = compose([
      pkg(moduleManifest("org.example.trusted", { permissions: ["world.read"] })),
    ]);
    assert.equal(result.runtimeActive, true);
    assert.equal(codes(result).some((code) => code.startsWith("permission")), false);
    assert.deepEqual(result.modules[0]?.permissions, ["world.read"]);
  });

  it("conflicts a singleton and an ambiguous service instead of choosing", () => {
    const owner = pkg(
      moduleManifest("org.example.owner", {
        exposesSlots: [
          {
            slotId: "example.only",
            contract: "example.only",
            contractVersion: "1.0.0",
            kind: "singleton",
          },
          {
            slotId: "example.service",
            contract: "example.service",
            contractVersion: "1.0.0",
            kind: "service",
          },
        ],
      }),
    );
    const left = pkg(
      moduleManifest("org.example.left", {
        connectsTo: [
          { slot: "example.only", contract: "example.only/1" },
          { slot: "example.service", contract: "example.service/1.0.0" },
        ],
      }),
    );
    const right = pkg(
      moduleManifest("org.example.right", {
        connectsTo: [
          { slot: "example.only", contract: "example.only/1" },
          { slot: "example.service", contract: "example.service/1" },
        ],
      }),
    );
    const result = compose([right, owner, left]);
    assert.equal(result.runtimeActive, false);
    assert.ok(codes(result).includes("slot.conflict"));
    assert.ok(codes(result).includes("slot.ambiguous"));
    assert.equal(result.contributions.length, 0);
    const only = result.slots.find((slot) => slot.slotId === "example.only");
    assert.deepEqual(only?.contestedBy, ["org.example.left", "org.example.right"]);
    assert.deepEqual(only?.contributors, []);
  });

  it("refuses two capability providers and accepts a named pin", () => {
    const left = pkg(
      moduleManifest("org.example.left", { provides: [{ capability: "example.marker", version: "1.0.0" }] }),
    );
    const right = pkg(
      moduleManifest("org.example.right", { provides: [{ capability: "example.marker", version: "1.0.0" }] }),
    );
    const open = pkg(
      moduleManifest("org.example.use", { requires: [{ capability: "example.marker", version: "^1.0.0" }] }),
    );
    const ambiguous = compose([right, open, left]);
    assert.equal(ambiguous.runtimeActive, false);
    assert.ok(codes(ambiguous).includes("dependency.ambiguous"));
    assert.equal(ambiguous.contributions.length, 0);
    assert.deepEqual(ambiguous.dependencies, []);

    const optional = compose([
      left,
      right,
      pkg(
        moduleManifest("org.example.use", {
          requires: [{ capability: "example.marker", version: "^1.0.0", optional: true }],
        }),
      ),
    ]);
    assert.equal(optional.runtimeActive, false);
    assert.ok(codes(optional).includes("dependency.ambiguous"));

    const pinned = compose([
      right,
      left,
      pkg(
        moduleManifest("org.example.use", {
          requires: [{ capability: "example.marker", version: "^1.0.0", moduleId: "org.example.left" }],
        }),
      ),
    ]);
    assert.equal(pinned.runtimeActive, true);
    assert.ok(pinned.order.indexOf("org.example.left") < pinned.order.indexOf("org.example.use"));
    assert.deepEqual(pinned.dependencies, [
      {
        providerId: "org.example.left",
        dependentId: "org.example.use",
        kind: "capability",
        ref: "example.marker",
      },
    ]);

    const newer = pkg(
      moduleManifest("org.example.right", {
        version: "2.0.0",
        provides: [{ capability: "example.marker", version: "2.0.0" }],
      }),
    );
    const onlyLeft = compose([newer, open, left]);
    assert.equal(onlyLeft.runtimeActive, true);
    assert.equal(codes(onlyLeft).includes("dependency.ambiguous"), false);
  });

  it("orders pipeline contributions by order, then module id", () => {
    const owner = pkg(
      moduleManifest("org.example.owner", {
        exposesSlots: [
          {
            slotId: "example.pipe",
            contract: "example.pipe",
            contractVersion: "1.0.0",
            kind: "pipeline",
          },
        ],
      }),
    );
    const late = pkg(
      moduleManifest("org.example.late", {
        connectsTo: [{ slot: "example.pipe", contract: "example.pipe/1" }],
      }),
      {
        register(ctx) {
          ctx.contribute("example.pipe", { id: "late", order: 10, payload: { n: 10 } });
        },
      },
    );
    const early = pkg(
      moduleManifest("org.example.early", {
        connectsTo: [{ slot: "example.pipe", contract: "example.pipe/1" }],
      }),
      {
        register(ctx) {
          ctx.contribute("example.pipe", { id: "early", order: 2, payload: { n: 2 } });
        },
      },
    );
    const tiedB = pkg(
      moduleManifest("org.example.tiedb", {
        connectsTo: [{ slot: "example.pipe", contract: "example.pipe/1" }],
      }),
      {
        register(ctx) {
          ctx.contribute("example.pipe", { id: "bee", order: 2, payload: { n: 2 } });
        },
      },
    );
    const forward = compose([late, tiedB, owner, early]);
    const reverse = compose([early, owner, tiedB, late].reverse());
    assert.equal(forward.runtimeActive, true);
    assert.deepEqual(
      forward.contributions.map((item) => item.id),
      ["early", "bee", "late"],
    );
    assert.equal(forward.fingerprint, reverse.fingerprint);
  });

  it("keeps every subscriber", () => {
    const owner = pkg(
      moduleManifest("org.example.owner", {
        exposesSlots: [
          {
            slotId: "example.events",
            contract: "example.events",
            contractVersion: "1.0.0",
            kind: "subscriber",
          },
        ],
      }),
    );
    const make = (id: string) =>
      pkg(
        moduleManifest(id, {
          connectsTo: [{ slot: "example.events", contract: "example.events/1" }],
        }),
        {
          register(ctx) {
            ctx.contribute("example.events", { id: id.split(".").at(-1) ?? id, payload: { id } });
          },
        },
      );
    const result = compose([make("org.example.zeta"), owner, make("org.example.able")]);
    assert.equal(result.runtimeActive, true);
    assert.deepEqual(
      result.slots.find((slot) => slot.slotId === "example.events")?.contributors,
      ["org.example.able", "org.example.zeta"],
    );
  });

  it("refuses a required slot with no provider", () => {
    const result = compose([
      pkg(
        moduleManifest("org.example.owner", {
          exposesSlots: [
            {
              slotId: "example.needed",
              contract: "example.needed",
              contractVersion: "1.0.0",
              kind: "policy",
              required: true,
            },
          ],
        }),
      ),
    ]);
    assert.equal(result.runtimeActive, false);
    assert.ok(codes(result).includes("slot.missing"));
  });

  it("refuses an unsatisfied dependency and accepts an optional one", () => {
    const missing = compose([
      pkg(
        moduleManifest("org.example.needy", {
          requires: [{ capability: "example.missing", version: "^1.0.0" }],
        }),
      ),
    ]);
    assert.equal(missing.runtimeActive, false);
    assert.ok(codes(missing).includes("dependency.unsatisfied"));

    const optional = compose([
      pkg(
        moduleManifest("org.example.soft", {
          requires: [{ capability: "example.missing", version: "^1.0.0", optional: true }],
        }),
      ),
    ]);
    assert.equal(optional.runtimeActive, true);
    assert.equal(optional.ok, true);
    assert.ok(optional.diagnostics.some((item) => item.code === "dependency.optional-missing"));
  });

  it("rejects a contract major mismatch and an unknown slot", () => {
    const owner = pkg(
      moduleManifest("org.example.owner", {
        provides: [{ capability: "example.core", version: "1.0.0" }],
        exposesSlots: [
          {
            slotId: "example.box",
            contract: "example.box",
            contractVersion: "1.0.0",
            kind: "registry",
          },
        ],
      }),
    );
    const mismatch = compose([
      owner,
      pkg(
        moduleManifest("org.example.child", {
          requires: [{ capability: "example.core", version: "^1.0.0" }],
          connectsTo: [{ slot: "example.box", contract: "example.box/2" }],
        }),
      ),
    ]);
    assert.equal(mismatch.runtimeActive, false);
    assert.ok(codes(mismatch).includes("slot.contract-mismatch"));

    const unknown = compose([
      pkg(
        moduleManifest("org.example.lost", {
          connectsTo: [{ slot: "example.missing", contract: "example.missing/1" }],
        }),
      ),
    ]);
    assert.ok(codes(unknown).includes("slot.unknown"));
  });

  it("reports a dependency cycle and does not initialize either side", () => {
    const events: string[] = [];
    const result = compose([
      pkg(
        moduleManifest("org.example.alpha", {
          provides: [{ capability: "example.alpha", version: "1.0.0" }],
          requires: [{ capability: "example.beta", version: "^1.0.0" }],
        }),
        { initialize() { events.push("alpha"); } },
      ),
      pkg(
        moduleManifest("org.example.beta", {
          provides: [{ capability: "example.beta", version: "1.0.0" }],
          requires: [{ capability: "example.alpha", version: "^1.0.0" }],
        }),
        { initialize() { events.push("beta"); } },
      ),
    ]);
    assert.equal(result.runtimeActive, false);
    assert.ok(codes(result).includes("dependency.cycle"));
    assert.deepEqual(events, []);
    assert.match(result.diagnostics.find((item) => item.code === "dependency.cycle")?.message ?? "", /alpha/);
  });

  it("rejects nesting past the depth limit and accepts a shallow chain", () => {
    const chain = (depth: number): ModulePackage[] => {
      const packages: ModulePackage[] = [];
      for (let level = 1; level <= depth; level += 1) {
        const id = `org.example.level${String(level).padStart(2, "0")}`;
        const exposes =
          level < depth
            ? [
                {
                  slotId: `chain.level${String(level).padStart(2, "0")}`,
                  contract: `chain.level${String(level).padStart(2, "0")}`,
                  contractVersion: "1.0.0",
                  kind: "registry" as const,
                },
              ]
            : [];
        const slot =
          level === 1
            ? "platform.systems"
            : `chain.level${String(level - 1).padStart(2, "0")}`;
        const contract = level === 1 ? "platform.system/1" : `${slot}/1`;
        packages.push(
          pkg(
            moduleManifest(id, {
              name: `Level ${level}`,
              exposesSlots: exposes,
              connectsTo: [{ slot, contract }],
            }),
            {
              register(ctx) {
                ctx.contribute(slot, { id: `node-${level}`, payload: { level } });
              },
            },
          ),
        );
      }
      return packages;
    };

    const tooDeep = compose(chain(9));
    assert.equal(tooDeep.runtimeActive, false);
    assert.ok(codes(tooDeep).includes("slot.depth"));

    const shallow = compose(chain(2));
    assert.equal(shallow.runtimeActive, true);
    assert.equal(shallow.contributions.some((item) => item.id === "node-2"), true);
  });

  it("lets a separately defined child connect to a parent slot", () => {
    const seen: unknown[] = [];
    const parent = pkg(
      moduleManifest("org.example.parent", {
        provides: [{ capability: "example.core", version: "1.0.0" }],
        connectsTo: [{ slot: "platform.systems", contract: "platform.system/1" }],
        exposesSlots: [
          {
            slotId: "example.records",
            contract: "example.records",
            contractVersion: "1.0.0",
            kind: "registry",
          },
        ],
      }),
      {
        register(ctx) {
          ctx.contribute("platform.systems", { id: "parent", payload: { role: "parent" } });
        },
        initialize(ctx) {
          seen.push(ctx.ownedSlot("example.records")?.map((item) => item.id) ?? null);
          seen.push(ctx.ownedSlot("platform.systems") ?? null);
        },
      },
    );
    const child = pkg(
      moduleManifest("community.example.mangrove", {
        requires: [{ capability: "example.core", version: "^1.0.0" }],
        connectsTo: [{ slot: "example.records", contract: "example.records/1" }],
      }),
      {
        register(ctx) {
          ctx.contribute("example.records", { id: "mangrove", payload: { name: "Mangrove" } });
        },
      },
    );
    const result = compose([child, parent]);
    assert.equal(result.ok, true);
    assert.deepEqual(seen, [["mangrove"], null]);
    assert.equal(
      result.contributions.find((item) => item.slotId === "example.records")?.moduleId,
      "community.example.mangrove",
    );
  });

  it("rolls back when initialize throws and shuts down in reverse registration order", () => {
    const events: string[] = [];
    const make = (id: string, boom = false): ModulePackage =>
      pkg(
        moduleManifest(id, {
          connectsTo: [{ slot: "platform.systems", contract: "platform.system/1" }],
        }),
        {
          register(ctx) {
            events.push(`register:${id}`);
            ctx.contribute("platform.systems", { id: id.split(".").at(-1) ?? id, payload: { id } });
          },
          initialize() {
            events.push(`init:${id}`);
            if (boom) throw new Error("boom");
          },
          shutdown() {
            events.push(`shutdown:${id}`);
          },
        },
      );
    const result = compose([
      make("org.example.later"),
      make("org.example.boom", true),
      make("org.example.alpha"),
    ]);
    assert.equal(result.runtimeActive, false);
    assert.equal(result.contributions.length, 0);
    assert.ok(result.diagnostics.some((item) => item.message.includes("boom")));
    assert.deepEqual(events, [
      "register:org.example.alpha",
      "register:org.example.boom",
      "register:org.example.later",
      "init:org.example.alpha",
      "init:org.example.boom",
      "shutdown:org.example.later",
      "shutdown:org.example.alpha",
    ]);
  });

  it("shuts a live composition down in reverse order, once", () => {
    const events: string[] = [];
    const make = (id: string) =>
      pkg(moduleManifest(id), {
        initialize() {
          events.push(`init:${id}`);
        },
        shutdown() {
          events.push(`shutdown:${id}`);
        },
      });
    const result = compose([make("org.example.beta"), make("org.example.alpha")]);
    assert.equal(result.quiesced, false);
    const first = result.shutdown();
    const second = result.shutdown();
    assert.deepEqual(first.order, ["org.example.beta", "org.example.alpha"]);
    assert.equal(first.already, false);
    assert.equal(second.already, true);
    assert.equal(result.quiesced, true);
    assert.deepEqual(events, [
      "init:org.example.alpha",
      "init:org.example.beta",
      "shutdown:org.example.beta",
      "shutdown:org.example.alpha",
    ]);
  });

  it("rejects a contribution to a slot the module did not declare", () => {
    const result = compose([
      pkg(
        moduleManifest("org.example.sneaky", {
          connectsTo: [{ slot: "platform.systems", contract: "platform.system/1" }],
        }),
        {
          register(ctx) {
            ctx.contribute("example.other", { id: "nope", payload: { n: 1 } });
          },
        },
      ),
    ]);
    assert.equal(result.runtimeActive, false);
    assert.ok(codes(result).includes("slot.undeclared"));
  });

  it("rejects two contributions that share an id in one registry", () => {
    const owner = pkg(
      moduleManifest("org.example.owner", {
        exposesSlots: [
          {
            slotId: "example.box",
            contract: "example.box",
            contractVersion: "1.0.0",
            kind: "registry",
          },
        ],
      }),
    );
    const make = (id: string) =>
      pkg(
        moduleManifest(id, {
          connectsTo: [{ slot: "example.box", contract: "example.box/1" }],
        }),
        {
          register(ctx) {
            ctx.contribute("example.box", { id: "same", payload: { id } });
          },
        },
      );
    const result = compose([owner, make("org.example.left"), make("org.example.right")]);
    assert.equal(result.runtimeActive, false);
    assert.ok(codes(result).includes("slot.duplicate-contribution"));
    assert.equal(result.contributions.length, 0);
  });
});
