import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compose as hostCompose, type ComposeOptions, type ModulePackage } from "./host.ts";
import { IN_PROCESS_POLICY } from "./backend.ts";
import { captureSave, restoreSave } from "./save.ts";

function compose(packages: readonly ModulePackage[], options: ComposeOptions = {}) {
  return hostCompose(packages, { policy: IN_PROCESS_POLICY, ...options });
}

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
  it("round-trips JSON and leaves a different major untouched", async () => {
    const result = await compose([owner, counter("org.example.count")], { profileName: "preview" });
    const implementation = result.contributions[0]?.payload;
    assert.equal(typeof implementation, "function");
    if (typeof implementation === "function") implementation({});
    const captured = await captureSave(result);
    assert.equal(captured.ok, true);
    assert.deepEqual(captured.document.slices, [
      { moduleId: "org.example.count", version: "1.0.0", payload: { n: 1 } },
    ]);

    const restored = await restoreSave(result, {
      ...captured.document,
      slices: [{ moduleId: "org.example.count", version: "1.2.0", payload: { n: 9 } }],
    });
    assert.equal(restored.ok, true);
    assert.deepEqual(restored.applied, ["org.example.count"]);
    assert.deepEqual((await captureSave(result)).document.slices[0]?.payload, { n: 9 });

    const refused = await restoreSave(result, {
      ...captured.document,
      slices: [{ moduleId: "org.example.count", version: "2.0.0", payload: { n: 0 } }],
    });
    assert.equal(refused.ok, false);
    assert.ok(refused.notices.some((item) => item.code === "save.incompatible"));
    assert.deepEqual((await captureSave(result)).document.slices[0]?.payload, { n: 9 });
  });

  it("refuses a foreign Foundations major and an unknown document field", async () => {
    const result = await compose([owner, counter("org.example.count")]);
    const api = await restoreSave(result, {
      foundationsApi: "2.0.0",
      profileName: result.profileName,
      fingerprint: result.fingerprint,
      slices: [],
    });
    assert.equal(api.ok, false);
    assert.equal(api.notices[0]?.code, "save.api");

    const extra = await restoreSave(result, {
      foundationsApi: "1.0.0",
      profileName: result.profileName,
      fingerprint: result.fingerprint,
      slices: [],
      secret: true,
    });
    assert.equal(extra.ok, false);
    assert.equal(extra.notices[0]?.code, "save.document");
  });

  it("warns on an orphan slice and on a module with nothing saved", async () => {
    const result = await compose([owner, counter("org.example.count")], { profileName: "preview" });
    const report = await restoreSave(result, {
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
    assert.ok(report.notices.some((item) => item.code === "save.fingerprint"));
  });

  it("does not pick between two slices for one module", async () => {
    const result = await compose([owner, counter("org.example.count")], { profileName: "preview" });
    const report = await restoreSave(result, {
      foundationsApi: "1.0.0",
      profileName: result.profileName,
      fingerprint: result.fingerprint,
      slices: [
        { moduleId: "org.example.count", version: "1.0.0", payload: { n: 1 } },
        { moduleId: "org.example.count", version: "1.1.0", payload: { n: 2 } },
      ],
    });
    assert.equal(report.ok, false);
    assert.deepEqual(report.applied, []);
    assert.ok(report.notices.some((item) => item.code === "save.duplicate"));
    assert.equal(report.notices.some((item) => item.code === "save.fingerprint"), false);
    assert.deepEqual((await captureSave(result)).document.slices[0]?.payload, { n: 0 });
  });

  it("sorts object keys and keeps array order", async () => {
    const bag = (body: Record<string, unknown>) =>
      pkg(moduleManifest("org.example.bag", { save: { version: "1.0.0" } }), {
        exportState() {
          return body;
        },
        importState(_ctx, saved) {
          seen = saved;
        },
      });
    let seen: unknown;
    const forward = await compose([bag({ z: 1, a: { d: [2, 1], b: true } })]);
    const payload = (await captureSave(forward)).document.slices[0]?.payload as {
      a: { b: boolean; d: number[] };
    };
    assert.deepEqual(Object.keys(payload), ["a", "z"]);
    assert.deepEqual(Object.keys(payload.a), ["b", "d"]);
    assert.deepEqual(payload.a.d, [2, 1]);

    const reverse = await compose([bag({ a: { b: true, d: [2, 1] }, z: 1 })]);
    assert.equal(
      JSON.stringify((await captureSave(reverse)).document.slices[0]?.payload),
      JSON.stringify(payload),
    );

    const restored = await restoreSave(forward, {
      foundationsApi: "1.0.0",
      profileName: forward.profileName,
      fingerprint: forward.fingerprint,
      slices: [{ moduleId: "org.example.bag", version: "1.0.0", payload: { z: 1, a: { d: [2, 1], b: true } } }],
    });
    assert.equal(restored.ok, true);
    assert.deepEqual(Object.keys(seen as object), ["a", "z"]);
  });

  it("rejects a second keep, a non-JSON export, and a quiesced runtime", async () => {
    const doubled = await compose([
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

    const messy = await compose([
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
    const captured = await captureSave(messy);
    assert.equal(captured.ok, false);
    assert.equal(captured.notices[0]?.code, "save.not-json");

    const live = await compose([owner, counter("org.example.count")]);
    await live.shutdown();
    assert.equal(live.quiesced, true);
    const after = await captureSave(live);
    assert.equal(after.ok, false);
    assert.equal(after.notices[0]?.message, "Runtime has shut down.");
    const restored = await restoreSave(live, after.document);
    assert.equal(restored.notices[0]?.message, "Runtime has shut down.");
  });

  it("rejects a save declaration that is not an exact version", async () => {
    const result = await compose([pkg(moduleManifest("org.example.bad-save", { save: { version: "^1.0.0" } }))]);
    assert.equal(result.ok, false);
    assert.equal(result.modules[0]?.status, "rejected");
    assert.ok(result.diagnostics.some((item) => item.path === "save.version"));
  });

  it("keeps a __proto__ field as data and does not change Object.prototype", async () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"n":1}') as {
      n: number;
    };
    const result = await compose([
      pkg(moduleManifest("org.example.box", { save: { version: "1.0.0" } }), {
        exportState: () => hostile,
        importState() {},
      }),
    ]);
    const saved = await captureSave(result);
    assert.equal(saved.ok, true, saved.notices.map((item) => item.message).join("\n"));
    const payload = saved.document.slices[0]?.payload as { n?: number; polluted?: unknown } | undefined;
    assert.equal(payload?.n, 1);
    assert.equal(payload?.polluted, undefined);
    assert.equal(Object.hasOwn(payload ?? {}, "__proto__"), true);
    assert.equal(Object.getPrototypeOf(payload), Object.prototype);
    assert.equal(({} as { polluted?: unknown }).polluted, undefined);
    assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
    await result.shutdown();
  });
});
