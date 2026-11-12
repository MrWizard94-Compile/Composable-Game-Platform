import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callService, publish, runPipeline } from "./dispatch.ts";
import { compose as hostCompose, type ComposeOptions, type ModulePackage } from "./host.ts";
import { IN_PROCESS_POLICY } from "./backend.ts";

function compose(packages: readonly ModulePackage[], options: ComposeOptions = {}) {
  return hostCompose(packages, { policy: IN_PROCESS_POLICY, ...options });
}

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

const owner = pkg(
  moduleManifest("org.example.owner", {
    exposesSlots: [
      {
        slotId: "example.listeners",
        contract: "example.listener",
        contractVersion: "1.0.0",
        kind: "subscriber",
      },
      {
        slotId: "example.pipe",
        contract: "example.pipe",
        contractVersion: "1.0.0",
        kind: "pipeline",
      },
      {
        slotId: "example.box",
        contract: "example.box",
        contractVersion: "1.0.0",
        kind: "registry",
      },
    ],
  }),
);

describe("publish", () => {
  it("fans out in contribution order and keeps going after a throw", () => {
    const heard: string[] = [];
    const early = pkg(
      moduleManifest("org.example.early", {
        connectsTo: [{ slot: "example.listeners", contract: "example.listener/1" }],
      }),
      {
        register(ctx) {
          ctx.contribute("example.listeners", {
            id: "early",
            order: 1,
            payload: {
              handle(event: unknown) {
                heard.push(`early:${String((event as { n?: unknown }).n)}`);
              },
            },
          });
        },
      },
    );
    const boom = pkg(
      moduleManifest("org.example.boom", {
        connectsTo: [{ slot: "example.listeners", contract: "example.listener/1" }],
      }),
      {
        register(ctx) {
          ctx.contribute("example.listeners", {
            id: "boom",
            order: 2,
            payload() {
              throw new Error("listener refused");
            },
          });
        },
      },
    );
    const late = pkg(
      moduleManifest("org.example.late", {
        connectsTo: [{ slot: "example.listeners", contract: "example.listener/1" }],
      }),
      {
        register(ctx) {
          ctx.contribute("example.listeners", {
            id: "late",
            order: 3,
            payload: {
              handle() {
                heard.push("late");
              },
            },
          });
        },
      },
    );
    const result = compose([owner, late, boom, early]);
    const report = publish(result, "example.listeners", { n: 7 });
    assert.equal(report.ok, false);
    assert.deepEqual(heard, ["early:7", "late"]);
    assert.deepEqual(
      report.deliveries.map((item) => [item.contributionId, item.ok, item.code ?? ""]),
      [
        ["early", true, ""],
        ["boom", false, "dispatch.threw"],
        ["late", true, ""],
      ],
    );
    assert.equal(report.deliveries[1]?.message, "listener refused");
    assert.equal(result.runtimeActive, true);
  });

  it("refuses a registry slot and an inactive runtime without calling handlers", () => {
    let called = 0;
    const listener = pkg(
      moduleManifest("org.example.listener", {
        connectsTo: [
          { slot: "example.listeners", contract: "example.listener/1" },
          { slot: "example.box", contract: "example.box/1" },
        ],
      }),
      {
        register(ctx) {
          const mark = () => {
            called += 1;
          };
          ctx.contribute("example.listeners", { id: "ear", payload: mark });
          ctx.contribute("example.box", { id: "row", payload: mark });
        },
      },
    );
    const live = compose([owner, listener]);
    const wrong = publish(live, "example.box", {});
    assert.equal(wrong.ok, false);
    assert.match(wrong.reason ?? "", /registry/);
    assert.equal(called, 0);

    const dead = compose([
      pkg(
        moduleManifest("org.example.needy", {
          requires: [{ capability: "example.missing", version: "^1.0.0" }],
        }),
      ),
    ]);
    const refused = publish(dead, "example.listeners", {});
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "Runtime is not active.");
    assert.equal(called, 0);
  });

  it("does not call handlers after shutdown", () => {
    let called = 0;
    const listener = pkg(
      moduleManifest("org.example.listener", {
        connectsTo: [{ slot: "example.listeners", contract: "example.listener/1" }],
      }),
      {
        register(ctx) {
          ctx.contribute("example.listeners", {
            id: "ear",
            payload() {
              called += 1;
            },
          });
        },
      },
    );
    const live = compose([owner, listener]);
    live.shutdown();
    const report = publish(live, "example.listeners", {});
    assert.equal(report.ok, false);
    assert.equal(report.reason, "Runtime has shut down.");
    assert.equal(called, 0);
  });
});

describe("runPipeline", () => {
  it("folds in contribution order and ignores package order", () => {
    const scale = pkg(
      moduleManifest("org.example.scale", {
        connectsTo: [{ slot: "example.pipe", contract: "example.pipe/1" }],
      }),
      {
        register(ctx) {
          ctx.contribute("example.pipe", {
            id: "scale",
            order: 1,
            payload: {
              handle(value: unknown) {
                return typeof value === "number" ? value * 2 : value;
              },
            },
          });
        },
      },
    );
    const offset = pkg(
      moduleManifest("org.example.offset", {
        connectsTo: [{ slot: "example.pipe", contract: "example.pipe/1" }],
      }),
      {
        register(ctx) {
          ctx.contribute("example.pipe", {
            id: "offset",
            order: 2,
            payload(value: unknown) {
              return typeof value === "number" ? value + 3 : value;
            },
          });
        },
      },
    );
    const forward = runPipeline(compose([offset, owner, scale]), "example.pipe", 4);
    const reverse = runPipeline(compose([scale, owner, offset].reverse()), "example.pipe", 4);
    assert.equal(forward.ok, true);
    assert.equal(forward.output, 11);
    assert.equal(reverse.output, 11);
    assert.deepEqual(
      forward.stages.map((stage) => [stage.contributionId, stage.output]),
      [
        ["scale", 8],
        ["offset", 11],
      ],
    );
  });

  it("stops at a throw, a missing function, or an undefined return", () => {
    const keep = (id: string, order: number, payload: unknown) =>
      pkg(
        moduleManifest(`org.example.${id}`, {
          connectsTo: [{ slot: "example.pipe", contract: "example.pipe/1" }],
        }),
        {
          register(ctx) {
            ctx.contribute("example.pipe", { id, order, payload });
          },
        },
      );

    const thrown = runPipeline(
      compose([
        owner,
        keep("first", 1, (value: unknown) => (typeof value === "number" ? value + 1 : value)),
        keep("boom", 2, () => {
          throw new Error("stage refused");
        }),
        keep("later", 3, (value: unknown) => (typeof value === "number" ? value + 10 : value)),
      ]),
      "example.pipe",
      4,
    );
    assert.equal(thrown.ok, false);
    assert.equal(thrown.output, 5);
    assert.equal(thrown.stages.at(-1)?.code, "dispatch.threw");
    assert.equal(thrown.stages.some((stage) => stage.contributionId === "later"), false);

    const blank = runPipeline(
      compose([
        owner,
        keep("first", 1, (value: unknown) => value),
        keep("blank", 2, () => undefined),
      ]),
      "example.pipe",
      "seed",
    );
    assert.equal(blank.output, "seed");
    assert.equal(blank.stages.at(-1)?.code, "dispatch.undefined");

    const inert = compose([owner, keep("inert", 1, { note: true })]);
    assert.equal(inert.runtimeActive, false);
    assert.ok(inert.diagnostics.some((item) => item.code === "slot.contract"));
  });

  it("refuses a subscriber slot", () => {
    const result = compose([owner]);
    const report = runPipeline(result, "example.listeners", 1);
    assert.equal(report.ok, false);
    assert.match(report.reason ?? "", /subscriber/);
    assert.equal(report.output, 1);
  });
});

describe("callService", () => {
  const desk = pkg(
    moduleManifest("org.example.desk", {
      exposesSlots: [
        {
          slotId: "example.ask",
          contract: "example.answer",
          contractVersion: "1.0.0",
          kind: "service",
          required: false,
        },
      ],
    }),
  );

  function provider(id: string, payload: unknown) {
    return pkg(
      moduleManifest(id, {
        connectsTo: [{ slot: "example.ask", contract: "example.answer/1" }],
      }),
      {
        register(ctx) {
          ctx.contribute("example.ask", { id: id.split(".").at(-1) ?? id, payload });
        },
      },
    );
  }

  it("returns the one provider's value, including undefined", () => {
    const live = compose([
      desk,
      provider("org.example.names", {
        handle(input: unknown) {
          return { echo: input };
        },
      }),
    ]);
    const report = callService(live, "example.ask", "alpha");
    assert.equal(report.ok, true);
    assert.deepEqual(report.output, { echo: "alpha" });
    assert.equal(report.moduleId, "org.example.names");

    const blank = callService(compose([desk, provider("org.example.blank", () => undefined)]), "example.ask", 1);
    assert.equal(blank.ok, true);
    assert.equal(blank.output, undefined);
  });

  it("records a throw or a missing function and does not invent a value", () => {
    const thrown = callService(
      compose([
        desk,
        provider("org.example.boom", () => {
          throw new Error("service refused");
        }),
      ]),
      "example.ask",
      "alpha",
    );
    assert.equal(thrown.ok, false);
    assert.equal(thrown.code, "dispatch.threw");
    assert.equal(thrown.output, undefined);

    const inert = compose([desk, provider("org.example.inert", { note: true })]);
    assert.equal(inert.runtimeActive, false);
    assert.ok(inert.diagnostics.some((item) => item.code === "slot.contract"));
    assert.equal(callService(inert, "example.ask", 1).reason, "Runtime is not active.");
  });

  it("refuses an empty slot, the wrong kind, and a shut-down runtime", () => {
    const empty = callService(compose([desk]), "example.ask", "alpha");
    assert.equal(empty.ok, false);
    assert.match(empty.reason ?? "", /no provider/);

    const wrong = callService(compose([owner]), "example.listeners", "alpha");
    assert.match(wrong.reason ?? "", /subscriber/);

    const live = compose([desk, provider("org.example.names", () => "kept")]);
    live.shutdown();
    const after = callService(live, "example.ask", "alpha");
    assert.equal(after.reason, "Runtime has shut down.");
    assert.equal(after.output, undefined);
  });
});

