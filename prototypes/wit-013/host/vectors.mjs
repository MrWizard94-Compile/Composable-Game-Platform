import {
  COMPOSITION_ID,
  MODULES,
  OTHER_COMPOSITION_ID,
  WIT_PACKAGE,
  createHost,
} from "./policy.mjs";

function same(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export async function evaluate(env) {
  const cases = [];
  function check(id, actual, expected) {
    const pass = same(actual, expected);
    cases.push({ id, pass, actual, expected });
    return pass;
  }

  const rust = await env.open("rust");
  const js = await env.open("js");
  const host = createHost(COMPOSITION_ID);
  const rustModule = MODULES.rust.moduleId;
  const jsModule = MODULES.js.moduleId;

  check("identity.distinct", {
    wit: WIT_PACKAGE,
    rust: `${rustModule}@${MODULES.rust.version}`,
    js: `${jsModule}@${MODULES.js.version}`,
    composition: COMPOSITION_ID,
  }, {
    wit: "cgp:slot-probe@0.1.0",
    rust: "org.example.rust-meter@1.4.2",
    js: "org.example.js-meter@2.0.1",
    composition: "comp-9",
  });
  check("identity.wit-is-not-module", WIT_PACKAGE !== `${rustModule}@${MODULES.rust.version}`, true);

  check("imports.rust", await env.imports("rust"), []);
  check("imports.js", await env.imports("js"), []);
  const hostileImports = await env.hostileImports();
  check(
    "imports.hostile",
    hostileImports.some((name) => name.includes("hostile-io")),
    true,
  );
  const hostile = await env.tryHostile();
  check("security.hostile-not-instantiated", hostile.instantiated, false);
  check("security.hostile-error", typeof hostile.error === "string" && hostile.error.length > 0, true);

  const candidates = [
    { key: "rust", moduleId: rustModule, authorized: true, guest: rust, version: MODULES.rust.version },
    { key: "js", moduleId: jsModule, authorized: true, guest: js, version: MODULES.js.version },
  ];

  check("service.ambiguous", host.selectService(candidates, null).code, "slot.ambiguous");
  check("service.missing", host.selectService(candidates, "org.example.missing").code, "slot.missing");
  check("service.calls-unchanged-after-refusal", {
    rust: await rust.calls(),
    js: await js.calls(),
  }, { rust: 0, js: 0 });

  const selected = host.selectService(candidates, jsModule);
  check("service.explicit-js", selected.ok && selected.provider.moduleId, jsModule);

  const read0 = await host.callMeter(js, "read", null, true);
  check("meter.js.read", read0, { ok: true, value: 0, label: "js-meter" });
  check("meter.js.calls-after-read", await js.calls(), 1);

  const add3 = await host.callMeter(js, "add", 3, true);
  check("meter.js.add", add3, { ok: true, value: 3 });
  const overflow = await host.callMeter(js, "add", 2147483647, true);
  check("meter.js.overflow", overflow, { ok: false, error: "overflow" });
  const readAfter = await host.callMeter(js, "read", null, true);
  check("meter.js.value-unchanged", readAfter, { ok: true, value: 3, label: "js-meter" });
  check("meter.js.calls-after-overflow", await js.calls(), 4);

  const denied = await host.callMeter(js, "add", 1, false);
  check("meter.unauthorized", denied, { ok: false, code: "slot.unauthorized" });
  check("meter.unauthorized-did-not-enter", await js.calls(), 4);
  check("meter.rust-still-unentered", await rust.calls(), 0);

  check("lane.propose", host.propose(jsModule, 2), { ok: true, queued: true });
  check("lane.propose-did-not-enter", await js.calls(), 4);
  const during = await host.callMeter(js, "read", null, true);
  check("lane.value-before-commit", during, { ok: true, value: 3, label: "js-meter" });
  check("lane.cancel", host.cancel(jsModule), { ok: true, queued: false });
  const cancelled = await host.commit(js, jsModule);
  check("lane.cancel-applies-nothing", cancelled, { ok: true, applied: [] });
  check("lane.cancel-did-not-enter", await js.calls(), 5);

  const pending = host.beginAsync(jsModule, 4);
  check("async.pending-not-applied", pending.applied, false);
  check("async.pending-did-not-enter", await js.calls(), 5);
  const queued = host.completeAsync(pending.id, { ok: true });
  check("async.completion-queues", queued, { ok: true, applied: false, queued: true });
  check("async.completion-did-not-enter", await js.calls(), 5);
  const committed = await host.commit(js, jsModule);
  check("async.commit-applies", committed, { ok: true, applied: [{ ok: true, value: 7 }] });
  check("async.commit-one-entry", await js.calls(), 6);

  const raced = host.beginAsync(jsModule, 5);
  check("async.cancel", host.cancelAsync(raced.id), { ok: true, applied: false });
  const late = host.completeAsync(raced.id, { ok: true });
  check("async.late-after-cancel", late.applied, false);
  check("async.late-code", late.code, "async.cancelled");
  const afterLate = await host.commit(js, jsModule);
  check("async.late-not-on-later-commit", afterLate, { ok: true, applied: [] });
  check("async.late-did-not-enter", await js.calls(), 6);

  const failed = host.beginAsync(jsModule, 6);
  host.completeAsync(failed.id, { ok: false, error: "failed" });
  const failedCommit = await host.commit(js, jsModule);
  check("async.failure-does-not-mutate", failedCommit, { ok: true, applied: [] });
  const failedRead = await host.callMeter(js, "read", null, true);
  check("async.failure-value", failedRead, { ok: true, value: 7, label: "js-meter" });
  check("async.failure-calls", await js.calls(), 7);

  const rustSelected = host.selectService(candidates, rustModule);
  check("service.explicit-rust", rustSelected.provider.moduleId, rustModule);
  const rustAdd = await host.callMeter(rust, "add", 5, true);
  check("meter.rust.add", rustAdd, { ok: true, value: 5 });
  check("meter.rust.calls", await rust.calls(), 1);
  check("meter.js.untouched-by-rust-selection", await js.calls(), 7);
  const jsStill = await host.callMeter(js, "read", null, true);
  check("meter.js.value-after-rust-selection", jsStill.value, 7);

  const rustRows = await rust.contributions();
  const jsRows = await js.contributions();
  const registryCandidates = [
    { moduleId: rustModule, authorized: true, contributions: rustRows },
    { moduleId: jsModule, authorized: true, contributions: jsRows },
  ];
  const duplicate = host.registry(registryCandidates);
  check("registry.duplicate", {
    ok: duplicate.ok,
    code: duplicate.code,
    id: duplicate.id,
  }, {
    ok: false,
    code: "slot.duplicate-contribution",
    id: "shared",
  });
  check("registry.order-witness", host.orderWitness(registryCandidates), [
    { id: "js-early", order: 1, moduleId: jsModule },
    { id: "rust-early", order: 1, moduleId: rustModule },
    { id: "beta", order: 10, moduleId: jsModule },
    { id: "alpha", order: 20, moduleId: rustModule },
  ]);
  const onlyRust = host.registry([
    { moduleId: rustModule, authorized: true, contributions: rustRows },
    { moduleId: jsModule, authorized: false, contributions: jsRows },
  ]);
  check("registry.unauthorized-excluded", onlyRust, {
    ok: true,
    contributions: [
      { id: "rust-early", order: 1, label: "rust-meter", moduleId: rustModule },
      { id: "shared", order: 1, label: "rust-meter", moduleId: rustModule },
      { id: "alpha", order: 20, label: "rust-meter", moduleId: rustModule },
    ],
  });

  async function resourceCase(guest, moduleId, label, prefix) {
    const before = await guest.calls();
    const live0 = await guest.live();
    const issued = await host.issue(guest, moduleId);
    check(`${prefix}.issue`, issued.ok, true);
    const peeked = await host.peek(issued.token, COMPOSITION_ID, moduleId);
    check(`${prefix}.peek`, peeked, {
      ok: true,
      value: `${label === "js-meter" ? "js-0" : "rust-0"}|${moduleId}|${COMPOSITION_ID}`,
    });
    const consumed = await host.consume(issued.token, COMPOSITION_ID, moduleId);
    check(`${prefix}.consume`, consumed, {
      ok: true,
      value: `consumed:${label === "js-meter" ? "js-0" : "rust-0"}|${moduleId}|${COMPOSITION_ID}`,
    });
    const stale = await host.consume(issued.token, COMPOSITION_ID, moduleId);
    check(`${prefix}.stale`, stale, { ok: false, code: "resource.stale" });
    const forged = await host.consume("tok-forged", COMPOSITION_ID, moduleId);
    check(`${prefix}.forged`, forged, { ok: false, code: "resource.forged" });
    const raw = await host.consume("1", COMPOSITION_ID, moduleId);
    check(`${prefix}.raw-index-is-not-a-capability`, raw, { ok: false, code: "resource.forged" });

    const otherModule = moduleId === jsModule ? rustModule : jsModule;
    const crossIssued = await host.issue(guest, moduleId);
    const cross = await host.peek(crossIssued.token, COMPOSITION_ID, otherModule);
    check(`${prefix}.cross-module`, cross, { ok: false, code: "resource.cross-module" });
    const stillOwned = await host.consume(crossIssued.token, COMPOSITION_ID, moduleId);
    check(`${prefix}.cross-module-did-not-consume`, stillOwned.ok, true);

    const foreign = await host.issue(guest, moduleId);
    const wrongComposition = await host.peek(foreign.token, OTHER_COMPOSITION_ID, moduleId);
    check(`${prefix}.cross-composition`, wrongComposition, { ok: false, code: "resource.cross-composition" });
    check(`${prefix}.cross-composition-consume`, (await host.consume(foreign.token, COMPOSITION_ID, moduleId)).ok, true);

    const liveBeforeDrop = await guest.live();
    const dropped = await host.issue(guest, moduleId);
    check(`${prefix}.live-increased`, await guest.live(), liveBeforeDrop + 1);
    check(`${prefix}.drop`, await host.drop(dropped.token, COMPOSITION_ID, moduleId), { ok: true });
    check(`${prefix}.live-after-drop`, await guest.live(), liveBeforeDrop);
    check(`${prefix}.drop-then-consume`, await host.consume(dropped.token, COMPOSITION_ID, moduleId), {
      ok: false,
      code: "resource.stale",
    });
    check(`${prefix}.resources-did-not-enter-meter`, await guest.calls(), before);
    check(`${prefix}.live-back-to-start`, await guest.live(), live0);
  }

  await resourceCase(js, jsModule, "js-meter", "resource.js");
  await resourceCase(rust, rustModule, "rust-meter", "resource.rust");

  const jsCalls = await js.calls();
  const rustCalls = await rust.calls();
  const outstanding = await host.issue(js, jsModule);
  const inflight = host.beginAsync(jsModule, 9);
  host.shutdown();
  const lateAfterShutdown = host.completeAsync(inflight.id, { ok: true });
  check("shutdown.late-async", lateAfterShutdown, {
    ok: false,
    code: "composition.shutdown",
    applied: false,
  });
  check("shutdown.outstanding-resource", await host.consume(outstanding.token, COMPOSITION_ID, jsModule), {
    ok: false,
    code: "composition.shutdown",
  });
  check("shutdown.commit", await host.commit(js, jsModule), { ok: false, code: "composition.shutdown" });
  check("shutdown.did-not-enter", {
    js: await js.calls(),
    rust: await rust.calls(),
  }, { js: jsCalls, rust: rustCalls });

  if (env.release) {
    await env.release(rust);
    await env.release(js);
  }

  return {
    pass: cases.every((item) => item.pass),
    cases,
  };
}
