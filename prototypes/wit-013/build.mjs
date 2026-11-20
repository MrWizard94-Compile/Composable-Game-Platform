import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const tools = process.env.CGP_WIT_TOOLS ?? "/tmp/cgp-wit-tools/bin";
const wasmTools = join(tools, "wasm-tools");
const witBindgen = join(tools, "wit-bindgen");
mkdirSync(dist, { recursive: true });

function run(command, args, label) {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  const elapsedMs = Date.now() - started;
  if (result.status !== 0) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    throw new Error(`${label} failed (${result.status})`);
  }
  return { label, elapsedMs };
}

const times = [];
times.push(run("cargo", ["build", "--release", "-p", "rust-meter", "-p", "hostile-meter", "--target", "wasm32-unknown-unknown"], "cargo guests"));
times.push(run("cargo", ["build", "--release", "-p", "wasmtime-host"], "cargo wasmtime-host"));

const target = join(root, "target/wasm32-unknown-unknown/release");
times.push(run(wasmTools, ["component", "new", join(target, "rust_meter.wasm"), "-o", join(dist, "rust-meter.wasm")], "component new rust"));
times.push(run(wasmTools, ["component", "new", join(target, "hostile_meter.wasm"), "-o", join(dist, "hostile.wasm")], "component new hostile"));
times.push(run(process.execPath, [
  join(root, "node_modules/.bin/jco"),
  "componentize",
  "guests/js-meter/guest.js",
  "--wit",
  "wit/slot-probe.wit",
  "-n",
  "probe",
  "--disable",
  "all",
  "-o",
  join(dist, "js-meter.wasm"),
], "componentize js"));

function transpile(input, out) {
  times.push(run(process.execPath, [
    join(root, "node_modules/.bin/jco"),
    "transpile",
    input,
    "-o",
    out,
    "--instantiation",
    "async",
  ], `transpile ${out}`));
}
transpile(join(dist, "rust-meter.wasm"), join(dist, "transpile/rust"));
transpile(join(dist, "js-meter.wasm"), join(dist, "transpile/js"));
transpile(join(dist, "hostile.wasm"), join(dist, "transpile/hostile"));

function importsOf(path) {
  const result = spawnSync(wasmTools, ["component", "wit", path], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  const names = [];
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/^\s*import\s+([^\s;]+)/);
    if (match) names.push(match[1]);
  }
  return names.sort();
}

const importReport = {
  rust: importsOf(join(dist, "rust-meter.wasm")),
  js: importsOf(join(dist, "js-meter.wasm")),
  hostile: importsOf(join(dist, "hostile.wasm")),
};
writeFileSync(join(dist, "import-report.json"), JSON.stringify(importReport, null, 2));

const asyncProbe = spawnSync(witBindgen, [
  "rust",
  join(root, "wit/async-probe.wit"),
  "--world",
  "async-probe",
  "--out-dir",
  join(dist, "async-bindgen"),
], { encoding: "utf8" });
writeFileSync(join(dist, "async-probe.json"), JSON.stringify({
  tool: "wit-bindgen",
  version: "0.63.0",
  world: "cgp:async-probe@0.1.0",
  status: asyncProbe.status,
  stdout: asyncProbe.stdout,
  stderr: asyncProbe.stderr,
  supported: asyncProbe.status === 0,
}, null, 2));

writeFileSync(join(dist, "build-times.json"), JSON.stringify({ times, importReport }, null, 2));
console.log(JSON.stringify({ times, importReport, asyncStatus: asyncProbe.status }, null, 2));
