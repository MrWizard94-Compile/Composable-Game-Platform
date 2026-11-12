import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isValidRange, satisfies } from "./semver.ts";

describe("version ranges", () => {
  it("matches exact, caret, tilde, and comparator sets", () => {
    assert.equal(satisfies("1.2.3", "1.2.3"), true);
    assert.equal(satisfies("1.2.4", "1.2.3"), false);
    assert.equal(satisfies("1.4.0", "^1.2.3"), true);
    assert.equal(satisfies("2.0.0", "^1.2.3"), false);
    assert.equal(satisfies("0.2.9", "^0.2.3"), true);
    assert.equal(satisfies("0.3.0", "^0.2.3"), false);
    assert.equal(satisfies("1.2.9", "~1.2.3"), true);
    assert.equal(satisfies("1.3.0", "~1.2.3"), false);
    assert.equal(satisfies("1.0.0", ">=1.0.0 <2.0.0"), true);
    assert.equal(satisfies("2.0.0", ">=1.0.0 <2.0.0"), false);
    assert.equal(isValidRange("nope"), false);
    assert.equal(satisfies("1.0.0", "nope"), false);
  });
});
