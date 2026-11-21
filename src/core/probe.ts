/**
 * Probe an OpenAI-compatible endpoint's `{baseURL}/models` list.
 *
 * Runs server-side (the dev/prod server calls it to bypass browser CORS), but
 * is a pure core module: the only ambient dependency is the `fetch` global, so
 * it stays bundleable for browser type reuse. Do not import node builtins.
 */

export type ProbeStatus = "ok" | "unreachable" | "auth_failed" | "not_compatible";

export interface ProbeResult {
  status: ProbeStatus;
  modelIds: string[];
  detail: string;
  latencyMs: number;
}

export interface ProbeInput {
  baseURL: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_DETAIL_CHARS = 300;

/**
 * Ordered candidate URLs for the model list: a baseURL already ending in
 * `/v1` gets the single obvious candidate; anything else prefers an inserted
 * `/v1` (the OpenAI convention) and falls back to the bare `/models`.
 */
export function buildModelsUrls(baseURL: string): string[] {
  const base = baseURL.trim().replace(/\/+$/, "");
  const bare = `${base}/models`;
  if (base.endsWith("/v1")) {
    return [bare];
  }
  return [`${base}/v1/models`, bare];
}

function scrubSecrets(text: string, apiKey: string | undefined): string {
  if (!apiKey) {
    return text;
  }
  return text.split(apiKey).join("***");
}

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_DETAIL_CHARS ? `${flat.slice(0, MAX_DETAIL_CHARS)}…` : flat;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error || err instanceof DOMException) {
    return err.name && err.message ? `${err.name}: ${err.message}` : err.message || err.name || String(err);
  }
  return String(err);
}

async function safeBodyText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** OpenAI-shaped `{ data: [{ id }] }` → the ids; `undefined` when not parseable. Ids are scrubbed of the apiKey: an echoing endpoint must not smuggle the key back through `modelIds`. */
function parseModelIds(bodyText: string, apiKey: string | undefined): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const data = (parsed as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return undefined;
  }
  const ids: string[] = [];
  for (const entry of data) {
    if (typeof entry === "object" && entry !== null) {
      const id = (entry as { id?: unknown }).id;
      if (typeof id === "string") {
        ids.push(scrubSecrets(id, apiKey));
      }
    }
  }
  return ids;
}

/**
 * Probe `{baseURL}/models` and classify the outcome. Never throws: every
 * failure mode lands in `status` with a scrubbed `detail`, and no returned
 * `ProbeResult` field (including `modelIds`) ever contains the apiKey value.
 * Each request is bounded by `AbortSignal.timeout(timeoutMs)`;
 * a network/timeout failure short-circuits the remaining candidates so the
 * whole probe stays within roughly one timeout budget.
 */
export async function probeModels(input: ProbeInput): Promise<ProbeResult> {
  const startedAt = Date.now();
  const { baseURL, apiKey } = input;
  const fetchFn = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const result = (status: ProbeStatus, detail: string, modelIds: string[] = []): ProbeResult => ({
    status,
    modelIds,
    detail: truncate(scrubSecrets(detail, apiKey)),
    latencyMs: Date.now() - startedAt,
  });

  let authDetail: string | undefined;
  let incompatibleDetail: string | undefined;

  for (const url of buildModelsUrls(baseURL)) {
    // With a key: Bearer first, then exactly one keyless retry per candidate.
    const attempts: (string | undefined)[] = apiKey ? [apiKey, undefined] : [undefined];
    for (const key of attempts) {
      const headers: Record<string, string> = { accept: "application/json" };
      if (key) {
        headers.authorization = `Bearer ${key}`;
      }

      let res: Response;
      try {
        res = await fetchFn(url, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // Network error or timeout: the host is down for every candidate.
        return result("unreachable", errorMessage(err));
      }

      const body = await safeBodyText(res);
      // Scrub before truncating: a truncation that cut mid-key would otherwise
      // leave a key prefix the exact-match scrub can no longer find.
      const safeBody = truncate(scrubSecrets(body, apiKey));
      if (res.status === 401 || res.status === 403) {
        authDetail ??= `HTTP ${res.status} from ${url}${safeBody ? `: ${safeBody}` : ""}`;
        continue;
      }
      if (!res.ok) {
        incompatibleDetail ??= `HTTP ${res.status} from ${url}${safeBody ? `: ${safeBody}` : ""}`;
        break; // keyless retry is only meaningful for auth failures
      }

      const modelIds = parseModelIds(body, apiKey);
      if (modelIds === undefined) {
        incompatibleDetail ??= `response from ${url} is not an OpenAI-style model list: ${safeBody}`;
        break;
      }
      return result("ok", `Found ${modelIds.length} model(s) at ${url}`, modelIds);
    }
  }

  if (authDetail !== undefined) {
    return result("auth_failed", authDetail);
  }
  return result("not_compatible", incompatibleDetail ?? "no candidate URL produced a usable response");
}
