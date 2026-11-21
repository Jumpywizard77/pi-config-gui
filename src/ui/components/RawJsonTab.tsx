import { useEffect, useState } from "react";

import { useSaveFates } from "../use-save-fates";
import type { DocId } from "../api";
import type { CurrentDoc, ToastKind } from "../App";

interface RawJsonTabProps {
  /** The document open on screen (doc id, path, text, staleness base). */
  doc: CurrentDoc;
  /** Bumped by App on every disk load (switch/reload) — the re-seed trigger. */
  loadNonce: number;
  onSaved: (doc: DocId, text: string, sha256: string, backupPath: string) => void;
  onReload: () => void;
  onToast: (message: string, kind?: ToastKind) => void;
  /** Reports unsaved textarea text so App can confirm on tab/document switch. */
  onDirty: (dirty: boolean) => void;
}

/**
 * Raw JSONC editor for ONE pi document (the App's doc switcher remounts this
 * component per document). The staleness contract follows the sister app:
 * every save sends the sha256 and issues of the text we LOADED (the base),
 * never whatever we think the disk holds. A 409 `stale` offers Reload (drop
 * edits) or Force save (fetch the fresh disk sha, then save THIS editor text
 * against it — still server-validated and backed up, never a blind
 * overwrite). `new_issues` lists the blocking problems and refuses; the
 * edits stay in the textarea.
 *
 * This tab is the CLASSIC save flavor (no structured `edits`), so a `conflict`
 * outcome cannot normally occur — but the save-fates state machine lives in
 * the shared `useSaveFates` hook (Task 12 extraction), so a conflict still
 * reloads the document and toasts the entry names ("pi changed … in
 * auth.json — reloaded") exactly as before.
 */
export function RawJsonTab({ doc, loadNonce, onSaved, onReload, onToast, onDirty }: RawJsonTabProps) {
  const [text, setText] = useState(doc.text);
  const { saving, stale, blockedIssues, resetFates, runSave, forceSave } = useSaveFates({
    doc: doc.doc,
    onToast,
    onReload,
    onOk: (body, outcome) => onSaved(body.doc, body.text, outcome.sha256, outcome.backupPath),
    onConflict: (entries) => {
      // pi rewrote an entry we were about to touch: drop the local view and
      // re-read — the server-side rebase refused rather than clobber it.
      // (Cannot fire on this tab's classic saves; it is the shared routing.)
      onToast(`pi changed ${entries.join(", ")} in ${doc.doc}.json — reloaded`, "error");
      onReload();
    },
  });

  // Re-seed on the LOAD NONCE (a disk payload was just applied by App), never
  // on text identity: a reload whose text happens to equal what `doc`
  // already holds MUST still reset the textarea and clear the stale/blocked
  // banners. A plain save does NOT bump the nonce — it only syncs
  // doc.text/sha256 — so edits typed during the save round-trip survive.
  // Document switches also remount via App's `key`; effects run on mount.
  useEffect(() => {
    setText(doc.text);
    resetFates();
    // doc.text is read fresh from the render the nonce bumped in; the
    // nonce is the only intended trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadNonce]);

  // Draft = the textarea differs from the last text seeded from disk (or
  // confirmed by a save). Reported up to App on every change: this draft
  // dies on a tab/document switch, so App confirms those first.
  const dirty = text !== doc.text;
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);

  const save = async () => {
    await runSave({ doc: doc.doc, text, baseSha256: doc.sha256, baseIssues: doc.issues });
  };

  return (
    <section className="raw-tab">
      <div className="raw-path" title={doc.path}>
        {doc.path}
        {dirty && <span className="dirty-marker"> unsaved</span>}
      </div>

      {!doc.exists && (
        <div className="hint">
          This file does not exist yet — the editor shows the documented seed; the first save
          creates the file{doc.doc === "auth" ? " (mode 0600 on POSIX)" : ""}.
        </div>
      )}

      {stale && (
        <div className="stale-banner">
          The file changed on disk since you loaded it — your edits are not lost.{" "}
          <button type="button" onClick={onReload} disabled={saving}>
            Reload
          </button>{" "}
          <button
            type="button"
            onClick={() =>
              void forceSave((fresh) => ({
                doc: doc.doc,
                text,
                baseSha256: fresh.sha256,
                baseIssues: fresh.issues,
              }))
            }
            disabled={saving || !dirty}
          >
            Force save
          </button>{" "}
          <span className="hint">(Force save overwrites the disk copy with your editor text — it is
          still validated and backed up.)</span>
        </div>
      )}

      {blockedIssues !== null && (
        <div className="issues-banner">
          <div>Save refused — your edit introduces new validation errors:</div>
          <ul>
            {blockedIssues.map((issue, index) => (
              <li key={`${issue.path}|${issue.message}|${index}`}>
                <code>{issue.path || "(document)"}</code>: {issue.message}
              </li>
            ))}
          </ul>
          <div className="hint">Fix them above; your edits are kept in the editor.</div>
        </div>
      )}

      <textarea
        className="json-editor"
        spellCheck={false}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />

      <div className="raw-actions">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !dirty}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onReload} disabled={saving}>
          Reload from disk
        </button>
        <span className="sha-hint" title="SHA-256 of the last text loaded from or saved to disk">
          {doc.sha256.slice(0, 12)}…
        </span>
      </div>
    </section>
  );
}
