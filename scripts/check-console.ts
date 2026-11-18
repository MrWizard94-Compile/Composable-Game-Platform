import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { buildConsole } from "./build-console.ts";
import { createConsoleServer } from "./serve-console.ts";

await buildConsole();
const server = createConsoleServer();
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve());
});

const address = server.address();
if (!address || typeof address === "string") throw new Error("Console test server did not bind a TCP port.");
const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto("http://127.0.0.1:" + address.port + "/");
  await page.getByRole("heading", { name: "Platform overview" }).waitFor();
  await page.locator("#runtime-state[data-state='active']").waitFor({ timeout: 15000 });
  assert.equal(await page.locator(".brand-lockup img").getAttribute("src"), "/assets/brand/logo-lockup.svg");

  await page.locator('.nav-button[data-view="modules"]').click();
  await page.getByRole("heading", { name: "Module catalog" }).waitFor();
  await page.locator("#module-search").fill("flora");
  assert.ok(await page.locator("#module-list .module-card").count() > 0);

  await page.locator('.nav-button[data-view="composition"]').click();
  await page.locator("#profile-select").selectOption("simulation");
  await page.getByRole("button", { name: "Compose selected profile" }).click();
  await page.locator("#runtime-state[data-state='active']").waitFor({ timeout: 20000 });
  assert.ok(await page.locator(".data-table tbody tr").count() > 0);

  await page.getByRole("button", { name: "Shutdown composition" }).click();
  assert.deepEqual(errors, []);
  console.log("CGP console browser check passed.");
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
