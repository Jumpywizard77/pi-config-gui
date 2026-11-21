import { classifyKey, resolveEnvKey } from "../core/keyref.js";
import { probeModels, type ProbeResult } from "../core/probe.js";
import { loadSchema, type LoadSchemaOptions } from "../core/schema.js";
import { json, readBody, type ApiRoutes, type RequestContext } from "./http.js";

/**
 * The pi fork's extra endpoints: endpoint probe and a manual schema refresh.
 * The sister app's `upgrade/preview` / `upgrade/apply` routes are absent —
 * pi has no document migrator.
 *
 * The probe is the hero flow's "what's serving?" check, and the one place a
 * stored pi api-key string leaves this process, so its form is gated first
 * (Review Focus 3): a `!command` value is refused with 400 `command_key`
 * BEFORE any network activity (the server never spawns anything — see
 * `core/keyref.ts`), an env-interpolated `$NAME` is resolved against the
 * injected environment (`deps.env ?? process.env`) and an unresolvable one
 * degrades to a KEYLESS probe flagged with a `env_key_unresolved` warning —
 * the literal `$NAME` text is never sent as a key. Literal keys pass through
 * as-is. `probeModels` owns the request itself (and its key scrubbing); this
 * route only classifies, resolves and forwards.
 */

/** Injection ports; every default is the real platform (tests go hermetic). */
export interface ExtraApiDeps {
  loadSchemaOptions?: LoadSchemaOptions;
  /** Environment consulted for `$NAME` resolution; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/** Response flag when a `$NAME` key could not be resolved; probe ran keyless. */
export interface EnvKeyUnresolvedWarning {
  kind: "env_key_unresolved";
  names: string[];
}

/** `POST /api/probe` response: `ProbeResult` verbatim + optional warning. */
export type ProbeApiResponse = ProbeResult & { warning?: EnvKeyUnresolvedWarning };

/** Parse a JSON-object request body, answering 400 on the caller's response. */
async function readJsonBody(ctx: RequestContext): Promise<Record<string, unknown> | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody(ctx.req));
  } catch {
    json(ctx.res, 400, { error: "bad_request" });
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    json(ctx.res, 400, { error: "bad_request" });
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

export function createExtraApiHandlers(deps: ExtraApiDeps = {}): ApiRoutes {
  return {
    "POST /api/probe": async (ctx) => {
      const { res } = ctx;
      const body = await readJsonBody(ctx);
      if (body === undefined) return;
      const baseUrl = body["baseUrl"];
      const apiKey = body["apiKey"];
      if (
        typeof baseUrl !== "string" ||
        baseUrl === "" ||
        (apiKey !== undefined && typeof apiKey !== "string")
      ) {
        json(res, 400, { error: "bad_request" });
        return;
      }

      // Key-form gate: the command form NEVER reaches the network (and is
      // never spawned — classification in keyref.ts is its only job here).
      // The refusal echoes nothing of the command string.
      let key: string | undefined;
      let warning: EnvKeyUnresolvedWarning | undefined;
      if (apiKey !== undefined) {
        const form = classifyKey(apiKey);
        if (form === "command") {
          json(res, 400, { error: "command_key" });
          return;
        }
        if (form === "env") {
          const resolved = resolveEnvKey(apiKey, deps.env ?? process.env);
          if (resolved.ok) {
            key = resolved.key;
          } else {
            // Unresolved: probe keyless and flag which vars were missing.
            // The "$NAME" text itself goes nowhere.
            warning = { kind: "env_key_unresolved", names: resolved.missing };
          }
        } else {
          key = apiKey;
        }
      }

      // probeModels never throws; a server-side fetch bug would be caught by
      // server.ts's top-level catch (500 internal_error). The resolved key is
      // only forwarded to the probe — it is never logged or echoed back.
      const result: ProbeResult = await probeModels({
        baseURL: baseUrl,
        ...(key !== undefined ? { apiKey: key } : {}),
      });
      json(res, 200, warning === undefined ? result : { ...result, warning });
    },

    "POST /api/schema/refresh": async ({ res }) => {
      // loadSchema never throws; a failed refresh walks down to cache/bundled
      // and the reported provenance stays honest either way.
      const source = await loadSchema({ ...(deps.loadSchemaOptions ?? {}), refresh: true });
      json(res, 200, { source: source.source, fetchedAt: source.fetchedAt });
    },
  };
}
