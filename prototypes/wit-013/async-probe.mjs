import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)));
const tools = process.env.CGP_WIT_TOOLS ?? "/tmp/cgp-wit-tools/bin";
const component = join(root, "dist/async-ping.wasm");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
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
const transpiled = run(process.execPath, [
  join(root, "node_modules/.bin/jco"),
  "transpile",
  component,
  "-o",
  join(root, "dist/transpile/async"),
  "--instantiation",
  "async",
]);

let nodeResult;
try {
  const dir = pathToFileURL(`${join(root, "dist/transpile/async")}/`);
  const imported = await import(new URL("async-ping.js", dir).href);
  const instance = await imported.instantiate(async (path) => {
    return WebAssembly.compile(await readFile(new URL(path, dir)));
  }, {});
  nodeResult = { ok: true, value: await instance.ping.tick() };
  await instance._util.whenIdle();
  instance._util.stop();
} catch (error) {
  nodeResult = { ok: false, error: String(error && error.message ? error.message : error) };
}

const report = {
  wit: "package cgp:async-probe@0.1.0; interface ping { tick: async func() -> result<string, string>; }",
  note: "Separate from the slot contract. The guest returns immediately, so this does not observe cancellation or shutdown-while-pending. Those races are in the host lane tests. Cancellation in the Component Model is cooperative and is not a rollback.",
  wasmtime: {
    status: executed.status,
    stdout: executed.stdout.trim(),
    stderr: executed.stderr.trim(),
  },
  jcoTranspile: { status: transpiled.status, stderr: transpiled.stderr.trim() },
  node: {
    version: process.version,
    ...nodeResult,
  },
};
await writeFile(join(root, "async-result.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (executed.status !== 0 || !executed.stdout.includes("pong")) {
  process.exit(1);
}
