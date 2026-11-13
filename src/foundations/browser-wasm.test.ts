import { describe, it } from "node:test";
import { runBrowserCompositionCheck, runBrowserWasmCheck } from "../../scripts/browser-wasm.ts";

describe("chromium isolate", () => {
  it("runs the shared guest runtime in a real browser worker", { timeout: 60_000 }, async () => {
    await runBrowserWasmCheck();
  });

  it("composes a guest with createBrowserWasmBackend in Chromium", { timeout: 60_000 }, async () => {
    await runBrowserCompositionCheck();
  });
});
