import { createBrowserWasmBackend } from "../src/foundations/wasm-browser.ts";
import { compose } from "../src/foundations/host.ts";
import { templateGuest, wasiGuest, withCustomPadding } from "../src/foundations/wasm-build.ts";

function manifest(moduleId: string) {
  return {
    moduleId,
    name: moduleId.split(".").at(-1) ?? moduleId,
    version: "1.0.0",
    moduleApi: ">=1.0.0 <2.0.0",
    connectsTo: [{ slot: "platform.systems", contract: "platform.system/1" }],
  };
}

/**
 * One composition on the real browser isolate. The page must not inject a fake worker.
 */
export async function runBrowserComposition(): Promise<{
  active: boolean;
  contributionId: string;
  wasi: string;
  padded: boolean;
  paddedDetail: string;
  sessions: number;
  detail: string;
}> {
  const backend = createBrowserWasmBackend();
  const policy = { allowGrants: [], maxHookMs: 1000, maxMemoryBytes: 65536, maxBinaryBytes: 65536 } as const;
  const result = await compose([{ manifest: manifest("org.example.starter"), implementation: { wasm: templateGuest() } }], {
    backend,
    policy,
  });
  const wasi = await compose([{ manifest: manifest("org.example.wasi"), implementation: { wasm: wasiGuest() } }], {
    backend,
    policy,
  });
  if (result.runtimeActive) await result.shutdown();
  const paddedBytes = withCustomPadding(templateGuest(), 70_000);
  const padded = await compose([{ manifest: manifest("org.example.padded"), implementation: { wasm: paddedBytes } }], {
    backend,
    policy: { allowGrants: [], maxHookMs: 1000, maxMemoryBytes: 65536, maxBinaryBytes: paddedBytes.byteLength },
  });
  if (padded.runtimeActive) await padded.shutdown();
  return {
    active: result.runtimeActive,
    contributionId: result.contributions.find((item) => item.slotId === "platform.systems")?.id ?? "",
    detail: result.diagnostics.map((item) => item.message).join("\n"),
    wasi: wasi.diagnostics.map((item) => item.message).join("\n"),
    padded: padded.runtimeActive,
    paddedDetail: padded.diagnostics.map((item) => item.message).join("\n"),
    sessions: backend.openSessions(),
  };
}
