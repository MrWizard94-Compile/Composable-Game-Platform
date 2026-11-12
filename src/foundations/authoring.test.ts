import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compose, contributionsFor, type ModuleImplementation } from "./host.ts";
import { validateManifest } from "./manifest.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const folder = join(root, "examples/starter-module");

describe("starter module", () => {
  it("validates, loads, and contributes without being part of the catalog", async () => {
    const source = readFileSync(join(folder, "module.ts"), "utf8");
    assert.match(source, /from "\.\.\/\.\.\/src\/foundations\/index\.ts"/);
    assert.doesNotMatch(source, /foundations\/(?:host|manifest|dispatch|save)/);

    const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8")) as unknown;
    const checked = validateManifest(manifest);
    assert.equal(checked.ok, true);

    const loaded = (await import(pathToFileURL(join(folder, "module.ts")).href)) as {
      implementation?: ModuleImplementation;
    };
    const result = compose([{ manifest, implementation: loaded.implementation }]);
    assert.equal(result.ok, true);
    assert.equal(result.runtimeActive, true);
    const rows = contributionsFor(result, "platform.systems");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, "starter");
    assert.equal(rows[0]?.moduleId, "org.example.starter");
  });

  it("diagnoses an unknown field and a contract the platform slot does not offer", () => {
    const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8")) as Record<string, unknown>;
    const extra = validateManifest({ ...manifest, extra: true });
    assert.equal(extra.ok, false);
    if (extra.ok) return;
    assert.ok(extra.errors.some((item) => item.code === "manifest.field"));

    const wrong = {
      ...manifest,
      connectsTo: [{ slot: "platform.systems", contract: "platform.system/2" }],
    };
    const result = compose([{ manifest: wrong }]);
    assert.equal(result.runtimeActive, false);
    assert.ok(result.diagnostics.some((item) => item.code === "slot.contract-mismatch"));
  });
});
