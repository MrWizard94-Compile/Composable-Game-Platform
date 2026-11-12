import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverModules } from "../foundations/discover-node.ts";
import { compose as hostCompose, type ComposeOptions, type ModulePackage } from "../foundations/host.ts";
import { IN_PROCESS_POLICY } from "../foundations/backend.ts";
import { resolveProfile, validateProfile } from "../foundations/profile.ts";
import { captureSave, restoreSave } from "../foundations/save.ts";
import { PROFILES } from "./profiles.ts";
import { CATALOG, DISPATCH_IDS, SERVICE_IDS, moduleIdOf, packagesFor, PROOF_IDS, toPackage } from "./registry.ts";
import { advanceFlora, advanceStep, askQuery, dispatchPulse, foldPipe, listEntities, readLighting, removeEntity, spawnEntity } from "./runners.ts";

const modulesDir = dirname(fileURLToPath(import.meta.url));

function compose(packages: readonly ModulePackage[], options: ComposeOptions = {}) {
  return hostCompose(packages, { policy: IN_PROCESS_POLICY, ...options });
}

function idsOf(packages: readonly ModulePackage[]): string[] {
  return packages.map((item) => moduleIdOf(item.manifest));
}

describe("packaged modules", () => {
  it("discovers the same manifests the browser catalog bundles", async () => {
    const discovered = await discoverModules(modulesDir);
    const discoveredIds = discovered.map((item) => moduleIdOf(item.manifest)).sort();
    const bundledIds = CATALOG.map((item) => moduleIdOf(item.manifest)).sort();
    assert.deepEqual(discoveredIds, bundledIds);
    for (const found of discovered) {
      const bundled = CATALOG.find((item) => moduleIdOf(item.manifest) === moduleIdOf(found.manifest));
      assert.deepEqual(found.manifest, bundled?.manifest);
      assert.equal(join(modulesDir, found.folder, "manifest.json").endsWith(`${found.folder}/manifest.json`), true);
    }
  });

  it("nests species and lights under two systems without a host special case", async () => {
    const discovered = await discoverModules(modulesDir);
    const proof = discovered.filter((item) => PROOF_IDS.includes(moduleIdOf(item.manifest)));
    const forward = compose(proof, { profileName: "proof" });
    const reverse = compose([...proof].reverse(), { profileName: "proof" });
    assert.equal(forward.ok, true);
    assert.equal(forward.fingerprint, reverse.fingerprint);
    assert.notDeepEqual(idsOf(proof), idsOf([...proof].reverse()));
    assert.deepEqual(
      forward.slots.find((slot) => slot.slotId === "platform.systems")?.contributors,
      ["org.cgp.flora-core", "org.cgp.lighting-core"],
    );
    assert.deepEqual(
      forward.contributions.filter((item) => item.slotId === "flora.plant-species").map((item) => item.id),
      ["fern", "oak", "pine"],
    );
    assert.deepEqual(
      forward.contributions.filter((item) => item.slotId === "lighting.sources").map((item) => item.id),
      ["moon", "sun", "lamp", "torch"],
    );
    assert.ok(forward.diagnostics.some((item) => item.code === "dependency.optional-missing"));
    assert.equal(forward.order[0], "org.cgp.flora-core");
    assert.ok(forward.order.indexOf("org.cgp.flora-core") < forward.order.indexOf("org.cgp.forest-plants"));
    assert.ok(forward.order.indexOf("org.cgp.lighting-core") < forward.order.indexOf("org.cgp.point-lights"));
    assert.ok(
      forward.dependencies.some(
        (item) =>
          item.providerId === "org.cgp.flora-core" &&
          item.dependentId === "org.cgp.forest-plants" &&
          item.kind === "capability" &&
          item.ref === "flora.core",
      ),
    );
    assert.ok(
      forward.dependencies.some(
        (item) =>
          item.providerId === "org.cgp.flora-core" &&
          item.dependentId === "org.cgp.forest-plants" &&
          item.kind === "slot" &&
          item.ref === "flora.plant-species",
      ),
    );
    assert.equal(
      forward.dependencies.some((item) => item.ref === "flora.soil"),
      false,
    );
  });

  it("accepts a module defined only in the test, connected to Flora's slot", async () => {
    const discovered = await discoverModules(modulesDir);
    const flora = discovered.find((item) => moduleIdOf(item.manifest) === "org.cgp.flora-core");
    if (!flora) throw new Error("missing flora core");
    const mangrove: ModulePackage = {
      manifest: {
        moduleId: "community.example.mangrove",
        name: "Mangrove",
        version: "1.0.0",
        moduleApi: ">=1.0.0 <2.0.0",
        requires: [{ capability: "flora.core", version: "^1.0.0" }],
        connectsTo: [{ slot: "flora.plant-species", contract: "flora.plant-species/1" }],
      },
      implementation: {
        register(ctx) {
          ctx.contribute("flora.plant-species", {
            id: "mangrove",
            payload: {
              id: "mangrove",
              commonName: "Mangrove",
              biome: "Coast",
              growthRate: 0.3,
              maxStage: 5,
            },
          });
        },
      },
    };
    const result = compose([mangrove, flora]);
    assert.equal(result.ok, true);
    assert.equal(
      result.contributions.find((item) => item.id === "mangrove")?.moduleId,
      "community.example.mangrove",
    );
  });

  it("adds a second species pack in module-id order", () => {
    const result = compose(packagesFor([...PROOF_IDS, "org.cgp.desert-plants"]));
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.contributions.filter((item) => item.slotId === "flora.plant-species").map((item) => item.id),
      ["cactus", "sage", "fern", "oak", "pine"],
    );
  });

  it("refuses two growth policies instead of blending them", () => {
    const result = compose(packagesFor([...PROOF_IDS, "org.cgp.accelerated-growth"]));
    assert.equal(result.runtimeActive, false);
    assert.equal(result.contributions.length, 0);
    assert.deepEqual(result.slots.find((slot) => slot.slotId === "flora.growth-model")?.contestedBy, [
      "org.cgp.accelerated-growth",
      "org.cgp.seasonal-growth",
    ]);
  });

  it("isolates a bad manifest and still runs the proof", () => {
    const result = compose(packagesFor([...PROOF_IDS, "org.cgp.bad-manifest"]));
    assert.equal(result.runtimeActive, true);
    assert.equal(result.ok, false);
    assert.equal(result.modules.find((item) => item.moduleId === "org.cgp.bad-manifest")?.status, "rejected");
    assert.equal(result.modules.find((item) => item.moduleId === "org.cgp.flora-core")?.status, "active");
  });

  it("blocks the graph on a contract mismatch and never registers the intruder", () => {
    const result = compose(
      packagesFor(["org.cgp.flora-core", "org.cgp.forest-plants", "org.cgp.contract-mismatch"]),
    );
    assert.equal(result.runtimeActive, false);
    assert.ok(result.diagnostics.some((item) => item.code === "slot.contract-mismatch"));
    assert.equal(result.trace.some((line) => line.includes("contract-mismatch")), false);
    assert.equal(result.modules.find((item) => item.moduleId === "org.cgp.flora-core")?.status, "blocked");
  });

  it("refuses the alpha/beta cycle", () => {
    const result = compose(packagesFor(["org.cgp.cycle-alpha", "org.cgp.cycle-beta"]));
    assert.equal(result.runtimeActive, false);
    assert.match(result.diagnostics.map((item) => item.message).join(" "), /Cycle Alpha|org.cgp.cycle-alpha/);
  });

  it("rolls the proof back when a package throws during initialize", () => {
    const result = compose(packagesFor([...PROOF_IDS, "org.cgp.init-fault"]));
    assert.equal(result.runtimeActive, false);
    assert.equal(result.contributions.length, 0);
    assert.match(result.diagnostics.map((item) => item.message).join(" "), /init-fault refused/);
    assert.equal(result.modules.find((item) => item.moduleId === "org.cgp.init-fault")?.status, "rejected");
    assert.equal(result.modules.find((item) => item.moduleId === "org.cgp.flora-core")?.status, "blocked");
    assert.ok(result.trace.includes("org.cgp.flora-core:shutdown"));
  });

  it("steps seasonal growth deterministically and reads both light packs", () => {
    const result = compose(CATALOG.filter((item) => item.defaultOn).map(toPackage));
    const first = advanceFlora(result, {}, "spring");
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const oak = first.rows.find((row) => row.id === "oak");
    assert.equal(oak?.stage, 0.4);
    assert.equal(first.strategy, "Seasonal growth");
    const second = advanceFlora(result, { oak: oak?.stage ?? 0 }, "spring");
    if (!second.ok) assert.fail(second.reason);
    assert.equal(second.rows.find((row) => row.id === "oak")?.stage, 0.8);
    const winter = advanceFlora(result, {}, "winter");
    if (!winter.ok) assert.fail(winter.reason);
    assert.equal(winter.rows.find((row) => row.id === "oak")?.stage, 0.04);
    const lights = readLighting(result);
    assert.equal(lights.ok, true);
    if (!lights.ok) return;
    assert.equal(lights.total, 12);
    assert.deepEqual(
      lights.sources.map((source) => source.id),
      ["moon", "sun", "lamp", "torch"],
    );
  });

  it("fans a pulse out and folds a pipe without depending on package order", () => {
    const ids = [...PROOF_IDS, ...DISPATCH_IDS];
    const forward = compose(packagesFor(ids));
    const reverse = compose([...packagesFor(ids)].reverse());
    assert.equal(forward.ok, true);
    assert.equal(forward.fingerprint, reverse.fingerprint);
    const pulse = dispatchPulse(forward);
    assert.equal(pulse.report.ok, true);
    assert.deepEqual(pulse.heard, ["stamp", "late"]);
    const folded = foldPipe(reverse, 4);
    assert.equal(folded.ok, true);
    assert.equal(folded.output, 11);
    assert.deepEqual(
      folded.stages.map((stage) => stage.contributionId),
      ["double", "offset"],
    );
  });

  it("keeps later listeners after a throw and stops the pipe at a fault", () => {
    const result = compose(
      packagesFor([...DISPATCH_IDS, "org.cgp.signal-fault", "org.cgp.pipe-fault"]),
    );
    assert.equal(result.ok, true);
    const pulse = dispatchPulse(result);
    assert.equal(pulse.report.ok, false);
    assert.deepEqual(pulse.heard, ["stamp", "late"]);
    assert.equal(pulse.report.deliveries.find((item) => item.contributionId === "fault")?.code, "dispatch.threw");
    const folded = foldPipe(result, 4);
    assert.equal(folded.ok, false);
    assert.equal(folded.output, 8);
    assert.equal(folded.stages.some((stage) => stage.contributionId === "offset"), false);
  });

  it("saves the pulse count and restores an older minor of the same major", () => {
    const result = compose(packagesFor([...DISPATCH_IDS]), { profileName: "preview" });
    dispatchPulse(result);
    dispatchPulse(result);
    const captured = captureSave(result);
    assert.equal(captured.ok, true);
    assert.deepEqual(
      captured.document.slices.find((slice) => slice.moduleId === "org.cgp.pulse-count")?.payload,
      { heard: 2 },
    );
    const restored = restoreSave(result, {
      ...captured.document,
      slices: [{ moduleId: "org.cgp.pulse-count", version: "1.1.0", payload: { heard: 5 } }],
    });
    assert.equal(restored.ok, true);
    dispatchPulse(result);
    assert.deepEqual(
      captureSave(result).document.slices.find((slice) => slice.moduleId === "org.cgp.pulse-count")?.payload,
      { heard: 6 },
    );
  });

  it("calls the one query provider and refuses a second", () => {
    const result = compose(packagesFor([...SERVICE_IDS]));
    assert.equal(result.ok, true);
    const asked = askQuery(result, "alpha");
    assert.equal(asked.report.ok, true);
    assert.deepEqual(asked.report.output, { question: "alpha", letters: 5 });
    const clash = compose(packagesFor([...SERVICE_IDS, "org.cgp.alias-index"]));
    assert.equal(clash.runtimeActive, false);
    assert.ok(clash.diagnostics.some((item) => item.code === "slot.ambiguous"));
    const refused = askQuery(clash, "alpha");
    assert.equal(refused.report.ok, false);
    assert.equal(refused.report.reason, "Runtime is not active.");
  });

  it("stores entity records and advances a step only when the caller asks", () => {
    const ids = [
      "org.cgp.world-core",
      "org.cgp.world-store",
      "org.cgp.step-core",
      "org.cgp.step-clock",
      "org.cgp.step-witness",
    ];
    const result = compose(packagesFor(ids), { profileName: "records" });
    assert.equal(result.runtimeActive, true, result.diagnostics.map((item) => item.message).join("\n"));
    const first = spawnEntity(result, { label: "marker" });
    const second = spawnEntity(result, { label: "other" });
    assert.equal(first.ok, true);
    assert.deepEqual(first.output, { id: "e1" });
    assert.deepEqual(second.output, { id: "e2" });
    assert.equal(removeEntity(result, "e1").ok, true);
    assert.deepEqual(
      listEntities(result).map((item) => item.id),
      ["e2"],
    );
    assert.equal(advanceStep(result).count, 1);
    const again = advanceStep(result);
    assert.equal(again.count, 2);
    assert.equal(again.deliveries, 1);

    const saved = captureSave(result);
    assert.equal(saved.ok, true);
    const fresh = compose(packagesFor(ids), { profileName: "records" });
    const restored = restoreSave(fresh, saved.document);
    assert.equal(restored.ok, true);
    assert.deepEqual(
      listEntities(fresh).map((item) => item.id),
      ["e2"],
    );
    const third = spawnEntity(fresh, { label: "next" });
    assert.deepEqual(third.output, { id: "e3" });
    assert.equal(advanceStep(fresh).count, 3);
  });

  it("resolves shipped profiles to the same graph and refuses a version the package does not have", () => {
    const available = CATALOG.map(toPackage);
    for (const item of PROFILES) {
      const checked = validateProfile(item.profile);
      assert.equal(checked.ok, true, item.id);
      if (!checked.ok) continue;
      const resolved = resolveProfile(checked.profile, available);
      if (item.id === "wrong-version") {
        assert.equal(resolved.ok, false);
        if (!resolved.ok) assert.equal(resolved.errors[0]?.code, "profile.version");
        continue;
      }
      if (item.id === "two-providers") {
        assert.equal(resolved.ok, true, item.id);
        if (!resolved.ok) continue;
        const result = compose(resolved.packages);
        assert.equal(result.runtimeActive, false);
        assert.ok(result.diagnostics.some((item) => item.code === "dependency.ambiguous"));
        continue;
      }
      assert.equal(resolved.ok, true, item.id);
      if (!resolved.ok) continue;
      const ids = checked.profile.modules.map((pin) => pin.moduleId);
      const viaProfile = compose(resolved.packages, { profileName: checked.profile.profileId });
      const viaIds = compose(packagesFor(ids), { profileName: checked.profile.profileId });
      assert.equal(viaProfile.fingerprint, viaIds.fingerprint);
    }
  });
});
