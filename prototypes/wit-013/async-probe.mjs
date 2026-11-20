import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)));
const tools = process.env.CGP_WIT_TOOLS ?? "/tmp/cgp-wit-tools/bin";
const component = join(root, "dist/async-ping.wasm");
const playwrightVersion = JSON.parse(await readFile(join(root, "package.json"), "utf8")).devDependencies.playwright;
const JSPI_MISSING = "WebAssembly.promising is not a function";

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function contentType(path) {
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".wasm")) return "application/wasm";
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
      if (!response.headersSent) response.writeHead(404);
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

function isJspiMissing(error) {
  return typeof error === "string" && error.includes("WebAssembly.promising") && error.includes("is not a function");
}

function classifyNode(version, result) {
  const major = Number(String(version).replace(/^v/, "").split(".")[0]);
  const base = {
    version,
    major,
    execution: "jco-transpile-core-wasm-plus-js",
    nativeComponent: false,
    ok: result.ok,
    value: result.value,
    error: result.error,
  };
  if (major === 22) {
    if (result.ok) {
      return {
        ...base,
        expected: false,
        classification: "unexpected-success",
        note: "Node 22 was expected to lack WebAssembly.promising. A successful tick means this boundary changed and the study must be updated.",
      };
    }
    if (isJspiMissing(result.error)) {
      return {
        ...base,
        expected: true,
        classification: "unsupported-jspi",
        note: "Expected Node 22 limitation. JSPI is not a production requirement and is not the slot ABI.",
      };
    }
    return {
      ...base,
      expected: false,
      classification: "unexpected-error",
      note: `Node 22 was expected to fail with ${JSPI_MISSING}. Any other error is a probe failure.`,
    };
  }
  if (major > 22 && result.ok && result.value === "pong") {
    return {
      ...base,
      expected: true,
      classification: "executed",
      note: "This Node is newer than the CGP floor and executed the transpiled async export. Distinct from the expected Node 22 unsupported-jspi result.",
    };
  }
  if (major > 22 && isJspiMissing(result.error)) {
    return {
      ...base,
      expected: true,
      classification: "unsupported-jspi",
      note: "This Node is newer than 22 and still lacks WebAssembly.promising. Distinct from a successful execution.",
    };
  }
  return {
    ...base,
    expected: false,
    classification: "unexpected-error",
    note: "The async probe accepts Node 22's missing JSPI, or a newer Node that either returns pong or still lacks JSPI. This result is neither.",
  };
}

const cargo = run("cargo", [
  "build",
  "--release",
  "-p",
  "async-ping",
  "--target",
  "wasm32-unknown-unknown",
]);
if (cargo.status !== 0) {
  console.error(cargo.stderr);
  process.exit(1);
}
const wrapped = run(join(tools, "wasm-tools"), [
  "component",
  "new",
  join(root, "target/wasm32-unknown-unknown/release/async_ping.wasm"),
  "-o",
  component,
]);
if (wrapped.status !== 0) {
  console.error(wrapped.stderr);
  process.exit(1);
}
const executed = run(join(tools, "wasmtime"), ["run", "--invoke", "tick()", component]);
const wasmtimeStdout = executed.stdout.trim();
const wasmtimeOk = executed.status === 0 && wasmtimeStdout === 'ok("pong")';
const transpiled = run(process.execPath, [
  join(root, "node_modules/.bin/jco"),
  "transpile",
  component,
  "-o",
  join(root, "dist/transpile/async"),
  "--instantiation",
  "async",
]);
const jcoOk = transpiled.status === 0;

let nodeCall;
try {
  const dir = pathToFileURL(`${join(root, "dist/transpile/async")}/`);
  const imported = await import(new URL("async-ping.js", dir).href);
  const instance = await imported.instantiate(async (path) => {
    return WebAssembly.compile(await readFile(new URL(path, dir)));
  }, {});
  const value = await instance.ping.tick();
  await instance._util.whenIdle();
  instance._util.stop();
  nodeCall = { ok: true, value };
} catch (error) {
  nodeCall = { ok: false, error: String(error && error.message ? error.message : error) };
}
const nodeResult = classifyNode(process.version, nodeCall);

let chromiumResult;
let browser;
try {
  browser = await chromium.launch();
  const { server, port } = await serve(root);
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.goto(`http://127.0.0.1:${port}/async/page.html`, { waitUntil: "load" });
    await page.waitForFunction(() => window.__CGP_ASYNC, null, { timeout: 60000 });
    const pageReport = await page.evaluate(() => window.__CGP_ASYNC);
    const value = pageReport.value;
    chromiumResult = {
      execution: "jco-transpile-core-wasm-plus-js",
      nativeComponent: false,
      playwright: playwrightVersion,
      browserVersion: browser.version(),
      launchArgs: [],
      ok: pageReport.ok === true && value === "pong" && pageErrors.length === 0,
      value,
      error: pageReport.error,
      pageErrors,
    };
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
} catch (error) {
  chromiumResult = {
    execution: "jco-transpile-core-wasm-plus-js",
    nativeComponent: false,
    playwright: playwrightVersion,
    browserVersion: browser ? browser.version() : null,
    launchArgs: [],
    ok: false,
    error: String(error && error.message ? error.message : error),
    pageErrors: [],
  };
} finally {
  if (browser) await browser.close();
}

const report = {
  wit: "package cgp:async-probe@0.1.0; interface ping { tick: async func() -> result<string, string>; }",
  note: "Separate from the slot contract and from the synchronous conformance suite. The guest returns immediately, so this does not observe cancellation or shutdown-while-pending. Those races are in the host lane tests. Cancellation in the Component Model is cooperative and is not a rollback. Node 22 missing JSPI is an expected experimental result, not a production requirement.",
  wasmtime: {
    execution: "native-component",
    nativeComponent: true,
    status: executed.status,
    stdout: wasmtimeStdout,
    stderr: executed.stderr.trim(),
    ok: wasmtimeOk,
    expected: 'ok("pong")',
  },
  jcoTranspile: {
    status: transpiled.status,
    stderr: transpiled.stderr.trim(),
    ok: jcoOk,
  },
  node: nodeResult,
  chromium: chromiumResult,
};
await writeFile(join(root, "async-result.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

const failures = [];
if (!wasmtimeOk) failures.push("wasmtime");
if (!jcoOk) failures.push("jco-transpile");
if (!nodeResult.expected) failures.push(`node:${nodeResult.classification}`);
if (!chromiumResult.ok) failures.push("chromium");
if (failures.length > 0) {
  console.error(`async probe failed: ${failures.join(", ")}`);
  process.exit(1);
}
