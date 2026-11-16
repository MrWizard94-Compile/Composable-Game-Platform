import { createServer, type Server } from "node:http";
import { lstatSync, readFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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

export function createConsoleServer(): Server {
  return createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" });
      response.end("Method not allowed");
      return;
    }

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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const portText = process.argv[2] ?? process.env.PORT ?? "4173";
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Console port must be an integer from 0 through 65535.");
  }
  const server = createConsoleServer();
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Console server did not open a TCP port.");
    console.log("CGP console: http://127.0.0.1:" + address.port);
    console.log("Press Ctrl+C to stop.");
  });
}
