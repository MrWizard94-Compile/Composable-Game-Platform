import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverModules } from "../foundations/discover-node.ts";
import { compose } from "../foundations/host.ts";
import { moduleIdOf, PROOF_IDS } from "./registry.ts";
import { advanceFlora, readLighting } from "./runners.ts";

const root = dirname(fileURLToPath(import.meta.url));
const discovered = await discoverModules(root);
const proof = discovered.filter((item) => PROOF_IDS.includes(moduleIdOf(item.manifest)));
const result = compose(proof, { profileName: "headless-proof" });
const growth = advanceFlora(result, {}, "spring");
const lights = readLighting(result);

console.log(`runtime ${result.runtimeActive ? "active" : "inactive"}  ok ${result.ok}`);
console.log(`order ${result.order.join(" > ")}`);
console.log(`fingerprint ${result.fingerprint}`);
if (growth.ok) {
  console.log(
    `flora ${growth.strategy}: ${growth.rows.map((row) => `${row.commonName} ${row.stage}`).join(", ")}`,
  );
} else {
  console.log(`flora ${growth.reason}`);
}
if (lights.ok) {
  console.log(`lighting total ${lights.total}: ${lights.sources.map((source) => source.label).join(", ")}`);
} else {
  console.log(`lighting ${lights.reason}`);
}
for (const item of result.diagnostics) {
  console.log(`${item.severity} ${item.code}: ${item.message}`);
}
if (!result.ok) process.exitCode = 1;
