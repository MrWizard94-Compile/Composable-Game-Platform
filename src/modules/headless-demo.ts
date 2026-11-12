import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverModules, loadInProcessImplementations } from "../foundations/discover-node.ts";
import { compose } from "../foundations/host.ts";
import { IN_PROCESS_POLICY } from "../foundations/backend.ts";
import { captureSave } from "../foundations/save.ts";
import { moduleIdOf, DISPATCH_IDS, PROOF_IDS, SERVICE_IDS } from "./registry.ts";
import { advanceFlora, askQuery, dispatchPulse, foldPipe, readLighting } from "./runners.ts";

const root = dirname(fileURLToPath(import.meta.url));
const discovered = await loadInProcessImplementations(await discoverModules(root));
const proof = discovered.filter((item) => PROOF_IDS.includes(moduleIdOf(item.manifest)));
const result = compose(proof, { profileName: "headless-proof", policy: IN_PROCESS_POLICY });
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

const signals = discovered.filter((item) => (DISPATCH_IDS as readonly string[]).includes(moduleIdOf(item.manifest)));
const dispatched = compose(signals, { profileName: "headless-dispatch", policy: IN_PROCESS_POLICY });
const pulse = dispatchPulse(dispatched);
const folded = foldPipe(dispatched, 4);
const saved = captureSave(dispatched);
const pulses = saved.document.slices.find((slice) => slice.moduleId === "org.cgp.pulse-count")?.payload;
console.log(
  `dispatch ${dispatched.ok ? "ok" : "not ok"} heard ${pulse.heard.join(",")} pipe ${folded.input}->${String(folded.output)} pulses ${JSON.stringify(pulses)}`,
);

if (!result.ok || !dispatched.ok || !pulse.report.ok || !folded.ok || !saved.ok) process.exitCode = 1;

const queries = discovered.filter((item) => (SERVICE_IDS as readonly string[]).includes(moduleIdOf(item.manifest)));
const service = compose(queries, { profileName: "headless-service", policy: IN_PROCESS_POLICY });
const asked = askQuery(service, "alpha");
console.log(`service ${service.ok && asked.report.ok ? "ok" : "not ok"} ${JSON.stringify(asked.report.output)}`);
if (!service.ok || !asked.report.ok) process.exitCode = 1;
