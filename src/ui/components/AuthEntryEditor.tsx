import { useState } from "react";

import { classifyKey } from "../../core/keyref";
import type { PathEdit } from "../../core/types";
import type { EntryView } from "../auth-logic";
import { deleteEntryEdits, keyFormBadge, setEntryEdits } from "../auth-logic";

type ApiKeyEntry = Extract<EntryView, { kind: "api_key" }>;

interface AuthEntryEditorProps {
  entryId: string;
  /** The entry's current parsed view (re-derived from the pending edits). */
  entry: ApiKeyEntry;
  /** Other auth-entry ids (rename collision checks). */
  otherIds: string[];
  apply: (edits: PathEdit[]) => void;
  /** After a committed ID rename, so the parent can move the selection. */
  onRenamed: (newId: string) => void;
}

/**
 * Structured editor for ONE `api_key` entry of pi's `auth.json`. Every field
 * change emits a FULL-ENTRY rewrite via `setEntryEdits` (the entry model
 * carries only type/key/env), so the rebase conflict gate compares exactly
 * the top-level entries the user touched.
 *
 * Key display forms (`core/keyref.classifyKey`): literal and `$NAME` values
 * are masked inputs with a show/hide toggle; a `!command` value renders
 * READ-ONLY with a warning (pi EXECUTES it at runtime — this GUI never does,
 * and never renders or probes it). Env values are the Cloudflare-style
 * account-ID rows pattern from the provider editor's headers.
 */
export function AuthEntryEditor({ entryId, entry, otherIds, apply, onRenamed }: AuthEntryEditorProps) {
  const [idDraft, setIdDraft] = useState(entryId);
  const [revealed, setRevealed] = useState(false);

  const key = entry.key ?? "";
  const keyForm = entry.key === undefined || entry.key === "" ? null : classifyKey(entry.key);

  const rewrite = (nextKey: string | undefined, env: Record<string, string>): void => {
    apply(setEntryEdits(entryId, { key: nextKey, env }, entry));
  };

  const commitRename = (): void => {
    const next = idDraft.trim();
    if (next === "" || otherIds.includes(next)) {
      setIdDraft(entryId);
      return;
    }
    if (next === entryId) return;
    apply([...deleteEntryEdits(entryId), ...setEntryEdits(next, { key: entry.key, env: entry.env }, entry)]);
    onRenamed(next);
  };

  return (
    <div className="provider-editor">
      <div className="field-grid">
        <label>
          <span className="field-label">Provider id (rename = delete + re-create)</span>
          <input
            type="text"
            spellCheck={false}
            value={idDraft}
            onChange={(event) => setIdDraft(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") (event.target as HTMLInputElement).blur();
            }}
          />
        </label>
      </div>

      <div className="api-key-block">
        <span className="field-label">key</span>
        {keyForm === "command" ? (
          <>
            <div className="warning-banner">
              Stored as a <code>!command</code> — pi runs it at runtime to fetch the key. This GUI
              never executes it, so the value is hidden and read-only here; delete this entry and
              add a new one to replace the command.
            </div>
            <div className="hint">
              The <code>!command</code> key is preserved verbatim across env edits made below.
            </div>
          </>
        ) : (
          <div className="api-key-row">
            <input
              type={revealed ? "text" : "password"}
              spellCheck={false}
              placeholder="(no key stored yet)"
              value={key}
              onChange={(event) => rewrite(event.target.value === "" ? undefined : event.target.value, entry.env)}
            />
            <button type="button" onClick={() => setRevealed((shown) => !shown)}>
              {revealed ? "hide" : "show"}
            </button>
            {keyForm !== null && (
              <span className="shape-badge" title="pi key form (core/keyref classification)">
                {keyFormBadge(keyForm)}
              </span>
            )}
          </div>
        )}
      </div>

      <EnvRows env={entry.env} onRewrite={(nextEnv) => rewrite(entry.key, nextEnv)} />
    </div>
  );
}

/**
 * `env` string-map rows (the provider editor's headers pattern): name edits
 * rewrite the whole object dropping empty-name rows; clearing the last row
 * omits `env` entirely instead of writing `env: {}` debris.
 */
function EnvRows({
  env,
  onRewrite,
}: {
  env: Record<string, string>;
  onRewrite: (next: Record<string, string>) => void;
}) {
  const entries: [string, string][] = Object.entries(env);
  const rewrite = (next: [string, string][]): void => {
    const map: Record<string, string> = {};
    for (const [name, value] of next) {
      if (name !== "") map[name] = value;
    }
    onRewrite(map);
  };
  const replace = (index: number, next: [string, string]): void => {
    rewrite(entries.map((entry, i) => (i === index ? next : entry)));
  };
  return (
    <div className="kv-block">
      <span className="field-label">env</span>
      {entries.map(([name, value], index) => (
        <div className="kv-row" key={index}>
          <input
            type="text"
            spellCheck={false}
            value={name}
            placeholder="NAME"
            onChange={(event) => replace(index, [event.target.value, value])}
          />
          <input
            type="text"
            spellCheck={false}
            value={value}
            onChange={(event) => replace(index, [name, event.target.value])}
          />
          <button type="button" onClick={() => rewrite(entries.filter((_, i) => i !== index))}>
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={entries.some(([name]) => name === "")}
        onClick={() => rewrite([...entries, ["", ""]])}
      >
        + env var
      </button>
      <div className="hint">
        pi exposes these variables to the provider process (Cloudflare-style account ids); they are
        not treated as secrets here.
      </div>
    </div>
  );
}
