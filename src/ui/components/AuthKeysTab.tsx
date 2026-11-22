import { useEffect, useMemo, useState } from "react";

import { BUILTIN_PROVIDER_IDS } from "../../core/builtins";
import { classifyKey } from "../../core/keyref";
import { parseJsonc } from "../../core/jsonc";
import type { JsonValue, PathEdit } from "../../core/types";
import type { CurrentDoc, ToastKind } from "../App";
import { conflictNotice, deleteEntryEdits, keyFormBadge, parseAuthDoc, setEntryEdits } from "../auth-logic";
import { editInText } from "../editor-path";
import { useSaveFates } from "../use-save-fates";
import { AuthEntryEditor } from "./AuthEntryEditor";

type Obj = { [k: string]: JsonValue };

function isObj(value: JsonValue | undefined): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface AuthKeysTabProps {
  /** The open `auth` document (App guarantees the doc before mounting). */
  doc: CurrentDoc;
  /** Bumped by App on every disk load — the re-seed trigger (as in RawJsonTab). */
  loadNonce: number;
  onReload: () => void;
  onToast: (message: string, kind?: ToastKind) => void;
  /** Reports unsaved structured edits so App can confirm on tab switch. */
  onDirty: (dirty: boolean) => void;
}

/**
 * The API Keys tab: pi's `auth.json` as a list of provider-keyed credential
 * entries (layout classes shared with the Providers tab — auth.json is
 * keyed by the same provider ids). Pending `PathEdit[]` follow the sister
 * architecture, but the SAVE is the REBASE flavor: edits + `baseText` (the
 * text exactly as loaded) go to the server, which replays them onto freshly
 * read disk content — pi rotates OAuth tokens in this file while it runs.
 *
 * Two consequences made explicit here:
 * - On success the client has NEVER seen the post-rebase disk text, so this
 *   tab never stamps a client-computed text via onSaved (that would poison
 *   the next save's base and could let a Raw-tab save clobber a live token);
 *   it toasts, drops the applied edits and reloads disk truth instead.
 * - On a 409 conflict nothing reloads by itself: the banner names the
 *   clashed entries and the USER chooses — reload the disk version (confirm,
 *   discards pending edits) or keep editing. There is no Force save here,
 *   on purpose: a force-save of a stale auth snapshot could revoke a live
 *   pi session (spec builder-check item 1).
 *
 * Unknown credential types and non-object rows are listed read-only
 * ("managed by /login in pi") and are never rewritten; only `api_key`
 * entries are editable or deletable here.
 */
export function AuthKeysTab({ doc, loadNonce, onReload, onToast, onDirty }: AuthKeysTabProps) {
  const [edits, setEdits] = useState<PathEdit[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [newEntryId, setNewEntryId] = useState("");
  const { saving, stale, blockedIssues, conflictEntries, clearConflict, resetFates, runSave } = useSaveFates({
    doc: "auth",
    onToast,
    onReload,
    onOk: (_body, outcome) => {
      setEdits([]);
      onToast(
        outcome.backupPath === ""
          ? "Saved. (File created — nothing to back up.)"
          : `Saved. Backup: ${outcome.backupPath}`,
      );
      // Re-read the rebased disk truth (bumps loadNonce → this tab re-seeds).
      onReload();
    },
    // No onConflict: the entry-named banner below is the user's choice, not
    // an automatic reload.
  });

  useEffect(() => {
    setEdits([]);
    setSelected(null);
    setNewEntryId("");
    resetFates();
  }, [loadNonce]);

  const dirty = edits.length > 0;
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);

  // Parse guard (ProviderList pattern): applyPathEdits REFUSES malformed
  // JSONC, so structured editing is disabled until the Raw tab fixes it.
  const baseParse = useMemo(() => parseJsonc(doc.text), [doc.text]);
  const parseBroken = baseParse.errors.length > 0 || !isObj(baseParse.value);

  const [derived, derivedError] = useMemo((): [string | null, string | null] => {
    if (parseBroken) return [null, null];
    try {
      return [editInText(doc.text, edits), null];
    } catch (err) {
      // Defensive: the pending edits are produced against this same text.
      return [
        null,
        `Structured edit failed: ${err instanceof Error ? err.message : String(err)} — reload from disk to start over.`,
      ];
    }
  }, [doc.text, edits, parseBroken]);

  const derivedDoc = derived === null ? undefined : (parseJsonc(derived).value as JsonValue | undefined);
  const views = derivedDoc === undefined ? [] : parseAuthDoc(derivedDoc);
  const selectedView = views.find((view) => view.id === selected);

  const apply = (newEdits: PathEdit[]): void => {
    setEdits((previous) => [...previous, ...newEdits]);
  };

  // REBASE save body: `text`/`baseSha256`/`baseIssues` stay the honest base
  // (the server ignores the first two on this path); `edits` + `baseText`
  // ARE the request — edits computed against the text exactly as loaded.
  const save = async (): Promise<void> => {
    await runSave({
      doc: "auth",
      text: doc.text,
      baseSha256: doc.sha256,
      baseIssues: doc.issues,
      edits,
      baseText: doc.text,
    });
  };

  const reloadDiskVersion = (): void => {
    if (
      edits.length === 0 ||
      window.confirm("Reload auth.json from disk? This discards your pending API-key edits.")
    ) {
      onReload();
    }
  };

  const addEntry = (): void => {
    const id = newEntryId.trim();
    if (id === "" || views.some((view) => view.id === id)) return;
    // Created WITHOUT a key: the validator's new_issues copy blocks a save
    // that still lacks one, so the user is told rather than pi getting "".
    apply(setEntryEdits(id, {}));
    setNewEntryId("");
    setSelected(id);
  };

  if (parseBroken) {
    return (
      <section className="provider-list-tab">
        <div className="error-banner">
          auth.json has parse errors — fix them in the Raw JSON tab first; structured editing is
          disabled while the document does not parse.
        </div>
      </section>
    );
  }

  return (
    <section className="provider-list-tab">
      {derivedError !== null && <div className="error-banner">{derivedError}</div>}

      <div className="warning-banner">auth.json holds secrets — never commit it.</div>

      {!doc.exists && (
        <div className="hint">
          auth.json does not exist yet — the editor shows the documented seed; the first save
          creates the file (mode 0600 on POSIX).
        </div>
      )}

      {conflictEntries !== null && (
        <div className="stale-banner">
          {conflictNotice(conflictEntries)}{" "}
          <button type="button" onClick={reloadDiskVersion} disabled={saving}>
            Reload disk version
          </button>{" "}
          <button type="button" onClick={clearConflict} disabled={saving}>
            Keep editing
          </button>
        </div>
      )}
      {stale && (
        <div className="stale-banner">
          The file changed on disk since you loaded it — your pending edits are not lost.{" "}
          <button type="button" onClick={reloadDiskVersion} disabled={saving}>
            Reload
          </button>{" "}
          <span className="hint">
            (Structured auth saves rebase onto disk; there is deliberately no Force save here.)
          </span>
        </div>
      )}
      {blockedIssues !== null && (
        <div className="issues-banner">
          <div>Save refused — the edits introduce new validation errors:</div>
          <ul>
            {blockedIssues.map((issue, index) => (
              <li key={`${issue.path}|${issue.message}|${index}`}>
                <code>{issue.path || "(document)"}</code>: {issue.message}
              </li>
            ))}
          </ul>
          <div className="hint">Adjust above; pending edits are kept.</div>
        </div>
      )}

      <div className="provider-columns">
        <div className="provider-picker">
          <div className="provider-list-head">Entries ({views.length})</div>
          {views.map((view) => (
            <div key={view.id} className={`provider-row${selected === view.id ? " provider-row-active" : ""}`}>
              <button
                type="button"
                title={view.id}
                onClick={() => setSelected(view.id)}
              >
                {view.id}
              </button>
              {view.kind === "readonly" && (
                <span className="shape-badge" title="credential type managed by /login and /logout in pi — read-only here">
                  {view.type}
                </span>
              )}
              {view.kind === "shape_error" && (
                <span className="shape-badge" title="not an object with a string type — edit it in the Raw JSON tab">
                  raw only
                </span>
              )}
              {view.kind === "api_key" && (
                <span className="provider-row-counts" title="pi key form (never revealed in the list)">
                  {view.key === undefined || view.key === "" ? "no key" : keyFormBadge(classifyKey(view.key))}
                </span>
              )}
              {view.kind === "api_key" && view.extra && (
                <div className="hint">
                  this entry has fields the structured editor does not model — use Raw JSON to
                  change them
                </div>
              )}
            </div>
          ))}
          {views.length === 0 && <div className="hint">no stored credentials yet</div>}
          <div className="provider-add">
            <input
              type="text"
              spellCheck={false}
              placeholder="new provider id"
              list="pi-auth-provider-ids"
              value={newEntryId}
              onChange={(event) => setNewEntryId(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addEntry();
              }}
            />
            <datalist id="pi-auth-provider-ids">
              {BUILTIN_PROVIDER_IDS.map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
            <button type="button" onClick={addEntry} disabled={newEntryId.trim() === "" || views.some((view) => view.id === newEntryId.trim())}>
              + add
            </button>
          </div>
        </div>

        <div className="provider-detail">
          {selectedView === undefined ? (
            <div className="hint">Select an entry to inspect or edit it, or add a new API key.</div>
          ) : selectedView.kind === "api_key" ? (
            <>
              <div className="provider-detail-head">
                <span className="field-label">auth.{selectedView.id}</span>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`Remove the "${selectedView.id}" entry from auth.json?`)) {
                      apply(deleteEntryEdits(selectedView.id));
                      setSelected(null);
                    }
                  }}
                >
                  delete entry
                </button>
              </div>
              <AuthEntryEditor
                key={selectedView.id}
                entryId={selectedView.id}
                entry={selectedView}
                otherIds={views.filter((view) => view.id !== selectedView.id).map((view) => view.id)}
                apply={apply}
                onRenamed={(newId) => setSelected(newId)}
              />
            </>
          ) : (
            <>
              <div className="provider-detail-head">
                <span className="field-label">auth.{selectedView.id}</span>
              </div>
              <div className="warning-banner">
                {selectedView.kind === "readonly"
                  ? `This entry uses the "${selectedView.type}" credential type — it is managed by /login and /logout in pi. It is shown read-only here and stays byte-stable across GUI saves.`
                  : "This entry is not a JSON object with a string type — it is shown read-only here; edit it in the Raw JSON tab."}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="raw-actions">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !dirty || derived === null}
        >
          {saving ? "Saving…" : `Save${dirty ? ` (${edits.length} edit${edits.length === 1 ? "" : "s"})` : ""}`}
        </button>
        <button type="button" onClick={reloadDiskVersion} disabled={saving}>
          Reload from disk
        </button>
        {dirty && <span className="dirty-marker">unsaved key changes</span>}
      </div>
    </section>
  );
}
