import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compose as hostCompose, moduleMemory, runExclusive, type ComposeOptions, type ModulePackage } from "./host.ts";
import { IN_PROCESS_POLICY } from "./backend.ts";
import { callService } from "./dispatch.ts";
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
  it("does not replace Promise.prototype.then on Node", () => {
    assert.match(Function.prototype.toString.call(Promise.prototype.then), /\[native code\]/);
  });

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

  it("puts back a module that writes and then throws", async () => {
    const late = pkg(
      moduleManifest("org.example.late", {
        save: { version: "1.0.0" },
        connectsTo: [{ slot: "example.listeners", contract: "example.listener/1" }],
      }),
      {
        register(ctx) {
          ctx.keep({ n: 0 });
          ctx.contribute("example.listeners", {
            id: "late",
            payload() {},
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
          if (typeof n !== "number") throw new Error("late refused");
          state.n = n;
          if (n !== 0) throw new Error("late refused");
        },
      },
    );
    const result = await compose([
      owner,
      counter("org.example.early"),
      late,
      counter("org.example.tail"),
    ]);
    const report = await restoreSave(result, {
      foundationsApi: "1.0.0",
      profileName: result.profileName,
      fingerprint: result.fingerprint,
      slices: [
        { moduleId: "org.example.early", version: "1.0.0", payload: { n: 5 } },
        { moduleId: "org.example.late", version: "1.0.0", payload: { n: 1 } },
        { moduleId: "org.example.tail", version: "1.0.0", payload: { n: 9 } },
      ],
    });
    assert.equal(report.ok, false);
    assert.deepEqual(report.applied, []);
    assert.ok(report.notices.some((item) => item.code === "save.threw" && item.moduleId === "org.example.late"));
    assert.ok(report.notices.some((item) => item.code === "save.rolled-back"));
    const again = await captureSave(result);
    const payload = (id: string) => again.document.slices.find((item) => item.moduleId === id)?.payload;
    assert.deepEqual(payload("org.example.early"), { n: 0 });
    assert.deepEqual(payload("org.example.late"), { n: 0 });
    assert.deepEqual(payload("org.example.tail"), { n: 0 });
  });

  it("reports a rollback that throws and does not claim that slice was put back", async () => {
    let calls = 0;
    const late = pkg(
      moduleManifest("org.example.late", {
        save: { version: "1.0.0" },
        connectsTo: [{ slot: "example.listeners", contract: "example.listener/1" }],
      }),
      {
        register(ctx) {
          ctx.keep({ n: 0 });
          ctx.contribute("example.listeners", { id: "late", payload() {} });
        },
        exportState(ctx) {
          const state = ctx.kept() as { n?: unknown } | undefined;
          return { n: typeof state?.n === "number" ? state.n : 0 };
        },
        importState(ctx) {
          calls += 1;
          const state = ctx.kept() as { n: number } | undefined;
          if (!state) return;
          if (calls === 1) {
            state.n = 5;
            throw new Error("late refused");
          }
          throw new Error("rollback refused");
        },
      },
    );
    const result = await compose([owner, counter("org.example.early"), late, counter("org.example.tail")]);
    const report = await restoreSave(result, {
      foundationsApi: "1.0.0",
      profileName: result.profileName,
      fingerprint: result.fingerprint,
      slices: [
        { moduleId: "org.example.early", version: "1.0.0", payload: { n: 4 } },
        { moduleId: "org.example.late", version: "1.0.0", payload: { n: 1 } },
        { moduleId: "org.example.tail", version: "1.0.0", payload: { n: 9 } },
      ],
    });
    assert.equal(report.ok, false);
    assert.deepEqual(report.applied, []);
    assert.equal(calls, 2);
    const rollback = report.notices.find((item) => item.code === "save.rollback" && item.moduleId === "org.example.late");
    assert.equal(rollback?.message, "rollback refused");
    assert.equal(
      report.notices.some((item) => item.code === "save.rolled-back" && item.message.includes("org.example.early")),
      true,
    );
    const again = await captureSave(result);
    const payload = (id: string) => again.document.slices.find((item) => item.moduleId === id)?.payload;
    assert.deepEqual(payload("org.example.early"), { n: 0 });
    assert.deepEqual(payload("org.example.late"), { n: 5 });
    assert.deepEqual(payload("org.example.tail"), { n: 0 });
  });

  it("runs two restores one at a time", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let mark = () => {};
    const entered = new Promise<void>((resolve) => {
      mark = resolve;
    });
    let opened = false;
    const early = pkg(
      moduleManifest("org.example.early", {
        save: { version: "1.0.0" },
        connectsTo: [{ slot: "example.listeners", contract: "example.listener/1" }],
      }),
      {
        register(ctx) {
          ctx.keep({ n: 0 });
          ctx.contribute("example.listeners", { id: "early", payload() {} });
        },
        exportState(ctx) {
          const state = ctx.kept() as { n?: unknown } | undefined;
          return { n: typeof state?.n === "number" ? state.n : 0 };
        },
        importState(ctx, saved) {
          const state = ctx.kept() as { n: number } | undefined;
          const n = saved && typeof saved === "object" && "n" in saved ? (saved as { n?: unknown }).n : undefined;
          if (!opened) {
            opened = true;
            mark();
            return gate.then(() => {
              if (state && typeof n === "number") state.n = n;
            });
          }
          if (state && typeof n === "number") state.n = n;
        },
      },
    );
    const result = await compose([owner, early, counter("org.example.tail")]);
    const document = (n: number) => ({
      foundationsApi: "1.0.0",
      profileName: result.profileName,
      fingerprint: result.fingerprint,
      slices: [
        { moduleId: "org.example.early", version: "1.0.0", payload: { n } },
        { moduleId: "org.example.tail", version: "1.0.0", payload: { n } },
      ],
    });
    const first = restoreSave(result, document(3));
    await entered;
    let secondDone = false;
    const second = restoreSave(result, document(9)).then((report) => {
      secondDone = true;
      return report;
    });
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    assert.equal(secondDone, false);
    assert.deepEqual(moduleMemory(result, "org.example.early"), { n: 0 });
    assert.deepEqual(moduleMemory(result, "org.example.tail"), { n: 0 });
    let captureDone = false;
    const shot = captureSave(result).then((report) => {
      captureDone = true;
      return report;
    });
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    assert.equal(captureDone, false);
    release();
    const [earlier, later, captured] = await Promise.all([first, second, shot]);
    assert.equal(earlier.ok, true, earlier.notices.map((item) => item.message).join("\n"));
    assert.equal(later.ok, true, later.notices.map((item) => item.message).join("\n"));
    assert.equal(captured.ok, true, captured.notices.map((item) => item.message).join("\n"));
    const payload = (id: string) => captured.document.slices.find((item) => item.moduleId === id)?.payload;
    assert.deepEqual(payload("org.example.early"), { n: 9 });
    assert.deepEqual(payload("org.example.tail"), { n: 9 });
  });

  it("does not capture one new slice beside one old slice", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let mark = () => {};
    const entered = new Promise<void>((resolve) => {
      mark = resolve;
    });
    const early = counter("org.example.early");
    const late = pkg(
      moduleManifest("org.example.late", {
        save: { version: "1.0.0" },
        connectsTo: [{ slot: "example.listeners", contract: "example.listener/1" }],
      }),
      {
        register(ctx) {
          ctx.keep({ n: 0 });
          ctx.contribute("example.listeners", { id: "late", payload() {} });
        },
        exportState(ctx) {
          const state = ctx.kept() as { n?: unknown } | undefined;
          return { n: typeof state?.n === "number" ? state.n : 0 };
        },
        importState(ctx, saved) {
          const state = ctx.kept() as { n: number } | undefined;
          const n = saved && typeof saved === "object" && "n" in saved ? (saved as { n?: unknown }).n : undefined;
          mark();
          return gate.then(() => {
            if (state && typeof n === "number") state.n = n;
          });
        },
      },
    );
    const result = await compose([owner, early, late]);
    const restoring = restoreSave(result, {
      foundationsApi: "1.0.0",
      profileName: result.profileName,
      fingerprint: result.fingerprint,
      slices: [
        { moduleId: "org.example.early", version: "1.0.0", payload: { n: 6 } },
        { moduleId: "org.example.late", version: "1.0.0", payload: { n: 6 } },
      ],
    });
    await entered;
    assert.deepEqual(moduleMemory(result, "org.example.early"), { n: 6 });
    assert.deepEqual(moduleMemory(result, "org.example.late"), { n: 0 });
    let captureDone = false;
    const shot = captureSave(result).then((report) => {
      captureDone = true;
      return report;
    });
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    assert.equal(captureDone, false);
    release();
    const [restored, captured] = await Promise.all([restoring, shot]);
    assert.equal(restored.ok, true, restored.notices.map((item) => item.message).join("\n"));
    assert.equal(captured.ok, true, captured.notices.map((item) => item.message).join("\n"));
    assert.deepEqual(captured.document.slices.find((item) => item.moduleId === "org.example.early")?.payload, { n: 6 });
    assert.deepEqual(captured.document.slices.find((item) => item.moduleId === "org.example.late")?.payload, { n: 6 });
  });

  it("refuses a save that an importer starts, including after it awaits", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let mark = () => {};
    const entered = new Promise<void>((resolve) => {
      mark = resolve;
    });
    let live: Awaited<ReturnType<typeof compose>> | undefined;
    let nestedRestore: { ok: boolean; notices: Array<{ code: string }> } | undefined;
    let nestedCapture: { ok: boolean; notices: Array<{ code: string }> } | undefined;
    const early = pkg(
      moduleManifest("org.example.early", {
        save: { version: "1.0.0" },
        connectsTo: [{ slot: "example.listeners", contract: "example.listener/1" }],
      }),
      {
        register(ctx) {
          ctx.keep({ n: 0 });
          ctx.contribute("example.listeners", { id: "early", payload() {} });
        },
        exportState(ctx) {
          const state = ctx.kept() as { n?: unknown } | undefined;
          return { n: typeof state?.n === "number" ? state.n : 0 };
        },
        importState(ctx, saved) {
          const state = ctx.kept() as { n: number } | undefined;
          const n = saved && typeof saved === "object" && "n" in saved ? (saved as { n?: unknown }).n : undefined;
          mark();
          const host = live;
          if (!host) throw new Error("missing composition");
          const refusedRestore = restoreSave(host, {
            foundationsApi: "1.0.0",
            profileName: host.profileName,
            fingerprint: host.fingerprint,
            slices: [{ moduleId: "org.example.early", version: "1.0.0", payload: { n: 1 } }],
          });
          return gate.then(() =>
            Promise.all([refusedRestore, captureSave(host)]).then(([restore, capture]) => {
              nestedRestore = restore;
              nestedCapture = capture;
              if (state && typeof n === "number") state.n = n;
            }),
          );
        },
      },
    );
    const result = await compose([owner, early, counter("org.example.tail")]);
    live = result;
    const restoring = restoreSave(result, {
      foundationsApi: "1.0.0",
      profileName: result.profileName,
      fingerprint: result.fingerprint,
      slices: [
        { moduleId: "org.example.early", version: "1.0.0", payload: { n: 4 } },
        { moduleId: "org.example.tail", version: "1.0.0", payload: { n: 4 } },
      ],
    });
    await entered;
    release();
    const restored = await restoring;
    assert.equal(restored.ok, true, restored.notices.map((item) => item.message).join("\n"));
    assert.equal(nestedRestore?.ok, false);
    assert.equal(nestedRestore?.notices[0]?.code, "save.reentrant");
    assert.equal(nestedCapture?.ok, false);
    assert.equal(nestedCapture?.notices[0]?.code, "save.reentrant");
    const done = await captureSave(result);
    assert.deepEqual(done.document.slices.find((item) => item.moduleId === "org.example.early")?.payload, { n: 4 });
    assert.deepEqual(done.document.slices.find((item) => item.moduleId === "org.example.tail")?.payload, { n: 4 });
  });

  it("refuses a save from an async importState after await", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let mark = () => {};
    const entered = new Promise<void>((resolve) => {
      mark = resolve;
    });
    let live: Awaited<ReturnType<typeof compose>> | undefined;
    let idle: Awaited<ReturnType<typeof compose>> | undefined;
    let own = "";
    let foreignOk = false;
    const early = pkg(
      moduleManifest("org.example.early", {
        save: { version: "1.0.0" },
        connectsTo: [{ slot: "example.listeners", contract: "example.listener/1" }],
      }),
      {
        register(ctx) {
          ctx.keep({ n: 0 });
          ctx.contribute("example.listeners", { id: "early", payload() {} });
        },
        exportState(ctx) {
          const state = ctx.kept() as { n?: unknown } | undefined;
          return { n: typeof state?.n === "number" ? state.n : 0 };
        },
        async importState(ctx, saved) {
          const state = ctx.kept() as { n: number } | undefined;
          const n = saved && typeof saved === "object" && "n" in saved ? (saved as { n?: unknown }).n : undefined;
          mark();
          await gate;
          const host = live;
          const other = idle;
          if (!host || !other) throw new Error("missing composition");
          const refused = await captureSave(host);
          const foreign = await captureSave(other);
          own = refused.notices[0]?.code ?? "";
          foreignOk = foreign.ok && foreign.notices.every((item) => item.code !== "save.reentrant");
          if (state && typeof n === "number") state.n = n;
        },
      },
    );
    const result = await compose([owner, early, counter("org.example.tail")]);
    const other = await compose([owner, counter("org.example.other")]);
    live = result;
    idle = other;
    const restoring = restoreSave(result, {
      foundationsApi: "1.0.0",
      profileName: result.profileName,
      fingerprint: result.fingerprint,
      slices: [
        { moduleId: "org.example.early", version: "1.0.0", payload: { n: 4 } },
        { moduleId: "org.example.tail", version: "1.0.0", payload: { n: 4 } },
      ],
    });
    await entered;
    const idleShot = await captureSave(other);
    assert.equal(idleShot.ok, true, idleShot.notices.map((item) => item.message).join("\n"));
    assert.deepEqual(idleShot.document.slices.find((item) => item.moduleId === "org.example.other")?.payload, { n: 0 });
    let captureDone = false;
    const waiting = captureSave(result).then((report) => {
      captureDone = true;
      return report;
    });
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    assert.equal(captureDone, false);
    release();
    const restored = await restoring;
    const captured = await waiting;
    assert.equal(restored.ok, true, restored.notices.map((item) => item.message).join("\n"));
    assert.equal(own, "save.reentrant");
    assert.equal(foreignOk, true);
    assert.equal(captured.ok, true, captured.notices.map((item) => item.message).join("\n"));
    assert.deepEqual(captured.document.slices.find((item) => item.moduleId === "org.example.early")?.payload, { n: 4 });
    assert.deepEqual(captured.document.slices.find((item) => item.moduleId === "org.example.tail")?.payload, { n: 4 });
    assert.match(Function.prototype.toString.call(Promise.prototype.then), /\[native code\]/);
  });

  it("refuses a save from an async exportState after await", async () => {
    let live: Awaited<ReturnType<typeof compose>> | undefined;
    let own = "";
    let restoreCode = "";
    const box = pkg(
      moduleManifest("org.example.box", {
        save: { version: "1.0.0" },
        connectsTo: [{ slot: "example.listeners", contract: "example.listener/1" }],
      }),
      {
        register(ctx) {
          ctx.keep({ n: 3 });
          ctx.contribute("example.listeners", { id: "box", payload() {} });
        },
        async exportState(ctx) {
          const state = ctx.kept() as { n?: unknown } | undefined;
          const n = typeof state?.n === "number" ? state.n : 0;
          await Promise.resolve();
          const host = live;
          if (!host) throw new Error("missing composition");
          const refused = await captureSave(host);
          const nested = await restoreSave(host, {
            foundationsApi: "1.0.0",
            profileName: host.profileName,
            fingerprint: host.fingerprint,
            slices: [{ moduleId: "org.example.box", version: "1.0.0", payload: { n: 1 } }],
          });
          own = refused.notices[0]?.code ?? "";
          restoreCode = nested.notices[0]?.code ?? "";
          return { n };
        },
        importState(ctx, saved) {
          const state = ctx.kept() as { n: number } | undefined;
          const n = saved && typeof saved === "object" && "n" in saved ? (saved as { n?: unknown }).n : undefined;
          if (state && typeof n === "number") state.n = n;
        },
      },
    );
    const result = await compose([owner, box]);
    live = result;
    const captured = await captureSave(result);
    assert.equal(captured.ok, true, captured.notices.map((item) => item.message).join("\n"));
    assert.equal(own, "save.reentrant");
    assert.equal(restoreCode, "save.reentrant");
    assert.deepEqual(captured.document.slices[0]?.payload, { n: 3 });
    assert.deepEqual(moduleMemory(result, "org.example.box"), { n: 3 });
  });

  it("does not let one composition's hook refuse or snapshot the other", async () => {
    let releaseA = () => {};
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let releaseB = () => {};
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    let markA = () => {};
    const enteredA = new Promise<void>((resolve) => {
      markA = resolve;
    });
    let markB = () => {};
    const enteredB = new Promise<void>((resolve) => {
      markB = resolve;
    });
    let liveA: Awaited<ReturnType<typeof compose>> | undefined;
    let liveB: Awaited<ReturnType<typeof compose>> | undefined;
    let ownA = "";
    const make = (mark: () => void, gate: Promise<void>, self: () => Awaited<ReturnType<typeof compose>> | undefined, record?: (code: string) => void) =>
      pkg(
        moduleManifest("org.example.held", {
          save: { version: "1.0.0" },
          connectsTo: [{ slot: "example.listeners", contract: "example.listener/1" }],
        }),
        {
          register(ctx) {
            ctx.keep({ n: 0 });
            ctx.contribute("example.listeners", { id: "held", payload() {} });
          },
          exportState(ctx) {
            const state = ctx.kept() as { n?: unknown } | undefined;
            return { n: typeof state?.n === "number" ? state.n : 0 };
          },
          async importState(ctx, saved) {
            const state = ctx.kept() as { n: number } | undefined;
            const n = saved && typeof saved === "object" && "n" in saved ? (saved as { n?: unknown }).n : undefined;
            mark();
            await gate;
            const host = self();
            if (!host) throw new Error("missing composition");
            const refused = await captureSave(host);
            record?.(refused.notices[0]?.code ?? "");
            if (state && typeof n === "number") state.n = n;
          },
        },
      );
    const first = await compose([owner, make(markA, gateA, () => liveA, (code) => { ownA = code; })]);
    const second = await compose([owner, make(markB, gateB, () => liveB)]);
    const idle = await compose([owner, counter("org.example.idle")]);
    liveA = first;
    liveB = second;
    const document = (result: Awaited<ReturnType<typeof compose>>, n: number) => ({
      foundationsApi: "1.0.0",
      profileName: result.profileName,
      fingerprint: result.fingerprint,
      slices: [{ moduleId: "org.example.held", version: "1.0.0", payload: { n } }],
    });
    const restoringA = restoreSave(first, document(first, 2));
    const restoringB = restoreSave(second, document(second, 8));
    await enteredA;
    await enteredB;
    const idleShot = await captureSave(idle);
    assert.equal(idleShot.ok, true);
    assert.deepEqual(idleShot.document.slices[0]?.payload, { n: 0 });
    let doneA = false;
    let doneB = false;
    const shotA = captureSave(first).then((report) => {
      doneA = true;
      return report;
    });
    const shotB = captureSave(second).then((report) => {
      doneB = true;
      return report;
    });
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    assert.equal(doneA, false);
    assert.equal(doneB, false);
    assert.deepEqual(moduleMemory(second, "org.example.held"), { n: 0 });
    releaseA();
    const restoredA = await restoringA;
    const capturedA = await shotA;
    assert.equal(doneB, false);
    assert.equal(restoredA.ok, true, restoredA.notices.map((item) => item.message).join("\n"));
    assert.equal(ownA, "save.reentrant");
    assert.deepEqual(capturedA.document.slices[0]?.payload, { n: 2 });
    assert.deepEqual(moduleMemory(second, "org.example.held"), { n: 0 });
    releaseB();
    const restoredB = await restoringB;
    const capturedB = await shotB;
    assert.equal(restoredB.ok, true, restoredB.notices.map((item) => item.message).join("\n"));
    assert.deepEqual(capturedB.document.slices[0]?.payload, { n: 8 });
    assert.deepEqual(capturedA.document.slices[0]?.payload, { n: 2 });
  });

  it("orders an outside service before, during, and after a capture", async () => {
    const state = { early: 0, late: 0 };
    let releaseExport = () => {};
    const exportGate = new Promise<void>((resolve) => {
      releaseExport = resolve;
    });
    let markExport = () => {};
    const exportEntered = new Promise<void>((resolve) => {
      markExport = resolve;
    });
    let releaseService = () => {};
    const serviceGate = new Promise<void>((resolve) => {
      releaseService = resolve;
    });
    let markService = () => {};
    const serviceEntered = new Promise<void>((resolve) => {
      markService = resolve;
    });
    let holdExport = false;
    const early = pkg(
      moduleManifest("org.example.early", {
        save: { version: "1.0.0" },
        connectsTo: [{ slot: "example.listeners", contract: "example.listener/1" }],
      }),
      {
        register(ctx) {
          ctx.keep(state);
          ctx.contribute("example.listeners", { id: "early", payload() {} });
        },
        async exportState() {
          const snapshot = { early: state.early, late: state.late };
          if (holdExport) {
            markExport();
            await exportGate;
          }
          return snapshot;
        },
      },
    );
    const next = pkg(
      moduleManifest("org.example.late", {
        save: { version: "1.0.0" },
        connectsTo: [{ slot: "example.listeners", contract: "example.listener/1" }],
      }),
      {
        register(ctx) {
          ctx.contribute("example.listeners", { id: "late", payload() {} });
        },
        exportState() {
          return { early: state.early, late: state.late };
        },
      },
    );
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
    const bump = pkg(
      moduleManifest("org.example.bump", {
        connectsTo: [{ slot: "example.ask", contract: "example.answer/1" }],
      }),
      {
        register(ctx) {
          ctx.contribute("example.ask", {
            id: "bump",
            async payload() {
              markService();
              await serviceGate;
              state.early += 1;
              state.late += 1;
            },
          });
        },
      },
    );
    const result = await compose([owner, desk, bump, early, next]);
    const before = callService(result, "example.ask", undefined);
    await serviceEntered;
    let beforeCaptureDone = false;
    const beforeCapture = captureSave(result).then((report) => {
      beforeCaptureDone = true;
      return report;
    });
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    assert.equal(beforeCaptureDone, false);
    releaseService();
    const beforeReport = await before;
    assert.equal(beforeReport.ok, true, beforeReport.reason ?? "");
    const beforeSaved = await beforeCapture;
    assert.equal(beforeSaved.ok, true, beforeSaved.notices.map((item) => item.message).join("\n"));
    assert.deepEqual(beforeSaved.document.slices.find((item) => item.moduleId === "org.example.early")?.payload, {
      early: 1,
      late: 1,
    });
    assert.deepEqual(beforeSaved.document.slices.find((item) => item.moduleId === "org.example.late")?.payload, {
      early: 1,
      late: 1,
    });

    let releaseDuring = () => {};
    const duringGate = new Promise<void>((resolve) => {
      releaseDuring = resolve;
    });
    let markDuring = () => {};
    const duringEntered = new Promise<void>((resolve) => {
      markDuring = resolve;
    });
    holdExport = true;
    const duringService = pkg(
      moduleManifest("org.example.bump", {
        connectsTo: [{ slot: "example.ask", contract: "example.answer/1" }],
      }),
      {
        register(ctx) {
          ctx.contribute("example.ask", {
            id: "bump",
            async payload() {
              markDuring();
              await duringGate;
              state.early += 1;
              state.late += 1;
            },
          });
        },
      },
    );
    const second = await compose([owner, desk, duringService, early, next]);
    const walking = captureSave(second);
    await exportEntered;
    let duringDone = false;
    const during = callService(second, "example.ask", undefined).then((report) => {
      duringDone = true;
      return report;
    });
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    assert.equal(duringDone, false);
    assert.deepEqual(state, { early: 1, late: 1 });
    releaseExport();
    const walked = await walking;
    await duringEntered;
    assert.equal(walked.ok, true, walked.notices.map((item) => item.message).join("\n"));
    assert.deepEqual(walked.document.slices.find((item) => item.moduleId === "org.example.early")?.payload, {
      early: 1,
      late: 1,
    });
    assert.deepEqual(walked.document.slices.find((item) => item.moduleId === "org.example.late")?.payload, {
      early: 1,
      late: 1,
    });
    assert.equal(duringDone, false);
    releaseDuring();
    const duringReport = await during;
    assert.equal(duringReport.ok, true, duringReport.reason ?? "");
    const after = await captureSave(second);
    assert.deepEqual(after.document.slices.find((item) => item.moduleId === "org.example.early")?.payload, {
      early: 2,
      late: 2,
    });
    assert.deepEqual(after.document.slices.find((item) => item.moduleId === "org.example.late")?.payload, {
      early: 2,
      late: 2,
    });
  });

  it("runs two services and two captures in call order", async () => {
    const state = { n: 0 };
    let releaseFirst = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirst = () => {};
    const firstEntered = new Promise<void>((resolve) => {
      markFirst = resolve;
    });
    const calls: number[] = [];
    const counterModule = pkg(
      moduleManifest("org.example.count", {
        save: { version: "1.0.0" },
        connectsTo: [{ slot: "example.listeners", contract: "example.listener/1" }],
      }),
      {
        register(ctx) {
          ctx.keep(state);
          ctx.contribute("example.listeners", { id: "count", payload() {} });
        },
        exportState() {
          return { n: state.n };
        },
      },
    );
    const other = pkg(
      moduleManifest("org.example.other", {
        save: { version: "1.0.0" },
        connectsTo: [{ slot: "example.listeners", contract: "example.listener/1" }],
      }),
      {
        register(ctx) {
          ctx.contribute("example.listeners", { id: "other", payload() {} });
        },
        exportState() {
          return { n: state.n };
        },
      },
    );
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
    const bump = pkg(
      moduleManifest("org.example.bump", {
        connectsTo: [{ slot: "example.ask", contract: "example.answer/1" }],
      }),
      {
        register(ctx) {
          ctx.contribute("example.ask", {
            id: "bump",
            async payload(input: unknown) {
              const amount = typeof input === "number" ? input : 0;
              if (amount === 1) {
                markFirst();
                await firstGate;
              }
              state.n = amount;
              calls.push(amount);
            },
          });
        },
      },
    );
    const result = await compose([owner, desk, bump, counterModule, other]);
    const firstService = callService(result, "example.ask", 1);
    await firstEntered;
    let firstCaptureDone = false;
    let secondServiceDone = false;
    let secondCaptureDone = false;
    const firstCapture = captureSave(result).then((report) => {
      firstCaptureDone = true;
      return report;
    });
    const secondService = callService(result, "example.ask", 2).then((report) => {
      secondServiceDone = true;
      return report;
    });
    const secondCapture = captureSave(result).then((report) => {
      secondCaptureDone = true;
      return report;
    });
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    assert.equal(firstCaptureDone, false);
    assert.equal(secondServiceDone, false);
    assert.equal(secondCaptureDone, false);
    releaseFirst();
    const savedFirst = await firstCapture;
    const savedSecond = await secondCapture;
    await firstService;
    await secondService;
    assert.deepEqual(calls, [1, 2]);
    assert.equal(savedFirst.document.slices.length, 2);
    assert.deepEqual(savedFirst.document.slices.find((item) => item.moduleId === "org.example.count")?.payload, { n: 1 });
    assert.deepEqual(savedFirst.document.slices.find((item) => item.moduleId === "org.example.other")?.payload, { n: 1 });
    assert.deepEqual(savedSecond.document.slices.find((item) => item.moduleId === "org.example.count")?.payload, { n: 2 });
    assert.deepEqual(savedSecond.document.slices.find((item) => item.moduleId === "org.example.other")?.payload, { n: 2 });
  });

  it("lets exportState call a service that later slices can see", async () => {
    const state = { early: 1, late: 0 };
    let live: Awaited<ReturnType<typeof compose>> | undefined;
    const early = pkg(
      moduleManifest("org.example.early", {
        save: { version: "1.0.0" },
        connectsTo: [{ slot: "example.listeners", contract: "example.listener/1" }],
      }),
      {
        register(ctx) {
          ctx.keep(state);
          ctx.contribute("example.listeners", { id: "early", payload() {} });
        },
        async exportState() {
          const host = live;
          if (!host) throw new Error("missing composition");
          const bumped = await callService(host, "example.ask", undefined);
          if (!bumped.ok) throw new Error(bumped.reason ?? "bump failed");
          return { early: 1, late: 0 };
        },
      },
    );
    const next = pkg(
      moduleManifest("org.example.late", {
        save: { version: "1.0.0" },
        connectsTo: [{ slot: "example.listeners", contract: "example.listener/1" }],
      }),
      {
        register(ctx) {
          ctx.contribute("example.listeners", { id: "late", payload() {} });
        },
        exportState() {
          return { early: state.early, late: state.late };
        },
      },
    );
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
    const bump = pkg(
      moduleManifest("org.example.bump", {
        connectsTo: [{ slot: "example.ask", contract: "example.answer/1" }],
      }),
      {
        register(ctx) {
          ctx.contribute("example.ask", {
            id: "bump",
            payload() {
              state.late = 7;
            },
          });
        },
      },
    );
    const result = await compose([owner, desk, bump, early, next]);
    live = result;
    const captured = await captureSave(result);
    assert.equal(captured.ok, true, captured.notices.map((item) => item.message).join("\n"));
    assert.deepEqual(captured.document.slices.find((item) => item.moduleId === "org.example.early")?.payload, {
      early: 1,
      late: 0,
    });
    assert.deepEqual(captured.document.slices.find((item) => item.moduleId === "org.example.late")?.payload, {
      early: 1,
      late: 7,
    });
  });

  it("does not delay a service that declares it does not mutate", async () => {
    const state = { n: 1 };
    let releaseExport = () => {};
    const exportGate = new Promise<void>((resolve) => {
      releaseExport = resolve;
    });
    let markExport = () => {};
    const exportEntered = new Promise<void>((resolve) => {
      markExport = resolve;
    });
    let releaseBump = () => {};
    const bumpGate = new Promise<void>((resolve) => {
      releaseBump = resolve;
    });
    const early = pkg(
      moduleManifest("org.example.early", { save: { version: "1.0.0" } }),
      {
        register(ctx) {
          ctx.keep(state);
        },
        async exportState() {
          const snapshot = { n: state.n };
          markExport();
          await exportGate;
          return snapshot;
        },
      },
    );
    const desk = pkg(
      moduleManifest("org.example.desk", {
        exposesSlots: [
          {
            slotId: "example.look",
            contract: "example.look",
            contractVersion: "1.0.0",
            kind: "service",
            required: false,
            mutates: false,
          },
          {
            slotId: "example.ask",
            contract: "example.ask",
            contractVersion: "1.0.0",
            kind: "service",
            required: false,
          },
        ],
      }),
    );
    const providers = pkg(
      moduleManifest("org.example.providers", {
        connectsTo: [
          { slot: "example.look", contract: "example.look/1" },
          { slot: "example.ask", contract: "example.ask/1" },
        ],
      }),
      {
        register(ctx) {
          ctx.contribute("example.look", {
            id: "look",
            payload() {
              return state.n;
            },
          });
          ctx.contribute("example.ask", {
            id: "bump",
            async payload() {
              await bumpGate;
              state.n += 1;
            },
          });
        },
      },
    );
    const result = await compose([desk, providers, early]);
    assert.equal(result.slots.find((item) => item.slotId === "example.look")?.mutates, false);
    assert.equal(result.slots.find((item) => item.slotId === "example.ask")?.mutates, true);
    const walking = captureSave(result);
    await exportEntered;
    const seen = await callService(result, "example.look", undefined);
    assert.equal(seen.ok, true, seen.reason ?? "");
    assert.equal(seen.output, 1);
    let bumpDone = false;
    const bumping = callService(result, "example.ask", undefined).then((report) => {
      bumpDone = true;
      return report;
    });
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    assert.equal(bumpDone, false);
    assert.equal(state.n, 1);
    releaseExport();
    const walked = await walking;
    assert.equal(walked.ok, true, walked.notices.map((item) => item.message).join("\n"));
    assert.deepEqual(walked.document.slices[0]?.payload, { n: 1 });
    assert.equal(bumpDone, false);
    releaseBump();
    const bumped = await bumping;
    assert.equal(bumped.ok, true, bumped.reason ?? "");
    const after = await captureSave(result);
    assert.deepEqual(after.document.slices[0]?.payload, { n: 2 });
  });

  it("keeps a service called by a step-time mutation on that same call", async () => {
    const state = { n: 0 };
    let releaseStep = () => {};
    const stepGate = new Promise<void>((resolve) => {
      releaseStep = resolve;
    });
    let markStep = () => {};
    const stepEntered = new Promise<void>((resolve) => {
      markStep = resolve;
    });
    let releaseOuter = () => {};
    const outerGate = new Promise<void>((resolve) => {
      releaseOuter = resolve;
    });
    let markOuter = () => {};
    const outerEntered = new Promise<void>((resolve) => {
      markOuter = resolve;
    });
    let live: Awaited<ReturnType<typeof compose>> | undefined;
    const desk = pkg(
      moduleManifest("org.example.desk", {
        exposesSlots: [
          {
            slotId: "example.ask",
            contract: "example.ask",
            contractVersion: "1.0.0",
            kind: "service",
            required: false,
          },
          {
            slotId: "example.more",
            contract: "example.more",
            contractVersion: "1.0.0",
            kind: "service",
            required: false,
          },
        ],
      }),
    );
    const box = pkg(
      moduleManifest("org.example.box", {
        save: { version: "1.0.0" },
        connectsTo: [
          { slot: "example.ask", contract: "example.ask/1" },
          { slot: "example.more", contract: "example.more/1" },
        ],
      }),
      {
        register(ctx) {
          ctx.keep(state);
          ctx.contribute("example.ask", {
            id: "ask",
            async payload() {
              markOuter();
              await outerGate;
              const host = live;
              if (!host) throw new Error("missing composition");
              const inner = await callService(host, "example.more", undefined);
              if (!inner.ok) throw new Error(inner.reason ?? "inner failed");
            },
          });
          ctx.contribute("example.more", {
            id: "more",
            payload() {
              state.n = 5;
            },
          });
        },
        exportState() {
          return { n: state.n };
        },
      },
    );
    const result = await compose([desk, box]);
    live = result;
    const stepping = runExclusive(
      result,
      async () => {
        markStep();
        await stepGate;
      },
      "step",
    );
    await stepEntered;
    const outer = callService(result, "example.ask", undefined);
    await outerEntered;
    let captureDone = false;
    const shot = captureSave(result).then((report) => {
      captureDone = true;
      return report;
    });
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    assert.equal(captureDone, false);
    releaseStep();
    await stepping;
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    assert.equal(captureDone, false);
    assert.equal(state.n, 0);
    releaseOuter();
    const outerReport = await outer;
    assert.equal(outerReport.ok, true, outerReport.reason ?? "");
    const saved = await shot;
    assert.equal(saved.ok, true, saved.notices.map((item) => item.message).join("\n"));
    assert.deepEqual(saved.document.slices[0]?.payload, { n: 5 });
  });

  it("does not let one composition's service delay another's capture", async () => {
    const state = { n: 0 };
    let releaseService = () => {};
    const serviceGate = new Promise<void>((resolve) => {
      releaseService = resolve;
    });
    let markService = () => {};
    const serviceEntered = new Promise<void>((resolve) => {
      markService = resolve;
    });
    const desk = pkg(
      moduleManifest("org.example.desk", {
        exposesSlots: [
          {
            slotId: "example.ask",
            contract: "example.ask",
            contractVersion: "1.0.0",
            kind: "service",
            required: false,
          },
        ],
      }),
    );
    const bump = pkg(
      moduleManifest("org.example.bump", {
        connectsTo: [{ slot: "example.ask", contract: "example.ask/1" }],
      }),
      {
        register(ctx) {
          ctx.contribute("example.ask", {
            id: "bump",
            async payload() {
              markService();
              await serviceGate;
              state.n = 4;
            },
          });
        },
      },
    );
    const held = pkg(
      moduleManifest("org.example.held", { save: { version: "1.0.0" } }),
      {
        register(ctx) {
          ctx.keep({ n: 3 });
        },
        exportState(ctx) {
          return ctx.kept();
        },
      },
    );
    const first = await compose([desk, bump]);
    const second = await compose([held]);
    const pending = callService(first, "example.ask", undefined);
    await serviceEntered;
    const shot = await captureSave(second);
    assert.equal(shot.ok, true, shot.notices.map((item) => item.message).join("\n"));
    assert.deepEqual(shot.document.slices[0]?.payload, { n: 3 });
    assert.equal(state.n, 0);
    releaseService();
    const bumped = await pending;
    assert.equal(bumped.ok, true, bumped.reason ?? "");
    assert.equal(state.n, 4);
  });
});
