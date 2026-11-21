import type { ProbeResult } from "../core/probe";
import type { Issue, PathEdit } from "../core/types";

/**
 * Same-origin HTTP client for the local pi-config-gui server (see
 * `src/server/`). The UI's ONLY network surface: Tasks 10–12 build every
 * component call against these functions.
 *
 * Fork differences from the sister app's client, by design:
 * - Documents are addressed by the fixed `DocId` allowlist — there is NO
 *   `folder`/path plumbing anywhere (the server roots path safety on doc ids,
 *   so no query params other than `?doc=` exist).
 * - No `upgrade/preview` / `upgrade/apply`: pi has no document migrator.
 * - `saveConfig` takes ONE body object (the server reads `doc`, `text`,
 *   `baseSha256`, `baseIssues` and optionally `edits`/`baseText` from it) and
 *   its `SaveResult` union carries `ok` + `kind` and covers the auth
 *   rebase outcomes (`rebased` on success, `conflict` on 409).
 * - The read calls (`getState`/`getConfig`/`refreshSchema`/`probe`) return
 *   the BARE payload per the brief and THROW on a non-OK response or a
 *   transport failure; only `saveConfig` folds HTTP fates into data.
 *
 * Payload shapes are hand-written mirrors of the server JSON: a type-only
 * import from `src/server/` or `src/core/discovery` would drag node builtins
 * into the browser bundle graph. (Pure `core/types` and `core/probe` ARE
 * importable — they are bundle-safe by contract.)
 */

// ---------------------------------------------------------------------------
// Payload shapes
// ---------------------------------------------------------------------------

/** The two documents the UI may read and save (the server's editable pair). */
export type DocId = "models" | "auth";

/** One editable document slot from `/api/state`. */
export interface DocState {
  id: DocId;
  path: string;
  exists: boolean;
  editable: boolean;
}

export interface StatePayload {
  agentDir: string;
  /** The editable documents (`models`, `auth`), always listed. */
  docs: DocState[];
  /**
   * Discovered read-only neighbours (`settings`, `mcp`, `keybindings`) —
   * present on the wire only while their files are. Derived client-side from
   * the server's single `docs` array by splitting on `editable`.
   */
  otherDocs: { id: string; path: string }[];
  piVersion: string | null;
  schemaSource: "bundled" | "remote";
  /** `"bundled"`, `"bundled-missing"` (degraded validation) or an ISO date. */
  schemaFetchedAt: string;
}

/** Wire shape of one `PiDoc` entry in `GET /api/state` (see core/discovery). */
interface WireDoc {
  id: string;
  path: string;
  kind: string;
  editable: boolean;
  exists: boolean;
}

/** Wire shape of `GET /api/state` before the docs/otherDocs split. */
interface WireStatePayload {
  agentDir: string;
  docs: WireDoc[];
  piVersion: string | null;
  schemaSource: "bundled" | "remote";
  schemaFetchedAt: string;
}

export interface ConfigPayload {
  text: string;
  sha256: string;
  issues: Issue[];
  /** False when the server served the documented seed for an absent file. */
  exists: boolean;
}

/**
 * Outcome of `saveConfig` — every fate of both save flavors (classic and
 * auth rebase), discriminated on `ok`/`kind`. `status: 0` means a transport
 * failure (fetch rejected).
 */
export type SaveResult =
  | { ok: true; sha256: string; backupPath: string; /** present on auth rebase saves */ rebased?: boolean }
  | { ok: false; kind: "stale"; diskSha256: string }
  | { ok: false; kind: "new_issues"; newIssues: Issue[] }
  | { ok: false; kind: "conflict"; entries: string[] }
  | { ok: false; kind: "error"; status: number };

/** Body of `POST /api/config/save`; `edits`/`baseText` mark a structured auth save. */
export interface SaveBody {
  doc: DocId;
  text: string;
  baseSha256: string;
  baseIssues: Issue[];
  edits?: PathEdit[];
  baseText?: string;
}

/** Flag set by the server when a `$NAME` api-key could not be resolved. */
export interface EnvKeyUnresolvedWarning {
  kind: "env_key_unresolved";
  names: string[];
}

export type ProbeApiResponse = ProbeResult & { warning?: EnvKeyUnresolvedWarning };

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Error thrown by the bare-payload calls; message names endpoint + status/error code. */
function apiFailure(endpoint: string, status: number, body: unknown): Error {
  const record = asRecord(body);
  const code = typeof record?.["error"] === "string" ? (record["error"] as string) : null;
  return new Error(`${endpoint}: HTTP ${status}${code === null ? "" : ` ${code}`}`);
}

/** Builds `/api/…?k=v`; undefined/empty params are dropped. */
function withQuery(path: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, value);
  }
  const qs = search.toString();
  return qs === "" ? path : `${path}?${qs}`;
}

function postJson(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * Fetch + JSON for the bare-payload calls. `url` is fetched as-is; `label`
 * names the call in thrown errors. Throws on transport failure and on any
 * non-OK response (message carries label, status and server error code when
 * present); a non-JSON OK body throws too rather than masquerading as a
 * payload.
 */
async function callOrThrow<T>(url: string, label: string, init?: RequestInit): Promise<T> {
  const endpoint = `${label} ${url}`;
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    throw new Error(`${endpoint}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) throw apiFailure(endpoint, response.status, body);
  if (body === null) throw new Error(`${endpoint}: HTTP ${response.status} returned no JSON`);
  return body as T;
}

/** Maps a `/api/config/save` Response into the SaveResult union. */
async function interpretSave(response: Response): Promise<SaveResult> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const record = asRecord(body);
  if (response.status === 409) {
    if (record?.["error"] === "stale" && typeof record["diskSha256"] === "string") {
      return { ok: false, kind: "stale", diskSha256: record["diskSha256"] };
    }
    if (record?.["error"] === "conflict" && Array.isArray(record["entries"])) {
      return { ok: false, kind: "conflict", entries: record["entries"] as string[] };
    }
  }
  if (response.ok) {
    const sha256 = record?.["sha256"];
    const backupPath = record?.["backupPath"];
    if (typeof sha256 === "string" && typeof backupPath === "string") {
      return record?.["rebased"] === true
        ? { ok: true, sha256, backupPath, rebased: true }
        : { ok: true, sha256, backupPath };
    }
  }
  if (response.status === 400) {
    if (record?.["error"] === "new_issues" && Array.isArray(record["newIssues"])) {
      return { ok: false, kind: "new_issues", newIssues: record["newIssues"] as Issue[] };
    }
  }
  return { ok: false, kind: "error", status: response.status };
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** Server state for the resolved agent dir: docs, pi version, schema provenance. */
export async function getState(): Promise<StatePayload> {
  const wire = await callOrThrow<WireStatePayload>("/api/state", "GET");
  const docs: DocState[] = [];
  const otherDocs: { id: string; path: string }[] = [];
  for (const doc of wire.docs) {
    if (doc.editable) {
      docs.push({ id: doc.id as DocId, path: doc.path, exists: doc.exists, editable: doc.editable });
    } else {
      otherDocs.push({ id: doc.id, path: doc.path });
    }
  }
  return {
    agentDir: wire.agentDir,
    docs,
    otherDocs,
    piVersion: wire.piVersion,
    schemaSource: wire.schemaSource,
    schemaFetchedAt: wire.schemaFetchedAt,
  };
}

/** Text + staleness token + validation issues for one document (seed if absent). */
export function getConfig(doc: DocId): Promise<ConfigPayload> {
  return callOrThrow<ConfigPayload>(withQuery("/api/config", { doc }), "GET");
}

/**
 * Classic save (models.json always; auth.json when `edits` is absent) and
 * the structured auth rebase save (`edits` + `baseText` supplied). Never
 * throws for HTTP fates — callers `switch` on the union.
 */
export async function saveConfig(body: SaveBody): Promise<SaveResult> {
  let response: Response;
  try {
    response = await fetch("/api/config/save", postJson(body));
  } catch {
    // Transport failure: no HTTP status happened. Sister convention: status 0.
    return { ok: false, kind: "error", status: 0 };
  }
  return interpretSave(response);
}

/** Ask the server to probe an OpenAI-compatible endpoint's model list. */
export function probe(input: { baseUrl: string; apiKey?: string }): Promise<ProbeApiResponse> {
  return callOrThrow<ProbeApiResponse>(
    "/api/probe",
    "POST",
    postJson({ baseUrl: input.baseUrl, ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}) }),
  );
}

/** Force a schema re-download; returns the new provenance (pi-keyed names). */
export function refreshSchema(): Promise<{ source: string; fetchedAt: string }> {
  return callOrThrow<{ source: string; fetchedAt: string }>("/api/schema/refresh", "POST", {
    method: "POST",
  });
}
