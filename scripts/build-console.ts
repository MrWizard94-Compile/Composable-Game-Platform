import { cpSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist/console");

export async function buildConsole(): Promise<void> {
  const outputRelative = relative(root, output);
  if (outputRelative === "" || outputRelative === ".." || outputRelative.startsWith(".." + sep) || isAbsolute(outputRelative)) {
    throw new Error("Refusing to build outside dist/console.");
  }
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });

  await esbuild.build({
    absWorkingDir: root,
    entryPoints: ["apps/console/main.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    supported: { "async-await": false },
    outfile: join(output, "app.js"),
    sourcemap: false,
    minify: false,
    logLevel: "info",
  });

  copyFileSync(join(root, "apps/console/index.html"), join(output, "index.html"));
  copyFileSync(join(root, "apps/console/console.css"), join(output, "console.css"));
  cpSync(join(root, "assets/brand"), join(output, "assets/brand"), { recursive: true });

  // wasm-browser.ts creates its Worker relative to the bundled app.js.
  // Keep the worker and its imported guest runtime beside app.js.
  copyFileSync(join(root, "src/foundations/wasm-worker-browser.mjs"), join(output, "wasm-worker-browser.mjs"));
  copyFileSync(join(root, "src/foundations/wasm-guest-runtime.mjs"), join(output, "wasm-guest-runtime.mjs"));
  console.log("CGP console built at " + output);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await buildConsole();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
