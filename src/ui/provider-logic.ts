/**
 * Pure logic for the Providers & Models tab (Task 10): parsing the stored
 * `models.json` shape into list views, compiling "add provider" edits, and
 * the small apiKey/URL helpers the editor needs. No React, no fetch — unit-
 * pinned in `test/ui/provider-logic.test.ts`.
 *
 * The stored shape (see `core/schema-bundled.json`): providers live under the
 * top-level `providers` map; each entry may carry `name`, `baseUrl`, `api`,
 * `apiKey`, `oauth`, `headers`, `compat`, `authHeader`, `models` (an ARRAY of
 * `{ id, … }` objects — NOT a map, unlike the sister opencode doc) and
 * `modelOverrides` (a map). No entry key is required.
 */

import { BUILTIN_PROVIDER_IDS } from "../core/builtins";
import type { LocalPreset } from "../core/presets";
import type { JsonValue, PathEdit } from "../core/types";

/** One row of the provider list (counts are for the row badges, not editing). */
export interface ProviderEntryView {
  id: string;
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  /** True when editing this id reroutes a pi built-in provider. */
  builtinReroute: boolean;
  modelCount: number;
  overrideCount: number;
  /** Entry is not an object → render read-only with a "use the Raw tab" note. */
  shapeError?: true;
}

function isObj(value: JsonValue | undefined): value is { [k: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** String field or undefined — non-string values never leak into the view. */
function asStr(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * The `providers` block as list rows, in document order. Non-object entries
 * are KEPT and flagged `shapeError` (the list shows them read-only; deleting
 * them is still possible, editing is Raw-tab work).
 */
export function parseProviders(doc: JsonValue): ProviderEntryView[] {
  if (!isObj(doc)) return [];
  const providers = doc["providers"];
  if (!isObj(providers)) return [];
  const views: ProviderEntryView[] = [];
  for (const [id, value] of Object.entries(providers)) {
    const base = {
      id,
      builtinReroute: BUILTIN_PROVIDER_IDS.includes(id),
      modelCount: 0,
      overrideCount: 0,
    };
    if (!isObj(value)) {
      views.push({ ...base, shapeError: true });
      continue;
    }
    const models = value["models"];
    const overrides = value["modelOverrides"];
    views.push({
      ...base,
      name: asStr(value["name"]),
      baseUrl: asStr(value["baseUrl"]),
      api: asStr(value["api"]),
      apiKey: asStr(value["apiKey"]),
      modelCount: Array.isArray(models) ? models.length : 0,
      overrideCount: isObj(overrides) ? Object.keys(overrides).length : 0,
    });
  }
  return views;
}

/**
 * The create-edit for a new provider: preset-backed entries carry the
 * preset's `baseUrl`/`api`/`apiKey` (empty preset strings are omitted so a
 * generic endpoint does not write `baseUrl: ""` debris); free ids start as an
 * empty `{}` object exactly like the sister's add flow.
 */
export function addProviderEdits(id: string, preset: LocalPreset | null): PathEdit[] {
  const value: { [k: string]: JsonValue } = {};
  if (preset !== null) {
    if (preset.baseUrl !== "") value["baseUrl"] = preset.baseUrl;
    if (preset.api !== "") value["api"] = preset.api;
    if (preset.apiKey !== "") value["apiKey"] = preset.apiKey;
  }
  return [{ path: ["providers", id], value }];
}

/**
 * The NAME of a WHOLE-VALUE `$NAME` / `${NAME}` env-ref key (the wrap/unwrap
 * button's precondition), or null for literals, commands, escaped `$$` and
 * mixed strings (only whole-value refs round-trip safely).
 */
export function envRefName(value: string): string | null {
  const bare = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
  if (bare !== null) return bare[1]!;
  const short = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
  return short === null ? null : short[1]!;
}

/**
 * Rewrite a value as its own LITERAL by escaping every `$` as `$$` (pi's
 * documented escape, see `core/keyref`): the "unwrap" direction of the env
 * helper. `classifyKey(escapeLiteralDollar(x))` is always "literal".
 */
export function escapeLiteralDollar(value: string): string {
  return value.split("$").join("$$");
}

/**
 * Whether a baseUrl points at this machine — gates the preset dialog's
 * "open editor + auto-run probe" step (never auto-hit a remote endpoint).
 */
export function isLocalhostUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  // URL keeps brackets on IPv6 hosts: "[::1]".
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\./.test(host)
  );
}
