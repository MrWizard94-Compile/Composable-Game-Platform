import { openJco } from "../host/jco-adapter.mjs";

async function bench(kind, n) {
  const baseName = kind === "rust" ? "rust-meter" : "js-meter";
  const base = new URL(`../dist/transpile/${kind}/${baseName}.js`, import.meta.url);
  const started = performance.now();
  const guest = await openJco(base.href, async (path) => {
    const response = await fetch(new URL(path, base));
    if (!response.ok) throw new Error(`missing ${path}`);
    return WebAssembly.compile(await response.arrayBuffer());
  });
  const instantiateMs = performance.now() - started;
  const callStart = performance.now();
  let value = 0;
  for (let i = 0; i < n; i += 1) {
    const result = await guest.add(1);
    value = result.value;
  }
  const callMs = performance.now() - callStart;
  await guest.release?.();
  return {
    instantiateMs: Number(instantiateMs.toFixed(3)),
    callMs: Number(callMs.toFixed(3)),
    perCallUs: Number(((callMs * 1000) / n).toFixed(3)),
    value,
  };
}

const n = 1000;
const rust = await bench("rust", n);
const js = await bench("js", n);
document.querySelector("#status").textContent = "measured";
window.__CGP_MEASURE = { calls: n, rust, js, nativeComponent: false };
