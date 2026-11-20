import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, firefox } from "playwright";
import { openJco } from "../host/jco-adapter.mjs";
import { evaluate } from "../host/vectors.mjs";
import {
  openWasmtime,
  wasmtimeImports,
  wasmtimeTryInstantiate,
} from "../host/wasmtime-adapter.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const bin = process.env.WASMTIME_HOST ?? join(root, "target/release/wasmtime-host");
const tools = process.env.CGP_WIT_TOOLS ?? "/tmp/cgp-wit-tools/bin";

const components = {
  rust: join(dist, "rust-meter.wasm"),
  js: join(dist, "js-meter.wasm"),
  hostile: join(dist, "hostile.wasm"),
};

function wasmToolsImports(path) {
  const result = spawnSync(join(tools, "wasm-tools"), ["component", "wit", path], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `wasm-tools exited ${result.status}`);
  }
  const names = [];
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/^\s*import\s+([^\s;]+)/);
    if (match) names.push(match[1]);
  }
  return names.sort();
}

function jcoEnv(kind) {
  const baseName = kind === "rust" ? "rust-meter" : "js-meter";
  const dir = pathToFileURL(`${join(dist, "transpile", kind)}/`);
  return {
    async open() {
      return openJco(new URL(`${baseName}.js`, dir).href, async (path) => {
        const bytes = await readFile(new URL(path, dir));
        return WebAssembly.compile(bytes);
      });
    },
  };
}

async function runWasmtime() {
  const imports = {
    rust: await wasmtimeImports(bin, components.rust),
    js: await wasmtimeImports(bin, components.js),
  };
  const hostileImports = await wasmtimeImports(bin, components.hostile);
  const hostile = await wasmtimeTryInstantiate(bin, components.hostile);
  const opened = [];
  const report = await evaluate({
    async open(kind) {
      const guest = openWasmtime(bin, components[kind]);
      opened.push(guest);
      await guest.load();
      return guest;
    },
    async imports(kind) {
      return imports[kind];
    },
    async hostileImports() {
      return hostileImports;
    },
    async tryHostile() {
      return hostile;
    },
    async release(guest) {
      await guest.release();
    },
  });
  for (const guest of opened) await guest.release().catch(() => {});
  return { runtime: "wasmtime", execution: "native-component", ...report };
}

async function runJco(label) {
  const toolImports = {
    rust: await wasmToolsImports(components.rust),
    js: await wasmToolsImports(components.js),
  };
  const hostileImports = await wasmToolsImports(components.hostile);
  const hostileDir = pathToFileURL(`${join(dist, "transpile", "hostile")}/`);
  const opened = [];
  const report = await evaluate({
    async open(kind) {
      const guest = await jcoEnv(kind).open();
      opened.push(guest);
      return guest;
    },
    async imports(kind) {
      return toolImports[kind];
    },
    async hostileImports() {
      return hostileImports;
    },
    async tryHostile() {
      try {
        await openJco(new URL("hostile.js", hostileDir).href, async (path) => {
          const bytes = await readFile(new URL(path, hostileDir));
          return WebAssembly.compile(bytes);
        });
        return { instantiated: true, error: "" };
      } catch (error) {
        return { instantiated: false, error: String(error && error.stack ? error.stack : error) };
      }
    },
  });
  for (const guest of opened) await guest.release?.().catch(() => {});
  return {
    runtime: label,
    execution: "jco-transpile-core-wasm-plus-js",
    nativeComponent: false,
    ...report,
  };
}

function contentType(path) {
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript";
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".html")) return "text/html";
  return "application/octet-stream";
}

function serve(rootDir) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const path = join(rootDir, decodeURIComponent(url.pathname));
      const rel = relative(rootDir, path);
      if (rel.startsWith("..")) {
        response.writeHead(403);
        response.end();
        return;
      }
      const bytes = await readFile(path);
      response.writeHead(200, { "content-type": contentType(path) });
      response.end(bytes);
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolvePromise({ server, port: address.port });
    });
  });
}

async function runBrowser(name, browserType) {
  let browser;
  try {
    browser = await browserType.launch();
  } catch (error) {
    return {
      runtime: name,
      execution: "jco-transpile-core-wasm-plus-js",
      nativeComponent: false,
      supported: false,
      pass: false,
      unsupported: true,
      error: String(error && error.message ? error.message : error),
      cases: [],
    };
  }
  const { server, port } = await serve(root);
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${port}/browser/page.html`, { waitUntil: "load" });
    await page.waitForFunction(() => window.__CGP_RESULT, null, { timeout: 120000 });
    const result = await page.evaluate(() => window.__CGP_RESULT);
    return {
      runtime: name,
      execution: "jco-transpile-core-wasm-plus-js",
      nativeComponent: false,
      supported: true,
      consoleErrors: errors,
      ...result,
      pass: result.pass === true && errors.length === 0,
    };
  } finally {
    await browser.close();
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}

const started = Date.now();
const reports = [];
reports.push(await runWasmtime());
reports.push(await runJco("node-jco"));
reports.push(await runBrowser("chromium", chromium));
reports.push(await runBrowser("firefox", firefox));

const requireFirefox = process.env.CGP_REQUIRE_FIREFOX === "1";
const firefoxReport = reports.find((report) => report.runtime === "firefox");
const required = reports.filter((report) => report.runtime !== "firefox");
const firefoxOk = firefoxReport && firefoxReport.supported !== false && firefoxReport.pass;
const pass = required.every((report) => report.pass) && (requireFirefox ? firefoxOk : true);
const summary = {
  pass,
  elapsedMs: Date.now() - started,
  node: process.version,
  reports: reports.map((report) => ({
    runtime: report.runtime,
    execution: report.execution,
    nativeComponent: report.nativeComponent !== false && report.runtime === "wasmtime",
    supported: report.supported !== false,
    pass: report.pass,
    failed: (report.cases ?? []).filter((item) => !item.pass).map((item) => item.id),
    unsupported: report.unsupported === true,
    error: report.error,
    consoleErrors: report.consoleErrors,
  })),
};
console.log(JSON.stringify(summary, null, 2));
if (!pass) {
  for (const report of reports) {
    for (const item of report.cases ?? []) {
      if (!item.pass) {
        console.error(`\n${report.runtime} ${item.id}`);
        console.error(" actual   ", JSON.stringify(item.actual));
        console.error(" expected ", JSON.stringify(item.expected));
      }
    }
  }
  process.exit(1);
}
