import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compose as hostCompose } from "./host.ts";
import { IN_PROCESS_POLICY } from "./backend.ts";
import { resolveProfile, unresolvedProfile, validateProfile, type CompositionProfile } from "./profile.ts";

function compose(packages: readonly { manifest: unknown }[] = []) {
  return hostCompose(packages, { policy: IN_PROCESS_POLICY });
}

function profile(modules: CompositionProfile["modules"], extra: Record<string, unknown> = {}) {
  return {
    profileId: "org.example.desk",
    name: "Desk",
    modules,
    ...extra,
  };
}

function pkg(moduleId: string, version = "1.0.0") {
  return {
    manifest: {
      moduleId,
      name: "Piece",
      version,
      moduleApi: ">=1.0.0 <2.0.0",
    },
  };
}

describe("profiles", () => {
  it("rejects an unknown field, a duplicate pin, and a version that is not exact", () => {
    const extra = validateProfile(profile([{ moduleId: "org.example.one", version: "1.0.0" }], { note: true }));
    assert.equal(extra.ok, false);
    if (!extra.ok) assert.ok(extra.errors.some((item) => item.message.includes("note")));

    const twice = validateProfile(
      profile([
        { moduleId: "org.example.one", version: "1.0.0" },
        { moduleId: "org.example.one", version: "1.0.0" },
      ]),
    );
    assert.equal(twice.ok, false);
    if (!twice.ok) assert.ok(twice.errors.some((item) => item.code === "profile.duplicate"));

    const fuzzy = validateProfile(profile([{ moduleId: "org.example.one", version: "^1.0.0" }]));
    assert.equal(fuzzy.ok, false);
  });

  it("returns the pinned packages in profile order and refuses a miss or a different version", async () => {
    const checked = validateProfile(
      profile([
        { moduleId: "org.example.beta", version: "1.0.0" },
        { moduleId: "org.example.alpha", version: "1.0.0" },
      ]),
    );
    assert.equal(checked.ok, true);
    if (!checked.ok) return;
    const available = [pkg("org.example.alpha"), pkg("org.example.other", "2.0.0"), pkg("org.example.beta")];
    const resolved = resolveProfile(checked.profile, available);
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.deepEqual(
      resolved.packages.map((item) => (item.manifest as { moduleId: string }).moduleId),
      ["org.example.beta", "org.example.alpha"],
    );

    const missing = resolveProfile(
      { ...checked.profile, modules: [{ moduleId: "org.example.gone", version: "1.0.0" }] },
      available,
    );
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.errors[0]?.code, "profile.missing");

    const drifted = resolveProfile(checked.profile, [pkg("org.example.beta", "1.1.0"), pkg("org.example.alpha")]);
    assert.equal(drifted.ok, false);
    if (!drifted.ok) {
      assert.equal(drifted.errors[0]?.code, "profile.version");
      assert.match(drifted.errors[0]?.message ?? "", /1\.1\.0/);
    }

    const refused = unresolvedProfile("org.example.desk", drifted.ok ? [] : drifted.errors);
    assert.equal(refused.runtimeActive, false);
    assert.equal((await compose([])).runtimeActive, true);
    assert.notEqual(refused.fingerprint, (await compose([])).fingerprint);
  });
});
