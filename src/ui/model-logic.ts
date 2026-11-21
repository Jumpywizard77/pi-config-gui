/**
 * Pure logic for the model / modelOverrides editors (Task 11): the edits the
 * editors emit and the review state the probe-import dialog shows. No React,
 * no fetch — unit-pinned in `test/ui/model-logic.test.ts`.
 *
 * pi's `models` container is an ARRAY of `{ id, … }` entries (unlike the
 * sister opencode doc's models map), so:
 * - Appending uses the jsonc-parser out-of-range index sentinel `MODEL_APPEND`
 *   (-1): `modify` clamps any out-of-range array index to an append at the
 *   END (no null padding, comments preserved), and each edit in a batch is
 *   resolved against the running text — so repeated `-1` edits keep order.
 *   Pinned end-to-end through the shared `applyPathEdits`.
 * - "Key rename" is delete-at-index + append-modified-copy (the sister's
 *   "renaming re-creates the entry at the end of the list" pattern).
 *
 * Binding merge rule (spec "Settled during builder-check" 2): probe-import
 * MERGES BY MODEL ID and NEVER overwrites existing entries. `mergeImportEdits`
 * filters already-present ids out of the emitted edits entirely — the review
 * UI flags them, but no edit can touch an existing entry. "Review limits"
 * marking is UI-only, never written to the file.
 */

import type { EnvKeyUnresolvedWarning } from "./api";
import type { JsonValue, PathEdit } from "../core/types";

/** pi schema defaults the import writes for a newly-discovered model. */
export const IMPORT_DEFAULT_LIMITS = { contextWindow: 128000, maxTokens: 16384 } as const;

/** jsonc-parser `modify` resolves this out-of-range index to "append at end". */
export const MODEL_APPEND = -1;

function modelsPath(providerId: string): (string | number)[] {
  return ["providers", providerId, "models"];
}

function overridesPath(providerId: string): (string | number)[] {
  return ["providers", providerId, "modelOverrides"];
}

/** One new empty model entry appended to the provider's `models` array. */
export function addModelEdits(providerId: string, id: string): PathEdit[] {
  return [{ path: [...modelsPath(providerId), MODEL_APPEND], value: { id } }];
}

/**
 * Set/delete one field of the model at array `index`
 * (`undefined` deletes the path; blank text fields pass undefined).
 */
export function setModelFieldEdits(
  providerId: string,
  index: number,
  field: string,
  value: JsonValue | undefined,
): PathEdit[] {
  return [{ path: [...modelsPath(providerId), index, field], value }];
}

/**
 * Rename a model entry: delete at `index`, then append a copy carrying
 * `newId` (entries re-create at the END of the array — sibling pattern).
 */
export function renameModelEdits(
  providerId: string,
  index: number,
  model: JsonValue,
  newId: string,
): PathEdit[] {
  const copy: { [k: string]: JsonValue } =
    typeof model === "object" && model !== null && !Array.isArray(model) ? { ...model } : {};
  copy["id"] = newId;
  return [
    { path: [...modelsPath(providerId), index], value: undefined },
    { path: [...modelsPath(providerId), MODEL_APPEND], value: copy },
  ];
}

/** Delete the model entry at array `index` (caller confirms in the UI). */
export function deleteModelEdits(providerId: string, index: number): PathEdit[] {
  return [{ path: [...modelsPath(providerId), index], value: undefined }];
}

/**
 * The probe-import merge: ONE append edit per picked id that is NOT already
 * in the document (ids in `existingIds` are excluded here — they are only
 * ever flagged in the review UI), deduped, in the endpoint's own order. Each
 * added entry is `{ id, contextWindow: 128000, maxTokens: 16384 }`; existing
 * entries are NEVER overwritten, other providers are never touched.
 */
export function mergeImportEdits(
  providerId: string,
  existingIds: string[],
  pickedIds: string[],
): PathEdit[] {
  const existing = new Set(existingIds);
  const seen = new Set<string>();
  const edits: PathEdit[] = [];
  for (const id of pickedIds) {
    if (existing.has(id) || seen.has(id)) continue;
    seen.add(id);
    edits.push({
      path: [...modelsPath(providerId), MODEL_APPEND],
      value: { id, ...IMPORT_DEFAULT_LIMITS },
    });
  }
  return edits;
}

/** One new empty override map entry: `modelOverrides.<modelId> = {}`. */
export function addOverrideEdits(providerId: string, modelId: string): PathEdit[] {
  return [{ path: [...overridesPath(providerId), modelId], value: {} }];
}

/**
 * Set/delete one field of the override map entry `modelId`
 * (empty `field` addresses the whole entry — `undefined` deletes it).
 */
export function setOverrideFieldEdits(
  providerId: string,
  modelId: string,
  field: string,
  value: JsonValue | undefined,
): PathEdit[] {
  return [{ path: [...overridesPath(providerId), modelId, ...(field === "" ? [] : [field])], value }];
}

/** Rename an override key: delete-old + create-new carrying the value over. */
export function renameOverrideEdits(
  providerId: string,
  oldId: string,
  value: JsonValue,
  newId: string,
): PathEdit[] {
  return [
    { path: [...overridesPath(providerId), oldId], value: undefined },
    { path: [...overridesPath(providerId), newId], value },
  ];
}

/** One row of the import review list (checkbox state lives in the dialog). */
export interface ImportRow {
  id: string;
  /** Id already in the file: rendered disabled + "already configured". */
  alreadyPresent: boolean;
  /** Pre-checked for unseen ids ONLY (probe re-run never re-imports). */
  checked: boolean;
}

/** The review list for a probe result: deduped, endpoint order, unseen pre-checked. */
export function planImportRows(discoveredIds: string[], existingIds: string[]): ImportRow[] {
  const existing = new Set(existingIds);
  const seen = new Set<string>();
  const rows: ImportRow[] = [];
  for (const id of discoveredIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const alreadyPresent = existing.has(id);
    rows.push({ id, alreadyPresent, checked: !alreadyPresent });
  }
  return rows;
}

/**
 * React keys for the model-entry editors (fix round 1): keyed by the ENTRY
 * (id), not the array slot. A rename is delete-at-index + append-at-end, so
 * index-keyed editors would keep a shifted entry's card (and its in-progress
 * `keyDraft`) attached to a DIFFERENT entry. `idx:<index>` is the fallback
 * for non-object/id-less slots; duplicate ids (hand-edited files) get
 * numeric suffixes so keys stay unique.
 */
export function modelEditorKeys(entries: JsonValue[]): string[] {
  const base = entries.map((entry, index) =>
    typeof entry === "object" && entry !== null && !Array.isArray(entry) && typeof entry["id"] === "string" && entry["id"] !== ""
      ? `id:${entry["id"] as string}`
      : `idx:${index}`,
  );
  const seen = new Map<string, number>();
  return base.map((key) => {
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    return count === 0 ? key : `${key}#${count}`;
  });
}

/**
 * Whether a failed `api.probe` call is the server's machine-readable refusal
 * to test a `!command` apiKey (HTTP 400 `command_key`, pre-network — the GUI
 * never executes it). Drives the "resolve the key to test" notice.
 */
export function isCommandKeyRejection(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /\bcommand_key\b/.test(message);
}

/** Notice for the server's unresolved-`$ENV`-key warning, or null. */
export function envKeyWarningText(warning: EnvKeyUnresolvedWarning | undefined): string | null {
  if (warning === undefined) return null;
  return `probed keyless — env key(s) not set on the server: ${warning.names.join(", ")}`;
}
