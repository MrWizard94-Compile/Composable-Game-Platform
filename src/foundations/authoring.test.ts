import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkWasmPackage } from "../../scripts/check-wasm-module.ts";
import {
  guestFromContributions,
  hugeTableGuest,
  missingAbiGuest,
  scriptedGuest,
  sharedGuest,
  startLoopGuest,
  unboundedGuest,
  wasiGuest,
  wideGuest,
  withCustomPadding,
} from "./wasm-build.ts";
import {
  compose as composeClosed,
  contributionsFor,
  isCallablePayload,
  slotRequiresCallable,
  validateManifest,
  type ComposeOptions,
  type ModuleImplementation,
  type ModulePackage,
  IN_PROCESS_POLICY,
} from "./index.ts";

function compose(packages: readonly ModulePackage[], options: ComposeOptions = {}) {
  return composeClosed(packages, { policy: IN_PROCESS_POLICY, ...options });
}

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
    if (checked.ok) assert.equal(checked.manifest.license, "MIT");

    const placeholder = validateManifest({ ...(manifest as Record<string, unknown>), license: "Not yet licensed" });
    assert.equal(placeholder.ok, false);

    const loaded = (await import(pathToFileURL(join(folder, "module.ts")).href)) as {
      implementation?: ModuleImplementation;
    };
    const result = await compose([{ manifest, implementation: loaded.implementation }]);
    assert.equal(result.ok, true);
    assert.equal(result.runtimeActive, true);
    const rows = contributionsFor(result, "platform.systems");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, "starter");
    assert.equal(rows[0]?.moduleId, "org.example.starter");
  });

  it("diagnoses an unknown field and a contract the platform slot does not offer", async () => {
    const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8")) as Record<string, unknown>;
    const extra = validateManifest({ ...manifest, extra: true });
    assert.equal(extra.ok, false);
    if (extra.ok) return;
    assert.ok(extra.errors.some((item) => item.code === "manifest.field"));

    const wrong = {
      ...manifest,
      connectsTo: [{ slot: "platform.systems", contract: "platform.system/2" }],
    };
    const result = await compose([{ manifest: wrong }]);
    assert.equal(result.runtimeActive, false);
    assert.ok(result.diagnostics.some((item) => item.code === "slot.contract-mismatch"));
  });

  it("exports the slot payload contract from the public barrel", async () => {
    assert.equal(slotRequiresCallable("service"), true);
    assert.equal(slotRequiresCallable("pipeline"), true);
    assert.equal(slotRequiresCallable("subscriber"), true);
    assert.equal(slotRequiresCallable("registry"), false);
    assert.equal(isCallablePayload(() => 1), true);
    assert.equal(isCallablePayload({ handle() {} }), true);
    assert.equal(isCallablePayload({ note: true }), false);
  });
});

describe("third-party wasm package", () => {
  it("checks a guest built from guest.json", async () => {
    const report = await checkWasmPackage(join(root, "examples/third-party-module"));
    assert.equal(report.ok, true, report.ok ? "" : report.errors.join("\n"));
    if (!report.ok) return;
    assert.equal(report.moduleId, "org.example.beacon");
    assert.deepEqual(report.contributions, [{ slotId: "platform.systems", id: "beacon", moduleId: "org.example.beacon" }]);
  });

  it("refuses malformed and hostile packages", async () => {
    const beacon = [{ slotId: "platform.systems", id: "beacon", payload: { systemId: "beacon" } }];
    const beaconWasm = guestFromContributions(beacon);
    const manifest = JSON.stringify({
      moduleId: "org.example.beacon",
      name: "Beacon",
      version: "1.0.0",
      moduleApi: ">=1.0.0 <2.0.0",
      connectsTo: [{ slot: "platform.systems", contract: "platform.system/1" }],
      license: "MIT",
    });
    const cases: Array<{ name: string; files: Record<string, string | Uint8Array>; pattern: RegExp }> = [
      { name: "no-manifest", files: { "module.wasm": beaconWasm }, pattern: /manifest\.json is missing/ },
      { name: "no-wasm", files: { "manifest.json": manifest }, pattern: /module\.wasm is missing/ },
      { name: "not-json-manifest", files: { "manifest.json": "{", "module.wasm": beaconWasm }, pattern: /manifest\.json is not JSON/ },
      {
        name: "unknown-field",
        files: { "manifest.json": manifest.replace('"MIT"', '"MIT", "extra": true'), "module.wasm": beaconWasm },
        pattern: /Unknown manifest field "extra"/,
      },
      {
        name: "sibling-source",
        files: { "manifest.json": manifest, "module.wasm": beaconWasm, "module.ts": "export {};\n" },
        pattern: /no module\.ts/,
      },
      {
        name: "guest-not-json",
        files: { "manifest.json": manifest, "module.wasm": beaconWasm, "guest.json": "{" },
        pattern: /guest\.json is not JSON/,
      },
      {
        name: "guest-shape",
        files: { "manifest.json": manifest, "module.wasm": beaconWasm, "guest.json": "{}" },
        pattern: /contributions array/,
      },
      {
        name: "guest-mismatch",
        files: {
          "manifest.json": manifest,
          "module.wasm": beaconWasm,
          "guest.json": JSON.stringify({ contributions: [{ slotId: "platform.systems", id: "other" }] }),
        },
        pattern: /does not match guest\.json/,
      },
      { name: "not-wasm", files: { "manifest.json": manifest, "module.wasm": Uint8Array.from([1, 2, 3, 4]) }, pattern: /not WebAssembly/ },
      {
        name: "truncated",
        files: { "manifest.json": manifest, "module.wasm": beaconWasm.slice(0, 20) },
        pattern: /Truncated WebAssembly/,
      },
      { name: "wasi", files: { "manifest.json": manifest, "module.wasm": wasiGuest() }, pattern: /Unauthorized import wasi_snapshot_preview1/ },
      { name: "unbounded", files: { "manifest.json": manifest, "module.wasm": unboundedGuest() }, pattern: /no maximum/ },
      { name: "shared", files: { "manifest.json": manifest, "module.wasm": sharedGuest() }, pattern: /shared memory/ },
      { name: "wide", files: { "manifest.json": manifest, "module.wasm": wideGuest() }, pattern: /131072/ },
      { name: "table", files: { "manifest.json": manifest, "module.wasm": hugeTableGuest() }, pattern: /table maximum/ },
      { name: "missing-abi", files: { "manifest.json": manifest, "module.wasm": missingAbiGuest() }, pattern: /did not export the ABI/ },
      {
        name: "padded",
        files: { "manifest.json": manifest, "module.wasm": withCustomPadding(beaconWasm, 70_000) },
        pattern: /binary limit is 65536/,
      },
      {
        name: "torn-register",
        files: { "manifest.json": manifest, "module.wasm": scriptedGuest({ register: "{" }) },
        pattern: /Guest result was not JSON/,
      },
      {
        name: "bad-contributions",
        files: { "manifest.json": manifest, "module.wasm": scriptedGuest({ register: '{"contributions":{}}' }) },
        pattern: /contributions must be an array/,
      },
      {
        name: "null-row",
        files: { "manifest.json": manifest, "module.wasm": scriptedGuest({ register: '{"contributions":[null]}' }) },
        pattern: /missing a slot or an id/,
      },
    ];
    for (const item of cases) {
      const report = await checkHostile(item.files);
      assert.equal(report.ok, false, item.name);
      if (report.ok) continue;
      assert.match(report.errors.join("\n"), item.pattern, `${item.name}: ${report.errors.join(" | ")}`);
    }

    const looping = await Promise.race([
      checkHostile({ "manifest.json": manifest, "module.wasm": startLoopGuest() }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("hostile package hung")), 4000)),
    ]);
    assert.equal(looping.ok, false);
    if (!looping.ok) assert.match(looping.errors.join("\n"), /Time limit exceeded/);

    const again = await checkWasmPackage(join(root, "examples/third-party-module"));
    assert.equal(again.ok, true, again.ok ? "" : again.errors.join("\n"));
  });
});

async function checkHostile(files: Record<string, string | Uint8Array>) {
  const dir = mkdtempSync(join(tmpdir(), "cgp-hostile-"));
  try {
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(dir, name), body);
    }
    return await checkWasmPackage(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
