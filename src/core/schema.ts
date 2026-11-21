import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

import { execDataDir } from "../exec-data-dir.js";
import { validateAuthText } from "./auth-schema.js";
import type { DocId } from "./discovery.js";
import { parseJsonc } from "./jsonc.js";
import type { Issue } from "./types.js";

/** Where the live pi models schema is published; also the `$id` of the vendored copy. */
export const REMOTE_SCHEMA_URL = "https://pi.dev/schemas/models.schema.json";

/** A usable schema plus provenance: `fetchedAt` is `"bundled"` for the vendored copy. */
export interface SchemaSource {
  schema: object;
  source: "bundled" | "remote";
  fetchedAt: string;
}

export interface LoadSchemaOptions {
  /** Force a network refresh; without it a valid disk cache is served as-is. */
  refresh?: boolean;
  /** Injectable fetch for tests; defaults to the global (Node >= 20). */
  fetchImpl?: typeof fetch;
  /** Override the cache directory (tests). */
  cacheDir?: string;
  /** Override the vendored-copy path (tests); see `bundledFallback` for degraded semantics. */
  bundledPath?: string | URL;
}

const CACHE_FILE_NAME = "models-schema.json";

function cacheFilePath(opts: LoadSchemaOptions): string {
  const dir = opts.cacheDir ?? join(homedir(), ".cache", "pi-config-gui");
  return join(dir, CACHE_FILE_NAME);
}

const BUNDLED_SCHEMA_URL = new URL("./schema-bundled.json", import.meta.url);

/**
 * Vendored-copy paths to try, in order. The second candidate serves the
 * Bun-compiled single-file binary (release archives): there `import.meta.url`
 * lives inside the executable's embedded virtual FS, so the archive ships
 * `dist/core/schema-bundled.json` next to the binary — via the shared
 * `execDataDir` ladder (see `exec-data-dir.ts`) the static UI candidate is
 * derived the same way, so the two rungs can never disagree. Under plain
 * Node the candidate is <node dir>/dist/core/schema-bundled.json, which does
 * not exist, so it is inert there.
 */
const BUNDLED_CANDIDATES: (string | URL)[] = [
  BUNDLED_SCHEMA_URL,
  join(execDataDir(), "dist", "core", "schema-bundled.json"),
];

/**
 * The last rung of the never-throw ladder. A vendored copy that is absent,
 * unparseable or a non-object (e.g. `dist/` packaging that forgot the JSON)
 * degrades to a permissive `{}` schema — which makes `validateConfigText`
 * match everything, a no-op rather than a crash. Provenance stays honest:
 * `source` remains "bundled" (it came from the vendored-copy rung) but
 * `fetchedAt` becomes the distinct sentinel "bundled-missing", so the
 * fetchedAt-keyed validator cache can never mix a degraded `{}` validator
 * with the real vendored schema's.
 */
function bundledFallback(bundledPath?: string | URL): SchemaSource {
  for (const candidate of bundledPath !== undefined ? [bundledPath] : BUNDLED_CANDIDATES) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return { schema: parsed, source: "bundled", fetchedAt: "bundled" };
      }
    } catch {
      // try the next candidate
    }
  }
  return { schema: {}, source: "bundled", fetchedAt: "bundled-missing" };
}

/** A malformed or partial cache file counts as a miss, never as an error. */
function readCache(path: string): SchemaSource | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as { fetchedAt?: unknown }).fetchedAt === "string" &&
      typeof (parsed as { schema?: unknown }).schema === "object" &&
      (parsed as { schema?: unknown }).schema !== null
    ) {
      const { schema, fetchedAt } = parsed as { schema: object; fetchedAt: string };
      return { schema, source: "remote", fetchedAt };
    }
  } catch {
    // fall through to a cache miss
  }
  return undefined;
}

function writeCache(path: string, source: SchemaSource): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ fetchedAt: source.fetchedAt, schema: source.schema }));
  } catch {
    // Caching is best-effort; an unwritable cache never fails a refresh.
  }
}

/**
 * Fetch the live pi `models.json` schema with a disk cache and a vendored
 * fallback. The ladder is refresh→cache→bundled and the function never
 * throws: any network, HTTP, parse or write failure just walks down it, and
 * a broken bundled copy itself degrades permissively (see `bundledFallback`).
 */
export async function loadSchema(opts: LoadSchemaOptions = {}): Promise<SchemaSource> {
  const cachePath = cacheFilePath(opts);

  if (!opts.refresh) {
    const cached = readCache(cachePath);
    if (cached) return cached;
  }

  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const response = await doFetch(REMOTE_SCHEMA_URL);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${REMOTE_SCHEMA_URL}`);
    }
    const schema = (await response.json()) as unknown;
    if (typeof schema !== "object" || schema === null) {
      throw new Error(`${REMOTE_SCHEMA_URL} returned a non-object body`);
    }
    const source: SchemaSource = { schema, source: "remote", fetchedAt: new Date().toISOString() };
    writeCache(cachePath, source);
    return source;
  } catch {
    // refresh failed: serve the cache, else the vendored copy
  }

  return readCache(cachePath) ?? bundledFallback(opts.bundledPath);
}

/** Absolute-URI `$ref` (anything with a `scheme://` prefix); `#/$defs/...` is local. */
const REMOTE_REF = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Deep-copy the schema dropping every remote `$ref` keyword. pi's published
 * schema is self-contained today (all `$defs` inline, zero remote refs — see
 * the vendored copy), so this is a no-op in practice; the helper is kept as a
 * guard for a future pi schema that references a remote model catalog. Under
 * draft 2020-12 a `$ref` conjoins with its siblings, so deleting the keyword
 * is exactly stubbing the referenced schema with permissive `{}` while
 * keeping local `#/$defs/...` refs and sibling keywords intact — ajv then
 * compiles offline.
 */
function stubRemoteRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stubRemoteRefs);
  if (typeof node === "object" && node !== null) {
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string" && REMOTE_REF.test(value)) continue;
      copy[key] = stubRemoteRefs(value);
    }
    return copy;
  }
  return node;
}

// One compiled validator per schema generation. `fetchedAt` is unique per
// refresh ("bundled" for the vendored copy), so the map stays small.
const validators = new Map<string, ValidateFunction>();

function getValidator(source: SchemaSource): ValidateFunction {
  let validate = validators.get(source.fetchedAt);
  if (!validate) {
    // `strict: false` is what makes `deprecated: true` (and every other
    // annotation ajv would warn about) invisible: deprecation is never a
    // validation error — warnings belong to the raw tab, not Issues.
    const ajv = new Ajv2020({ strict: false, allErrors: true, verbose: false });
    validate = ajv.compile(stubRemoteRefs(source.schema) as object);
    validators.set(source.fetchedAt, validate);
  }
  return validate;
}

function instancePathSegments(instancePath: string): (string | number)[] {
  return instancePath
    .split("/")
    .slice(1)
    .map((segment) => {
      const unescaped = segment.replace(/~1/g, "/").replace(/~0/g, "~");
      return /^\d+$/.test(unescaped) ? Number(unescaped) : unescaped;
    });
}

/** Same dot/bracket style as core/jsonc's parse-issue paths. */
function formatPath(segments: (string | number)[]): string {
  let out = "";
  for (const segment of segments) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else {
      out += out === "" ? segment : `.${segment}`;
    }
  }
  return out;
}

function toIssue(error: ErrorObject): Issue {
  const segments = instancePathSegments(error.instancePath);
  let message = error.message ?? `validation failed (${error.keyword})`;
  if (error.keyword === "additionalProperties") {
    const extra = (error.params as { additionalProperty?: unknown }).additionalProperty;
    if (typeof extra === "string") {
      segments.push(extra);
      message = `${message}: "${extra}"`;
    }
  }
  return { path: formatPath(segments), message };
}

/**
 * Validate a `models.json` document's text against a loaded schema: parse
 * first (parse errors short-circuit to Issues), then ajv. Errors become
 * `Issue`s with dot-paths (`providers.Maya.baseUrl`; array steps as
 * `providers.Maya.models[0]`), and for `additionalProperties` the offending
 * key is appended to the path. A schema that cannot be compiled or run
 * degrades to a single Issue instead of throwing — a user config must never
 * crash the app through validation.
 */
export function validateConfigText(text: string, schema: SchemaSource): Issue[] {
  const { value, errors } = parseJsonc(text);
  if (errors.length > 0) return errors;

  try {
    const validate = getValidator(schema);
    if (validate(value)) return [];
    return (validate.errors ?? []).map(toIssue);
  } catch (cause) {
    return [{ path: "", message: `schema validation unavailable: ${String(cause)}` }];
  }
}

/** Per-document text validator; the save pipeline runs it on the edited text. */
export type DocValidator = (text: string) => Issue[];

/**
 * Pick the validator for one agent document. `models` runs against the loaded
 * pi schema; `auth` uses the hand-rolled permissive validator (there is no
 * published auth.json schema — see `auth-schema.ts`); the read-only `other`
 * documents are never validated, so they get a no-op.
 */
export function validatorFor(docId: DocId, schema: SchemaSource): DocValidator {
  if (docId === "models") return (text) => validateConfigText(text, schema);
  if (docId === "auth") return validateAuthText;
  return () => [];
}
