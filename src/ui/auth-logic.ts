import type { KeyForm } from "../core/keyref";
import type { JsonValue, PathEdit } from "../core/types";

/**
 * Pure logic for the API Keys tab (`auth.json`). The entry model is
 * deliberately narrow: only `type: "api_key"` entries with a string `key`
 * and a string-valued `env` map are editable. Everything else — OAuth and
 * other credential types pi's `/login` manages, future shapes, non-object
 * rows — surfaces as a read-only or shape-error row that this GUI never
 * rewrites (spec anti-goal: no wholesale rewriting of auth.json).
 *
 * Saves go through the server's REBASE path: every edit is ONE top-level
 * entry rewrite (or delete) at `[id]`, and untouched entries are simply
 * never addressed, so the rebase keeps them byte-stable.
 */

export type EntryView =
  | { id: string; kind: "api_key"; key?: string; env: Record<string, string> }
  | { id: string; kind: "readonly"; type: string }
  | { id: string; kind: "shape_error" };

function isJsonObject(value: JsonValue): value is { [k: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rows for the API Keys list, sorted alphabetically by provider id. A
 * non-object document yields no rows (the tab shows its own banner; the
 * auth-schema validator owns the blocking copy).
 */
export function parseAuthDoc(doc: JsonValue): EntryView[] {
  if (!isJsonObject(doc)) return [];
  const views: EntryView[] = [];
  for (const [id, entry] of Object.entries(doc)) {
    if (!isJsonObject(entry)) {
      views.push({ id, kind: "shape_error" });
      continue;
    }
    const type = entry["type"];
    if (typeof type !== "string") {
      views.push({ id, kind: "shape_error" });
      continue;
    }
    if (type !== "api_key") {
      // Unknown credential types (oauth, device flows, future pi shapes)
      // are permissive by design: listed read-only, never blocked or saved.
      views.push({ id, kind: "readonly", type });
      continue;
    }
    const key = typeof entry["key"] === "string" ? (entry["key"] as string) : undefined;
    const env: Record<string, string> = {};
    if (entry["env"] !== undefined && isJsonObject(entry["env"])) {
      for (const [name, value] of Object.entries(entry["env"])) {
        if (typeof value === "string") env[name] = value;
      }
    }
    views.push(key === undefined ? { id, kind: "api_key", env } : { id, kind: "api_key", key, env });
  }
  views.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return views;
}

/**
 * Rewrite the WHOLE `api_key` entry at `[id]` (the only edit shape the auth
 * tab emits — the rebase conflict gate compares exactly these entries).
 * `key: undefined` omits the field (the validator's new_issues copy then
 * explains a missing key); an empty `env` is omitted rather than writing
 * `env: {}` debris.
 *
 * `previous` exists for API symmetry with the editor's edit events; the
 * entry model carries only type/key/env, so a rewrite never preserves
 * fields beyond those (see the Task 12 report disclosure).
 */
export function setEntryEdits(
  id: string,
  entry: { key?: string; env?: Record<string, string> },
  previous?: EntryView,
): PathEdit[] {
  void previous; // intentionally unused — see the doc comment above.
  const value: { [k: string]: JsonValue } = { type: "api_key" };
  if (entry.key !== undefined) value["key"] = entry.key;
  if (entry.env !== undefined && Object.keys(entry.env).length > 0) value["env"] = entry.env;
  return [{ path: [id], value }];
}

/** Remove the whole entry at `[id]`. */
export function deleteEntryEdits(id: string): PathEdit[] {
  return [{ path: [id], value: undefined }];
}

/**
 * Banner copy for a 409 rebase conflict: names the clashed provider entries
 * (never key values), states plainly that nothing was saved, and points at
 * the two honest fates (reload the disk version, or keep editing).
 */
export function conflictNotice(entries: string[]): string {
  return (
    `pi changed ${entries.join(", ")} in auth.json since you loaded it — ` +
    `your pending edits were NOT saved. Reload the disk version (this discards ` +
    `your pending edits) or keep editing and save again.`
  );
}

/** Display badge for one `classifyKey` form (mask/readonly rendering per form). */
export function keyFormBadge(form: KeyForm): string {
  return form === "env" ? "$ENV" : form === "command" ? "!command" : "literal";
}
