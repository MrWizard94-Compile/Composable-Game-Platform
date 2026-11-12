import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compose, type ModulePackage } from "./host.ts";
import { captureSave, restoreSave } from "./save.ts";

function pkg(manifest: unknown, implementation?: ModulePackage["implementation"]): ModulePackage {
  return { manifest, implementation };
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

function counter(id: string, saveVersion = "1.0.0") {
  return pkg(
    moduleManifest(id, {
      save: { version: saveVersion },
      connectsTo: [{ slot: "example.listeners", contract: "example.listener/1" }],
    }),
    {
      register(ctx) {
        const state = { n: 0 };
        ctx.keep(state);
        ctx.contribute("example.listeners", {
          id: id.split(".").at(-1) ?? id,
          payload() {
            state.n += 1;
          },
        });
      },
      exportState(ctx) {
        const state = ctx.kept() as { n?: unknown } | undefined;
        return { n: typeof state?.n === "number" ? state.n : 0 };
      },
      importState(ctx, saved) {
        const state = ctx.kept() as { n: number } | undefined;
        if (!state) return;
        const n = saved && typeof saved === "object" && "n" in saved ? (saved as { n?: unknown }).n : undefined;
        if (typeof n !== "number") throw new Error("not a count");
        state.n = n;
      },
    },
  );
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
    ],
  }),
);

describe("capture and restore", () => {
  it("round-trips JSON and leaves a different major untouched", () => {
    const result = compose([owner, counter("org.example.count")], { profileName: "preview" });
    const implementation = result.contributions[0]?.payload;
    assert.equal(typeof implementation, "function");
    if (typeof implementation === "function") implementation({});
    const captured = captureSave(result);
    assert.equal(captured.ok, true);
    assert.deepEqual(captured.document.slices, [
      { moduleId: "org.example.count", version: "1.0.0", payload: { n: 1 } },
    ]);

    const restored = restoreSave(result, {
      ...captured.document,
      slices: [{ moduleId: "org.example.count", version: "1.2.0", payload: { n: 9 } }],
    });
    assert.equal(restored.ok, true);
    assert.deepEqual(restored.applied, ["org.example.count"]);
    assert.deepEqual(captureSave(result).document.slices[0]?.payload, { n: 9 });

    const refused = restoreSave(result, {
      ...captured.document,
      slices: [{ moduleId: "org.example.count", version: "2.0.0", payload: { n: 0 } }],
    });
    assert.equal(refused.ok, false);
    assert.ok(refused.notices.some((item) => item.code === "save.incompatible"));
    assert.deepEqual(captureSave(result).document.slices[0]?.payload, { n: 9 });
  });

  it("refuses a foreign Foundations major and an unknown document field", () => {
    const result = compose([owner, counter("org.example.count")]);
    const api = restoreSave(result, {
      foundationsApi: "2.0.0",
      profileName: result.profileName,
      fingerprint: result.fingerprint,
      slices: [],
    });
    assert.equal(api.ok, false);
    assert.equal(api.notices[0]?.code, "save.api");

    const extra = restoreSave(result, {
      foundationsApi: "1.0.0",
      profileName: result.profileName,
      fingerprint: result.fingerprint,
      slices: [],
      secret: true,
    });
    assert.equal(extra.ok, false);
    assert.equal(extra.notices[0]?.code, "save.document");
  });

  it("warns on an orphan slice and on a module with nothing saved", () => {
    const result = compose([owner, counter("org.example.count")], { profileName: "preview" });
    const report = restoreSave(result, {
      foundationsApi: "1.0.0",
      profileName: "other",
      fingerprint: "nope",
      slices: [{ moduleId: "org.example.gone", version: "1.0.0", payload: { n: 1 } }],
    });
    assert.equal(report.ok, true);
    assert.deepEqual(report.applied, []);
    assert.ok(report.notices.some((item) => item.code === "save.absent"));
    assert.ok(report.notices.some((item) => item.code === "save.orphan"));
    assert.ok(report.notices.some((item) => item.code === "save.profile"));
  });

  it("rejects a second keep, a non-JSON export, and a quiesced runtime", () => {
    const doubled = compose([
      pkg(
        moduleManifest("org.example.twice", { save: { version: "1.0.0" } }),
        {
          register(ctx) {
            ctx.keep({ a: 1 });
            ctx.keep({ b: 2 });
          },
          exportState() {
            return { a: 1 };
          },
          importState() {},
        },
      ),
    ]);
    assert.equal(doubled.runtimeActive, false);
    assert.ok(doubled.diagnostics.some((item) => item.code === "save.duplicate-keep"));

    const messy = compose([
      pkg(
        moduleManifest("org.example.messy", { save: { version: "1.0.0" } }),
        {
          register(ctx) {
            ctx.keep({ fn() {} });
          },
          exportState() {
            const cycle: { self?: unknown } = {};
            cycle.self = cycle;
            return cycle;
          },
          importState() {},
        },
      ),
    ]);
    const captured = captureSave(messy);
    assert.equal(captured.ok, false);
    assert.equal(captured.notices[0]?.code, "save.not-json");

    const live = compose([owner, counter("org.example.count")]);
    live.shutdown();
    assert.equal(live.quiesced, true);
    const after = captureSave(live);
    assert.equal(after.ok, false);
    assert.equal(after.notices[0]?.message, "Runtime has shut down.");
    const restored = restoreSave(live, after.document);
    assert.equal(restored.notices[0]?.message, "Runtime has shut down.");
  });

  it("rejects a save declaration that is not an exact version", () => {
    const result = compose([pkg(moduleManifest("org.example.bad-save", { save: { version: "^1.0.0" } }))]);
    assert.equal(result.ok, false);
    assert.equal(result.modules[0]?.status, "rejected");
    assert.ok(result.diagnostics.some((item) => item.path === "save.version"));
  });
});
