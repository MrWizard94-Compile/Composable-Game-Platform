import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, existsSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { chromium } from "playwright";
import { templateGuest, wasiGuest } from "../src/foundations/wasm-build.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
};

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Browser test server has no port."));
        return;
      }
      resolve(address.port);
    });
  });
}

/**
 * Loads the real browser worker in Chromium and runs one accepted guest and one refused guest.
 * This is not the Node worker pretending to be a page.
 */
export async function runBrowserWasmCheck(): Promise<void> {
  const store = Buffer.from(templateGuest()).toString("base64");
  const wasi = Buffer.from(wasiGuest()).toString("base64");
  const pageHtml = `<!doctype html><meta charset="utf-8"><title>browser isolate</title>`;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/" || url.pathname === "/harness.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(pageHtml);
      return;
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (relative.includes("..")) {
      response.writeHead(403);
      response.end();
      return;
    }
    const path = join(root, relative);
    if (!existsSync(path)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
    response.end(readFileSync(path));
  });
  const port = await listen(server);
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    const failed: string[] = [];
    page.on("pageerror", (error) => failed.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/harness.html`);
    const result = await page.evaluate(
      async ({ storeBytes, wasiBytes }) => {
        const decode = (encoded: string) => {
          const binary = atob(encoded);
          const out = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
          return out;
        };
        const run = (encoded: string) =>
          new Promise<{ ok: boolean; text: string; realWorker: boolean }>((resolve) => {
            const worker = new Worker(new URL("/src/foundations/wasm-worker-browser.mjs", location.origin), { type: "module" });
            const timer = setTimeout(() => {
              worker.terminate();
              resolve({ ok: false, text: "timed out", realWorker: worker instanceof Worker });
            }, 5000);
            worker.onmessage = (event: MessageEvent<{ ok?: boolean; text?: string }>) => {
              const text = event.data?.text ?? "";
              if (text === "loaded") {
                worker.postMessage({ id: 2, op: "hook", hook: 0, json: "{}", maxBytes: 65536 });
                return;
              }
              clearTimeout(timer);
              worker.terminate();
              resolve({ ok: event.data?.ok === true, text, realWorker: worker instanceof Worker });
            };
            worker.onerror = (event) => {
              clearTimeout(timer);
              resolve({ ok: false, text: event.message || "worker error", realWorker: worker instanceof Worker });
            };
            worker.postMessage({ id: 1, op: "load", wasm: decode(encoded), allowLog: false, maxBytes: 65536, maxBinaryBytes: 65536 });
          });
        return { good: await run(storeBytes), bad: await run(wasiBytes) };
      },
      { storeBytes: store, wasiBytes: wasi },
    );
    if (failed.length > 0) throw new Error(failed.join("\n"));
    if (!result.good.realWorker || !result.good.ok || !result.good.text.includes("starter")) {
      throw new Error(`Browser guest did not run: ${JSON.stringify(result.good)}`);
    }
    if (result.bad.ok || !/Unauthorized import wasi_snapshot_preview1/.test(result.bad.text)) {
      throw new Error(`Browser guest accepted a forbidden import: ${JSON.stringify(result.bad)}`);
    }
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

/**
 * Bundles the host and runs `createBrowserWasmBackend()` inside Chromium.
 * The worker is the browser's Worker, not a test double.
 */
export async function runBrowserCompositionCheck(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cgp-browser-"));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/" || url.pathname === "/harness.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><meta charset=\"utf-8\"><title>browser composition</title>");
      return;
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (relative.includes("..")) {
      response.writeHead(403);
      response.end();
      return;
    }
    const path = join(dir, relative);
    if (!existsSync(path)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": types[extname(path)] ?? "text/javascript; charset=utf-8" });
    response.end(readFileSync(path));
  });
  try {
    await esbuild.build({
      absWorkingDir: root,
      entryPoints: ["scripts/browser-compose-entry.ts"],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      outfile: join(dir, "compose.js"),
    });
    // esbuild leaves `new URL("./wasm-worker-browser.mjs", import.meta.url)` intact.
    // Publish that module and the runtime it imports beside the bundle so Chromium loads the real worker.
    cpSync(join(root, "src/foundations/wasm-worker-browser.mjs"), join(dir, "wasm-worker-browser.mjs"));
    cpSync(join(root, "src/foundations/wasm-guest-runtime.mjs"), join(dir, "wasm-guest-runtime.mjs"));
    const port = await listen(server);
    const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    try {
      const page = await browser.newPage();
      const failed: string[] = [];
      page.on("pageerror", (error) => failed.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") failed.push(message.text());
      });
      await page.goto(`http://127.0.0.1:${port}/harness.html`);
      const report = await page.evaluate(async (href: string) => {
        const loaded = (await import(href)) as {
          runBrowserComposition: () => Promise<{
            active: boolean;
            contributionId: string;
            wasi: string;
            padded: boolean;
            paddedDetail: string;
            sessions: number;
            detail: string;
          }>;
        };
        return loaded.runBrowserComposition();
      }, "/compose.js");
      if (failed.length > 0) throw new Error(failed.join("\n"));
      if (report.active !== true || report.contributionId !== "starter") {
        throw new Error(`Browser composition did not contribute: ${JSON.stringify(report)}`);
      }
      if (typeof report.wasi !== "string" || !/Unauthorized import wasi_snapshot_preview1/.test(report.wasi)) {
        throw new Error(`Browser composition accepted a forbidden import: ${JSON.stringify(report)}`);
      }
      if (report.padded !== true) {
        throw new Error(`Browser composition tied binary size to linear memory: ${JSON.stringify(report)}`);
      }
      if (report.sessions !== 0) {
        throw new Error(`Browser composition left a session open: ${JSON.stringify(report)}`);
      }
    } finally {
      await browser.close();
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    rmSync(dir, { recursive: true, force: true });
  }
}

export type BrowserSimReport = {
  mixed: boolean;
  continuous: unknown;
  resumed: unknown;
  heardContinuous: unknown;
  heardResumed: unknown;
  race: unknown;
  raceHeard: unknown;
  sameTick: number;
  blockedLedger: unknown;
  blockedWitness: unknown;
  blocked: boolean;
  orderedLedger: unknown;
  orderedHeard: unknown;
  pairedEarly: unknown;
  pairedLate: unknown;
  subscriberLedger: unknown;
  subscriberWitness: unknown;
  subscriberLate: unknown;
  sessions: number;
  guests: number;
  memoryBytes: number;
  binaryBytes: number;
};

/**
 * Runs the mixed simulation proof in Chromium through `createBrowserWasmBackend()`.
 */
export async function runBrowserSimulationCheck(): Promise<BrowserSimReport> {
  const dir = mkdtempSync(join(tmpdir(), "cgp-browser-sim-"));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/" || url.pathname === "/harness.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><meta charset=\"utf-8\"><title>browser simulation</title>");
      return;
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (relative.includes("..")) {
      response.writeHead(403);
      response.end();
      return;
    }
    const path = join(dir, relative);
    if (!existsSync(path)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": types[extname(path)] ?? "text/javascript; charset=utf-8" });
    response.end(readFileSync(path));
  });
  try {
    await esbuild.build({
      absWorkingDir: root,
      entryPoints: ["scripts/browser-compose-entry.ts"],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      outfile: join(dir, "compose.js"),
    });
    cpSync(join(root, "src/foundations/wasm-worker-browser.mjs"), join(dir, "wasm-worker-browser.mjs"));
    cpSync(join(root, "src/foundations/wasm-guest-runtime.mjs"), join(dir, "wasm-guest-runtime.mjs"));
    const port = await listen(server);
    const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    try {
      const page = await browser.newPage();
      const failed: string[] = [];
      page.on("pageerror", (error) => failed.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") failed.push(message.text());
      });
      await page.goto(`http://127.0.0.1:${port}/harness.html`);
      const report = await page.evaluate(async (href: string) => {
        const loaded = (await import(href)) as { runBrowserSimulation: () => Promise<BrowserSimReport> };
        return loaded.runBrowserSimulation();
      }, "/compose.js");
      if (failed.length > 0) throw new Error(failed.join("\n"));
      return report;
    } finally {
      await browser.close();
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runBrowserWasmCheck();
  await runBrowserCompositionCheck();
  await runBrowserSimulationCheck();
  console.log("browser wasm ok");
}
