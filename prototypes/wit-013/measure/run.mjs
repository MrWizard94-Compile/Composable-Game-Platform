import { spawn } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, firefox } from "playwright";
import { openJco } from "../host/jco-adapter.mjs";
import { compose, sessionOf } from "../../../src/foundations/host.ts";
import { createWasmBackend } from "../../../src/foundations/wasm-backend.ts";
import { echoGuest } from "../../../src/foundations/wasm-build.ts";
import { encodeAbiCall } from "../../../src/foundations/abi.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(root, "../..");
const dist = join(root, "dist");
const bin = join(root, "target/release/wasmtime-host");
const calls = 1000;

function contentType(path) {
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript";
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".html")) return "text/html";
  return "application/octet-stream";
}

function serve(rootDir) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const path = join(rootDir, decodeURIComponent(url.pathname));
      if (relative(rootDir, path).startsWith("..")) {
        response.writeHead(403);
        response.end();
        return;
      }
      const bytes = await readFile(path);
      response.writeHead(200, { "content-type": contentType(path) });
      response.end(bytes);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => resolvePromise(server));
  });
}

async function bytes(path) {
  return (await stat(path)).size;
}

function wasmtimeBench(component, n) {
  const child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  const lines = [];
  let wait;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      lines.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
      wait?.();
      index = buffer.indexOf("\n");
    }
  });
  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return new Promise((resolvePromise) => {
      const pull = () => {
        if (lines.length > 0) resolvePromise(lines.shift());
        else wait = () => {
          wait = null;
          pull();
        };
      };
      pull();
    });
  }
  return (async () => {
    const rssBefore = await send({ cmd: "rss" });
    const loaded = await send({ cmd: "load", path: component });
    const bench = await send({ cmd: "bench", n });
    const rssAfter = await send({ cmd: "rss" });
    child.kill();
    return {
      instantiateUs: loaded.instantiateUs,
      elapsedUs: bench.elapsedUs,
      n: bench.n,
      value: bench.value,
      rssBeforeKb: rssBefore.rssKb,
      rssAfterKb: rssAfter.rssKb,
    };
  })();
}

async function jcoBench(kind, n) {
  const baseName = kind === "rust" ? "rust-meter" : "js-meter";
  const dir = pathToFileURL(`${join(dist, "transpile", kind)}/`);
  const before = process.memoryUsage().rss;
  const started = performance.now();
  const guest = await openJco(new URL(`${baseName}.js`, dir).href, async (path) => {
    return WebAssembly.compile(await readFile(new URL(path, dir)));
  });
  const instantiateMs = performance.now() - started;
  const callStart = performance.now();
  let value = 0;
  for (let i = 0; i < n; i += 1) {
    const result = await guest.add(1);
    value = result.value;
  }
  const callMs = performance.now() - callStart;
  const after = process.memoryUsage().rss;
  await guest.release();
  return {
    instantiateMs: Number(instantiateMs.toFixed(3)),
    callMs: Number(callMs.toFixed(3)),
    perCallUs: Number(((callMs * 1000) / n).toFixed(3)),
    value,
    rssBefore: before,
    rssAfter: after,
  };
}

async function abiBench(n) {
  const encodeStart = performance.now();
  for (let i = 0; i < n; i += 1) {
    const encoded = encodeAbiCall("echo", [i]);
    if (!encoded.ok) throw new Error(encoded.error);
    JSON.parse(encoded.json);
  }
  const encodeMs = performance.now() - encodeStart;
  const backend = createWasmBackend();
  const opened = performance.now();
  const result = await compose(
    [{
      manifest: {
        moduleId: "org.example.echo",
        name: "echo",
        version: "1.0.0",
        moduleApi: ">=1.0.0 <2.0.0",
        connectsTo: [{ slot: "platform.systems", contract: "platform.system/1" }],
      },
      implementation: { wasm: echoGuest() },
    }],
    { backend, policy: { allowGrants: [], maxHookMs: 1000, maxMemoryBytes: 65536 } },
  );
  if (!result.runtimeActive) {
    throw new Error(result.diagnostics.map((item) => item.message).join("\n"));
  }
  const startupMs = performance.now() - opened;
  const session = sessionOf(result);
  const handle = result.contributions.find((item) => item.id === "echo")?.payload;
  await session.callPayload(handle, [0]);
  const callStart = performance.now();
  for (let i = 0; i < n; i += 1) {
    const reply = await session.callPayload(handle, [i]);
    if (!reply.ok) throw reply.error;
  }
  const callMs = performance.now() - callStart;
  const usage = backend.resourceUsage();
  await result.shutdown();
  await backend.dispose();
  return {
    note: "Production cgp.abi/1 echo through wasm-isolate. Includes worker IPC. Not an in-process WIT call.",
    encodeOnlyMs: Number(encodeMs.toFixed(3)),
    startupMs: Number(startupMs.toFixed(3)),
    callMs: Number(callMs.toFixed(3)),
    perCallUs: Number(((callMs * 1000) / n).toFixed(3)),
    guests: usage.guests,
  };
}

async function browserBench(name, browserType) {
  let browser;
  try {
    browser = await browserType.launch();
  } catch (error) {
    return { runtime: name, supported: false, error: String(error.message ?? error) };
  }
  const server = await serve(root);
  const port = server.address().port;
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/measure/page.html`, { waitUntil: "load" });
    await page.waitForFunction(() => window.__CGP_MEASURE, null, { timeout: 120000 });
    const result = await page.evaluate(() => window.__CGP_MEASURE);
    return { runtime: name, supported: true, ...result };
  } finally {
    await browser.close();
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}

const sizes = {
  rustComponent: await bytes(join(dist, "rust-meter.wasm")),
  jsComponent: await bytes(join(dist, "js-meter.wasm")),
  hostileComponent: await bytes(join(dist, "hostile.wasm")),
  rustCore: await bytes(join(dist, "transpile/rust/rust-meter.core.wasm")),
  rustGlue: await bytes(join(dist, "transpile/rust/rust-meter.js")),
  jsCore: await bytes(join(dist, "transpile/js/js-meter.core.wasm")),
  jsGlue: await bytes(join(dist, "transpile/js/js-meter.js")),
  hostileGlue: await bytes(join(dist, "transpile/hostile/hostile.js")),
};
const buildTimes = JSON.parse(await readFile(join(dist, "build-times.json"), "utf8"));
const measurement = {
  measuredAt: new Date().toISOString(),
  host: "linux x86_64",
  node: process.version,
  calls,
  method: "performance.now in the calling process, except Wasmtime bench which uses std::time::Instant inside the host process. RSS is VmRSS for the Wasmtime process and process.memoryUsage().rss for Node.",
  sizes,
  buildTimes,
  wasmtimeRust: await wasmtimeBench(join(dist, "rust-meter.wasm"), calls),
  wasmtimeJs: await wasmtimeBench(join(dist, "js-meter.wasm"), calls),
  nodeJcoRust: await jcoBench("rust", calls),
  nodeJcoJs: await jcoBench("js", calls),
  cgpAbi: await abiBench(calls),
  browsers: [
    await browserBench("chromium", chromium),
    await browserBench("firefox", firefox),
  ],
};
await writeFile(join(root, "measurements.json"), `${JSON.stringify(measurement, null, 2)}\n`);
console.log(JSON.stringify({
  sizes,
  wasmtimeRust: measurement.wasmtimeRust,
  wasmtimeJs: { ...measurement.wasmtimeJs, note: "12MB component" },
  nodeJcoRust: measurement.nodeJcoRust,
  nodeJcoJs: measurement.nodeJcoJs,
  cgpAbi: measurement.cgpAbi,
  browsers: measurement.browsers.map((item) => ({
    runtime: item.runtime,
    supported: item.supported,
    rust: item.rust,
    js: item.js,
    error: item.error?.split("\n")[0],
  })),
}, null, 2));
