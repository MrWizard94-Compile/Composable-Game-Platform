import { openJco } from "../host/jco-adapter.mjs";
import { evaluate } from "../host/vectors.mjs";

async function load(kind) {
  const baseName = kind === "rust" ? "rust-meter" : "js-meter";
  const base = new URL(`../dist/transpile/${kind}/${baseName}.js`, import.meta.url);
  return openJco(base.href, async (path) => {
    const response = await fetch(new URL(path, base));
    if (!response.ok) throw new Error(`missing ${path}`);
    return WebAssembly.compile(await response.arrayBuffer());
  });
}

const reportResponse = await fetch(new URL("../dist/import-report.json", import.meta.url));
const imports = await reportResponse.json();

const result = await evaluate({
  open: load,
  async imports(kind) {
    return imports[kind];
  },
  async hostileImports() {
    return imports.hostile;
  },
  async tryHostile() {
    try {
      const base = new URL("../dist/transpile/hostile/hostile.js", import.meta.url);
      await openJco(base.href, async (path) => {
        const response = await fetch(new URL(path, base));
        if (!response.ok) throw new Error(`missing ${path}`);
        return WebAssembly.compile(await response.arrayBuffer());
      });
      return { instantiated: true, error: "" };
    } catch (error) {
      return { instantiated: false, error: String(error && error.stack ? error.stack : error) };
    }
  },
  async release(guest) {
    await guest.release?.();
  },
});

document.querySelector("#status").textContent = result.pass ? "pass" : "fail";
window.__CGP_RESULT = result;
