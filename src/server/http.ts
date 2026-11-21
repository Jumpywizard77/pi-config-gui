import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Tiny router helpers shared by the HTTP layer (`server.ts` glue and the
 * `config-api.ts` handlers). No framework, no CORS: every response is
 * same-origin JSON written through `json()`.
 */

/** Everything a route handler needs about one request. */
export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  /** Parsed absolute URL (the dummy base only exists to make parsing work). */
  url: URL;
}

export type ApiHandler = (ctx: RequestContext) => void | Promise<void>;

/** Routing table keyed by `"<METHOD> </path>"`, e.g. `"GET /api/state"`. */
export type ApiRoutes = Record<string, ApiHandler>;

/**
 * Send `body` as JSON. Deliberately sends NO CORS headers: this is a
 * localhost-only tool and any cross-site read/write of the user's configs
 * must stay impossible.
 */
export function json(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(data, "utf8")),
    "cache-control": "no-store",
  });
  res.end(data);
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Collect the request body as UTF-8 text, capped (config files are small). */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectBody(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectBody);
  });
}

/** Hex SHA-256 of the text's UTF-8 bytes — the staleness token. */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const LOCAL_HOST = /^(?:127\.0\.0\.1|localhost):([0-9]{1,5})$/;

/**
 * Same-origin guard for every `/api/*` request (v1 has no auth, so this is
 * the whole defense against DNS rebinding and drive-by cross-site posts):
 *
 * - `Host` must be `127.0.0.1:<port>` or `localhost:<port>`; when
 *   `expectedPort` (the port we actually bound) is known, it must match.
 * - When an `Origin` header is present (browsers send one on cross-origin
 *   requests), it must be exactly `http://127.0.0.1:<port>` or
 *   `http://localhost:<port>` matching that same Host port — a foreign or
 *   `null` Origin is refused.
 *
 * The signature is `(req, expectedPort?)` rather than the brief's
 * `(req)` because the handlers need the port bound at `listen(0)` time to
 * pin Host/Origin to THIS server instance.
 */
export function requireLocalRequest(req: IncomingMessage, expectedPort?: number): boolean {
  const match = LOCAL_HOST.exec(req.headers.host ?? "");
  if (!match) return false;
  const hostPort = match[1]!;
  if (expectedPort !== undefined && Number(hostPort) !== expectedPort) return false;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (origin !== `http://127.0.0.1:${hostPort}` && origin !== `http://localhost:${hostPort}`) {
      return false;
    }
  }
  return true;
}
