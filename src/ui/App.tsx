import { useCallback, useEffect, useRef, useState } from "react";

import type { Issue } from "../core/types";
import { getConfig, getState, type DocId, type StatePayload } from "./api";
import { AuthKeysTab } from "./components/AuthKeysTab";
import { ProviderList } from "./components/ProviderList";
import { RawJsonTab } from "./components/RawJsonTab";
import { SchemaBadge } from "./components/SchemaBadge";
import { Toast, type ToastMessage } from "./components/Toast";
import { ValidationPanel } from "./components/ValidationPanel";

/**
 * App shell for pi's agent-config editor. Fork differences from the sister
 * app, per the Task 9 brief: no ConfigPicker and no folder plumbing (the two
 * documents are fixed — the header just shows the agent dir and the
 * discovered read-only neighbours), and NO Upgrade dialog (pi has no
 * document migrator).
 */

export type ToastKind = "info" | "error";

/** The document currently open in the editor (brief-mandated doc-keyed shape). */
export interface CurrentDoc {
  doc: DocId;
  path: string;
  text: string;
  sha256: string;
  issues: Issue[];
  /** False while the server is serving the seed for a not-yet-created file. */
  exists: boolean;
}

/**
 * Applies a successful save to the open document — but ONLY when the save's
 * `doc` still matches the document on screen. A save whose response lands
 * while the user is switching documents must not stamp its text/sha256 onto
 * the OTHER document's editor state (the disk write itself is already
 * correctly scoped by the server's per-doc staleness check).
 * Exported for unit pinning: this is the whole cross-document guard.
 */
export function applySavedToDoc(
  previous: CurrentDoc | null,
  saved: { doc: DocId; text: string; sha256: string },
): CurrentDoc | null {
  if (previous === null || previous.doc !== saved.doc) return previous;
  return { ...previous, text: saved.text, sha256: saved.sha256 };
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

type TabId = "providers" | "keys" | "raw";

const TABS: { id: TabId; label: string }[] = [
  { id: "providers", label: "Providers & Models" },
  { id: "keys", label: "API Keys" },
  { id: "raw", label: "Raw JSON" },
];

/** Which document each tab operates on (providers → models, keys → auth). */
const activeDocFor = (tab: TabId, rawDoc: DocId): DocId =>
  tab === "providers" ? "models" : tab === "keys" ? "auth" : rawDoc;

export function App() {
  const [state, setState] = useState<StatePayload | null>(null);
  const [currentDoc, setCurrentDoc] = useState<CurrentDoc | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("raw");
  // Which of the two documents the Raw tab is showing (its own switcher).
  const [rawDoc, setRawDoc] = useState<DocId>("models");
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  // Bumped every time a config payload is applied from disk (switch/reload).
  // The editor re-seeds on THIS counter, not on text identity, so a reload
  // whose text happens to equal what we hold still resets the textarea.
  const [loadNonce, setLoadNonce] = useState(0);
  // Unsaved structured edits will live in each structured tab's state (Tasks
  // 10/12); a tab switch (remount) discards them, so App confirms first while
  // these are true (keyed to the tab currently on screen). The Raw JSON
  // textarea's draft follows the same rule — it dies on tab/document switch.
  const [providersDirty, setProvidersDirty] = useState(false);
  const [keysDirty, setKeysDirty] = useState(false);
  const [rawDirty, setRawDirty] = useState(false);
  const toastId = useRef(0);
  // Sequence guard for document loads (the state effect's cancelled-flag
  // pattern for a callback): only the latest load may apply.
  const loadSeq = useRef(0);

  const activeDoc = activeDocFor(tab, rawDoc);

  const addToast = useCallback((message: string, kind: ToastKind = "info") => {
    const id = (toastId.current += 1);
    setToasts((previous) => [...previous, { id, message, kind }]);
    setTimeout(() => {
      setToasts((previous) => previous.filter((toast) => toast.id !== id));
    }, 5000);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((previous) => previous.filter((toast) => toast.id !== id));
  }, []);

  // Server state is folder-free: one fetch on boot is all there is (the
  // agent dir never changes under a running server).
  useEffect(() => {
    let cancelled = false;
    void getState()
      .then((payload) => {
        if (cancelled) return;
        setState(payload);
        stateRef.current = payload;
      })
      .catch((err: unknown) => {
        if (!cancelled) addToast(`Could not load server state: ${errorMessage(err)}`, "error");
      });
    return () => {
      cancelled = true;
    };
  }, [addToast]);

  // Mirror of `state` for load callbacks: `/api/config` carries no path (the
  // server addresses docs by id), so the path shown in the editor comes from
  // `/api/state`'s doc list — which may still be in flight when a config
  // load lands, hence the `<id>.json` placeholder plus the patch effect.
  const stateRef = useRef<StatePayload | null>(null);
  const pathForDoc = (doc: DocId): string =>
    stateRef.current?.docs.find((entry) => entry.id === doc)?.path ?? `${doc}.json`;

  useEffect(() => {
    if (state === null) return;
    setCurrentDoc((previous) => {
      if (previous === null) return previous;
      const found = state.docs.find((entry) => entry.id === previous.doc);
      return found === undefined || found.path === previous.path
        ? previous
        : { ...previous, path: found.path };
    });
  }, [state]);

  const loadDoc = useCallback(async (doc: DocId) => {
    const seq = (loadSeq.current += 1);
    try {
      const payload = await getConfig(doc);
      // A newer load superseded this response: drop it so out-of-order
      // replies can never open a stale document.
      if (loadSeq.current !== seq) return;
      setCurrentDoc({ doc, path: pathForDoc(doc), ...payload });
      setLoadNonce((nonce) => nonce + 1);
      setLoadError(null);
    } catch (err: unknown) {
      if (loadSeq.current !== seq) return;
      setCurrentDoc(null);
      setLoadError(`Could not open ${doc}.json: ${errorMessage(err)}`);
    }
    // pathForDoc reads only the ref; no reactive deps (the patch effect above
    // updates the path when /api/state lands after a config load).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // (Re)load whenever the tab's target document changes.
  useEffect(() => {
    void loadDoc(activeDoc);
  }, [activeDoc, loadDoc]);

  const reloadCurrentDoc = useCallback(() => {
    if (currentDoc !== null) void loadDoc(currentDoc.doc);
  }, [currentDoc, loadDoc]);

  // A successful save means the disk holds exactly the saved text for THAT
  // document: sync both the editor-seed text and the staleness token, but
  // only while that document is still the open one (see applySavedToDoc).
  const handleSaved = useCallback(
    (doc: DocId, text: string, sha256: string, backupPath: string) => {
      setCurrentDoc((previous) => applySavedToDoc(previous, { doc, text, sha256 }));
      addToast(backupPath === "" ? "Saved. (File created — nothing to back up.)" : `Saved. Backup: ${backupPath}`);
    },
    [addToast],
  );

  // Label of the tab whose unsaved draft would be destroyed by switching
  // away, or null. Only the CURRENTLY VISIBLE tab can meaningfully be dirty:
  // the other flags are stale remnants of already-discarded drafts, and each
  // tab re-reports its true state on remount (all tabs report via onDirty).
  const dirtyLabel =
    currentDoc === null
      ? null
      : tab === "providers" && providersDirty
        ? "Providers & Models"
        : tab === "keys" && keysDirty
          ? "API Keys"
          : tab === "raw" && rawDirty
            ? "Raw JSON"
            : null;

  const confirmDiscardDraft = (action: string): boolean =>
    dirtyLabel === null || window.confirm(`Discard the unsaved ${dirtyLabel} changes and ${action}?`);

  const switchTab = useCallback(
    (next: TabId) => {
      if (next !== tab && dirtyLabel !== null) {
        if (!window.confirm(`Discard the unsaved ${dirtyLabel} changes?`)) return;
      }
      setTab(next);
    },
    [tab, dirtyLabel],
  );

  const switchRawDoc = useCallback(
    (next: DocId) => {
      if (next === rawDoc) return;
      if (!confirmDiscardDraft(`switch to ${next}.json`)) return;
      setRawDoc(next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rawDoc, dirtyLabel],
  );

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="app-title">pi config</h1>
        <span className="provenance" title="Pi agent directory in use">
          Agent dir: {state === null ? "…" : state.agentDir}
        </span>
        <SchemaBadge state={state} onToast={addToast} />
      </header>

      <div className="other-docs-strip">
        {state === null ? (
          "…"
        ) : state.otherDocs.length === 0 ? (
          "No read-only pi config files found in the agent dir."
        ) : (
          <>
            Read-only (not edited here):{" "}
            {state.otherDocs.map((other) => (
              <span key={other.id} className="other-doc" title={other.path}>
                {other.id}.json
              </span>
            ))}
          </>
        )}
      </div>

      <nav className="tabs">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`tab${tab === entry.id ? " tab-active" : ""}`}
            onClick={() => switchTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <ValidationPanel
        issues={currentDoc?.issues ?? []}
        state={state}
        hasConfig={currentDoc !== null}
      />

      <main className="content">
        {loadError !== null && <div className="error-banner">{loadError}</div>}
        {tab === "providers" ? (
          currentDoc === null || currentDoc.doc !== "models" ? (
            <section className="placeholder">
              {loadError === null ? "Loading models.json…" : "Nothing open — see the error above."}
            </section>
          ) : (
            <ProviderList
              doc={currentDoc}
              loadNonce={loadNonce}
              onSaved={handleSaved}
              onReload={reloadCurrentDoc}
              onToast={addToast}
              onDirty={setProvidersDirty}
            />
          )
        ) : tab === "keys" ? (
          currentDoc === null || currentDoc.doc !== "auth" ? (
            <section className="placeholder">
              {loadError === null ? "Loading auth.json…" : "Nothing open — see the error above."}
            </section>
          ) : (
            <AuthKeysTab
              doc={currentDoc}
              loadNonce={loadNonce}
              onReload={reloadCurrentDoc}
              onToast={addToast}
              onDirty={setKeysDirty}
            />
          )
        ) : (
          <>
            <div className="doc-picker" role="group" aria-label="Document">
              {(["models", "auth"] as const).map((docId) => (
                <button
                  key={docId}
                  type="button"
                  className={`tab${rawDoc === docId ? " tab-active" : ""}`}
                  onClick={() => switchRawDoc(docId)}
                >
                  {docId}.json
                </button>
              ))}
            </div>
            {currentDoc === null || currentDoc.doc !== rawDoc ? (
              <section className="placeholder">
                {loadError === null ? `Loading ${rawDoc}.json…` : "Nothing open — see the error above."}
              </section>
            ) : (
              <RawJsonTab
                key={currentDoc.doc}
                doc={currentDoc}
                loadNonce={loadNonce}
                onSaved={handleSaved}
                onReload={reloadCurrentDoc}
                onToast={addToast}
                onDirty={setRawDirty}
              />
            )}
          </>
        )}
      </main>

      <Toast toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
