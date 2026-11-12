import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverModules } from "../foundations/discover-node.ts";
import { compose, type ModulePackage } from "../foundations/host.ts";
import { CATALOG, moduleIdOf, packagesFor, PROOF_IDS, toPackage } from "./registry.ts";
import { advanceFlora, readLighting } from "./runners.ts";

const modulesDir = dirname(fileURLToPath(import.meta.url));

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
});
