import { parentPort } from "node:worker_threads";
import { createGuestRuntime } from "./wasm-guest-runtime.mjs";

const port = parentPort;
if (!port) throw new Error("Guest worker has no parent port.");

const runtime = createGuestRuntime((id, ok, text) => {
  port.postMessage({ id, ok, text });
});

port.on("message", (message) => {
  runtime.onMessage(message);
});
