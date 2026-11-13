import { describe, it } from "node:test";
import { runBrowserWasmCheck } from "../../scripts/browser-wasm.ts";

describe("chromium isolate", () => {
  it("runs the shared guest runtime in a real browser worker", { timeout: 60_000 }, async () => {
    await runBrowserWasmCheck();
  });
});
