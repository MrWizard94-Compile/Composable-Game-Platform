import { createServer, type Server } from "node:http";
import { lstatSync, readFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createConsoleApiHandler, type ConsoleApiOptions } from "./console-api.ts";

const root = resolve(fileURLToPath(new URL("../dist/console/", import.meta.url)));
const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
};

export function createConsoleServer(options: ConsoleApiOptions = {}): Server {
  const api = createConsoleApiHandler(options);
  return createServer(async (request, response) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    } catch {
      response.writeHead(400);
      response.end("Bad request path");
      return;
    }

    if (pathname.includes("\\") || pathname.includes("\0")) {
      response.writeHead(400);
      response.end("Invalid request path");
      return;
    }
    if (pathname.startsWith("/api/")) {
      await api(request, response, pathname);
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" });
      response.end("Method not allowed");
      return;
    }

    if (pathname === "/") pathname = "/index.html";

    const target = resolve(root, "." + pathname);
    if (target !== root && !target.startsWith(root + sep)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    try {
      const info = lstatSync(target);
      if (info.isSymbolicLink() || !info.isFile()) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }
      const bytes = readFileSync(target);
      response.writeHead(200, {
        "content-type": contentTypes[extname(target)] ?? "application/octet-stream",
        "content-length": bytes.byteLength,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      if (request.method === "HEAD") response.end();
      else response.end(bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        response.writeHead(404);
        response.end("Not found");
        return;
      }
      response.writeHead(500);
      response.end("Unable to serve console asset");
    }
  });
}

type CliOptions = ConsoleApiOptions & { port: number };
function parseArguments(args: string[]): CliOptions {
  const result: CliOptions = { port: Number(process.env.PORT ?? "4173") };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error("Missing value for " + flag + ".");
    if (flag === "--port") result.port = Number(value);
    else if (flag === "--store") result.storeDirectory = value;
    else if (flag === "--profile") result.profilePath = value;
    else if (flag === "--lock") result.lockPath = value;
    else if (flag === "--staging") result.stagingDirectory = value;
    else throw new Error("Unknown argument: " + flag);
    index += 1;
  }
  if (!Number.isInteger(result.port) || result.port < 0 || result.port > 65535) {
    throw new Error("Console port must be an integer from 0 through 65535.");
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const server = createConsoleServer(options);
    server.listen(options.port, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Console server did not open a TCP port.");
      console.log("CGP console: http://127.0.0.1:" + address.port);
      console.log("Content store: " + (options.storeDirectory ?? process.env.CGP_STORE_DIR ?? ".cgp-store"));
      if (options.profilePath ?? process.env.CGP_PROJECT_PROFILE) console.log("Project profile: " + (options.profilePath ?? process.env.CGP_PROJECT_PROFILE));
      if (options.lockPath ?? process.env.CGP_PROJECT_LOCK) console.log("Project lockfile: " + (options.lockPath ?? process.env.CGP_PROJECT_LOCK));
      if (options.stagingDirectory ?? process.env.CGP_STAGING_DIR) console.log("Staging root: " + (options.stagingDirectory ?? process.env.CGP_STAGING_DIR));
      console.log("Press Ctrl+C to stop.");
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
