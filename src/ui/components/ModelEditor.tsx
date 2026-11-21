import { useState } from "react";

import type { JsonValue, PathEdit } from "../../core/types";
import { CostEditor, NumInput } from "./CostEditor";
import { JsonField } from "./JsonField";

type Obj = { [k: string]: JsonValue };

function isObj(value: JsonValue | undefined): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStr(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
}

interface ModelEditorProps {
  /** The entry's current parsed object (re-derived after every edit). */
  entry: Obj;
  /** Path of the entry: `providers.<id>.models[<index>]` or `…modelOverrides.<modelId>`. */
  entryPath: (string | number)[];
  /** Array entry (has `id`/`api`/`baseUrl`) vs. map entry (override fields only). */
  variant: "model" | "override";
  /** The array entry's `id` field, or the map key for overrides. */
  entryKey: string;
  /** Sibling ids/keys for rename collision checks. */
  siblingKeys: string[];
  /** Commit a key rename (the caller emits the delete + re-create pair). */
  onRename: (newKey: string) => void;
  /** Delete the entry (the caller confirms and emits the delete edit). */
  onDelete: () => void;
  apply: (edits: PathEdit[]) => void;
  /** UI-only badge on just-imported rows ("review limits") — never stored. */
  reviewLimits?: boolean;
}

/** Free-form JSON sub-blocks kept as `JsonField`s (spec: JSON sub-editor OK). */
const JSON_KEYS = [
  "compat",
  "samplingParams",
  "samplingParamsByThinkingLevel",
  "thinkingLevelMap",
  "inputLimits",
  "promptCache",
] as const;

/**
 * One model entry (`models[i]`) or `modelOverrides.<id>` entry — pi's field
 * set from the vendored schema. Overrides render the same editor minus
 * `id`/`api`/`baseUrl` (not overridable) and without the array-index rename
 * semantics. Blank text fields DELETE the key; unchecked `reasoning` and an
 * empty `input` set delete theirs (schema defaults: false / ["text"]).
 */
export function ModelEditor({
  entry,
  entryPath,
  variant,
  entryKey,
  siblingKeys,
  onRename,
  onDelete,
  apply,
  reviewLimits,
}: ModelEditorProps) {
  const [keyDraft, setKeyDraft] = useState(entryKey);

  const commitKey = (): void => {
    const next = keyDraft.trim();
    if (next === "" || siblingKeys.includes(next)) {
      setKeyDraft(entryKey);
      return;
    }
    if (next === entryKey) return;
    onRename(next);
  };

  const setField = (key: string, value: JsonValue | undefined): void => {
    apply([{ path: [...entryPath, key], value }]);
  };

  const setInputKind = (kind: "text" | "image", checked: boolean): void => {
    // Toggling rewrites the whole array in canonical order; unknown values
    // (schema-invalid anyway) are dropped. Empty set = delete (default text).
    const current = new Set(
      Array.isArray(entry["input"])
        ? (entry["input"] as JsonValue[]).filter((x): x is "text" | "image" => x === "text" || x === "image")
        : [],
    );
    if (checked) current.add(kind);
    else current.delete(kind);
    const next = (["text", "image"] as const).filter((k) => current.has(k));
    setField("input", next.length === 0 ? undefined : [...next]);
  };
  const inputSet = new Set(
    Array.isArray(entry["input"]) ? (entry["input"] as JsonValue[]) : undefined,
  );

  return (
    <div className="model-editor">
      <div className="model-key-row">
        <span className="field-label">{variant === "model" ? "id (API model id)" : "model id (override key)"}</span>
        <input
          type="text"
          spellCheck={false}
          value={keyDraft}
          onChange={(event) => setKeyDraft(event.target.value)}
          onBlur={commitKey}
          onKeyDown={(event) => {
            if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          }}
        />
        {reviewLimits === true && (
          <span className="badge badge-amber" title="imported with default limits — not written as a marker">
            review limits
          </span>
        )}
        <span className="hint">renaming re-creates the entry at the end</span>
        <button type="button" onClick={onDelete}>
          delete {variant === "model" ? "model" : "override"}
        </button>
      </div>

      <div className="field-grid">
        <label>
          <span className="field-label">Display name</span>
          <input
            type="text"
            spellCheck={false}
            value={asStr(entry["name"])}
            onChange={(event) => setField("name", event.target.value === "" ? undefined : event.target.value)}
          />
        </label>
        {variant === "model" && (
          <>
            <label>
              <span className="field-label">api (overrides the provider api)</span>
              <input
                type="text"
                spellCheck={false}
                value={asStr(entry["api"])}
                onChange={(event) => setField("api", event.target.value === "" ? undefined : event.target.value)}
              />
            </label>
            <label>
              <span className="field-label">baseUrl (overrides the provider baseUrl)</span>
              <input
                type="text"
                spellCheck={false}
                value={asStr(entry["baseUrl"])}
                onChange={(event) => setField("baseUrl", event.target.value === "" ? undefined : event.target.value)}
              />
            </label>
          </>
        )}
        <label>
          <span className="field-label">contextWindow (tokens)</span>
          <NumInput
            value={entry["contextWindow"]}
            integerOnly
            onChange={(next) => setField("contextWindow", next)}
          />
        </label>
        <label>
          <span className="field-label">maxTokens (output)</span>
          <NumInput value={entry["maxTokens"]} integerOnly onChange={(next) => setField("maxTokens", next)} />
        </label>
      </div>

      <div className="bool-row">
        <label className="bool" title="unchecked deletes the key (schema default: false)">
          <input
            type="checkbox"
            checked={entry["reasoning"] === true}
            onChange={(event) => setField("reasoning", event.target.checked ? true : undefined)}
          />
          reasoning (supports thinking)
        </label>
        <label className="bool">
          <input
            type="checkbox"
            checked={entry["input"] === undefined ? true : inputSet.has("text")}
            onChange={(event) => setInputKind("text", event.target.checked)}
          />
          input: text
        </label>
        <label className="bool">
          <input
            type="checkbox"
            checked={inputSet.has("image")}
            onChange={(event) => setInputKind("image", event.target.checked)}
          />
          input: image
        </label>
      </div>

      <CostEditor cost={entry["cost"]} costPath={[...entryPath, "cost"]} apply={apply} />

      <ModelHeaders headers={isObj(entry["headers"]) ? (entry["headers"] as Obj) : undefined} entryPath={entryPath} apply={apply} />

      {JSON_KEYS.map((key) => (
        <JsonField
          key={key}
          label={`${key} (JSON)`}
          value={entry[key]}
          onChange={(next) => setField(key, next)}
          deleteWhenUndefined
        />
      ))}
    </div>
  );
}

/** Per-model `headers` rows (string values; same rewrite pattern as the provider's). */
function ModelHeaders({
  headers,
  entryPath,
  apply,
}: {
  headers: Obj | undefined;
  entryPath: (string | number)[];
  apply: (edits: PathEdit[]) => void;
}) {
  const entries: [string, string][] = Object.entries(headers ?? {}).map(
    ([key, value]) => [key, asStr(value)] as [string, string],
  );
  const rewrite = (next: [string, string][]): void => {
    const cleaned = next.filter(([key]) => key !== "");
    const value: Obj = {};
    for (const [key, headerValue] of cleaned) value[key] = headerValue;
    apply([{ path: [...entryPath, "headers"], value: cleaned.length === 0 ? undefined : value }]);
  };
  const replace = (index: number, next: [string, string]): void => {
    rewrite(entries.map((entry, i) => (i === index ? next : entry)));
  };
  return (
    <div className="kv-block">
      <span className="field-label">headers (values resolve like apiKey)</span>
      {entries.map(([key, value], index) => (
        <div className="kv-row" key={index}>
          <input
            type="text"
            spellCheck={false}
            value={key}
            onChange={(event) => replace(index, [event.target.value, value])}
          />
          <input
            type="text"
            spellCheck={false}
            value={value}
            onChange={(event) => apply([{ path: [...entryPath, "headers", key], value: event.target.value }])}
          />
          <button type="button" onClick={() => rewrite(entries.filter((_, i) => i !== index))}>
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={entries.some(([key]) => key === "")}
        onClick={() => apply([{ path: [...entryPath, "headers", ""], value: "" }])}
      >
        + header
      </button>
    </div>
  );
}
