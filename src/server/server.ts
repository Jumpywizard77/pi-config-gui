import { createServer as createHttpServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

import { json, requireLocalRequest, type ApiRoutes, type RequestContext } from "./http.js";

/**
 * The whole HTTP shell: binds loopback, gates EVERY request through
 * `requireLocalRequest` (the static UI is same-origin surface too: an
 * attacker-driven Host must not fetch it, e.g. to attack the SPA's own
 * localStorage or probe the port), dispatches API calls via the route
 * table, and (optionally) serves the built UI for GET/HEAD with an SPA
 * fallback. All config logic lives in `config-api.ts`; this file is pure
 * glue.
 */

export interface CreateServerOptions {
  /**
   * Directory of built UI assets (e.g. `dist/ui`) to serve for non-API GETs
   * with SPA fallback. Omitted in tests — static serving is off there.
   */
  staticDir?: string;
}

export function createServer(routes: ApiRoutes, options: CreateServerOptions = {}): Server {
  const server: Server = createHttpServer(async (req, res) => {
    try {
      // The dummy base is irrelevant: only req.url's path/query are used.
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
      const isStatic = !isApi && options.staticDir !== undefined;
      if (isApi || isStatic) {
        // One gate for both surfaces: `/api/*` (config IO) and the static
        // SPA must never answer a forged Host or a foreign Origin.
        const address = server.address();
        const port = address !== null && typeof address === "object" ? address.port : undefined;
        if (!requireLocalRequest(req, port)) {
          json(res, 403, { error: "not_allowed" });
          return;
        }
      }
      if (isApi) {
        const handler = routes[`${req.method ?? "GET"} ${url.pathname}`];
        if (handler === undefined) {
          json(res, 404, { error: "unknown_route" });
          return;
        }
        const ctx: RequestContext = { req, res, url };
        await handler(ctx);
        return;
      }
      if (options.staticDir !== undefined) {
        // Asset serving is a read surface: GET/HEAD only (HEAD bodies are
        // suppressed by node:http itself).
        if (req.method !== "GET" && req.method !== "HEAD") {
          json(res, 405, { error: "method_not_allowed" });
          return;
        }
        serveStatic(options.staticDir, url.pathname, res);
        return;
      }
      json(res, 404, { error: "not_found" });
    } catch (err) {
      console.error("server: unhandled request error:", err);
      if (!res.headersSent) {
        json(res, 500, { error: "internal_error" });
      } else {
        res.end();
      }
    }
  });
  return server;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function trySendFile(file: string, res: ServerResponse): boolean {
  let data: Buffer;
  try {
    data = readFileSync(file); // throws for missing paths and directories
  } catch {
    return false;
  }
  res.writeHead(200, {
    "content-type": MIME_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": String(data.byteLength),
  });
  res.end(data);
  return true;
}

/** Static assets under `staticDir` only, with index.html SPA fallback. */
function serveStatic(staticDir: string, pathname: string, res: ServerResponse): void {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    json(res, 400, { error: "bad_request" });
    return;
  }
  const root = resolve(staticDir);
  // `.${decoded}` makes the join relative, so resolve() collapses any `..`
  // segments against the root before the containment check below.
  const candidate = resolve(root, `.${decoded === "" ? "/" : decoded}`);
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    json(res, 403, { error: "unsafe_path" });
    return;
  }
  if (trySendFile(candidate, res)) return;
  if (trySendFile(join(candidate, "index.html"), res)) return;
  if (trySendFile(join(root, "index.html"), res)) return; // SPA fallback
  json(res, 404, { error: "not_found" });
}
