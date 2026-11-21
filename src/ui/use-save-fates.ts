import { useState } from "react";

import type { Issue } from "../core/types";
import type { ConfigPayload, DocId, SaveBody, SaveResult } from "./api";
import { getConfig, saveConfig } from "./api";
import type { ToastKind } from "./App";

/**
 * The save-fates state machine shared by all three editor tabs (Task 10's
 * reviewer prescribed extracting it when a third copy started). It owns:
 * the `saving` flag, the `stale` / `new_issues` / `conflict` banner state,
 * the identical error toast, and the classic Force-save refetch round-trip.
 * Each tab keeps its own banner JSX (wording differs), its dirty tracking,
 * and its `buildBody`/`onOk` closures — so the CLASSIC save flavor
 * (stale → Reload / Force save) and the auth REBASE flavor (conflict →
 * entry-named banner, no force-save) both route through the same outcomes.
 */

export interface SaveFatesOptions {
  /** Document this tab saves: conflict-toast wording + force-save refetch. */
  doc: DocId;
  onToast: (message: string, kind?: ToastKind) => void;
  /** Reload the open document from disk (App's reloadCurrentDoc). */
  onReload: () => void;
  /**
   * A save SUCCEEDED with `body`: stamp the text / clear the edits / re-read
   * disk — the fate that differs per save flavor (see the tabs).
   */
  onOk: (
    body: SaveBody,
    outcome: { sha256: string; backupPath: string; rebased?: boolean },
  ) => void;
  /**
   * A 409 `conflict` named `entries`. The classic tabs pass their historical
   * toast + auto-reload; the API Keys tab passes nothing and renders the
   * entry names as a user-choice banner (rebase saves never auto-reload).
   */
  onConflict?: (entries: string[]) => void;
}

export interface SaveFates {
  saving: boolean;
  stale: boolean;
  /** Issues that BLOCKED the last save, or null when none blocked it. */
  blockedIssues: Issue[] | null;
  /** Provider entries named by the last 409 conflict, or null. */
  conflictEntries: string[] | null;
  /** Hide the conflict banner while keeping the pending edits. */
  clearConflict: () => void;
  /** Clear stale/blocked/conflict state (call from the loadNonce re-seed). */
  resetFates: () => void;
  /** Full save lifecycle for an already-built body (owns the saving flag). */
  runSave: (body: SaveBody) => Promise<void>;
  /**
   * Classic Force save: refetch the disk payload (fresh sha/issues) and
   * re-save the body built against it — two round-trips on purpose so the
   * write still passes the server's staleness check, validation and backup.
   */
  forceSave: (buildBody: (fresh: ConfigPayload) => SaveBody) => Promise<void>;
}

export function useSaveFates({ doc, onToast, onReload, onOk, onConflict }: SaveFatesOptions): SaveFates {
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const [blockedIssues, setBlockedIssues] = useState<Issue[] | null>(null);
  const [conflictEntries, setConflictEntries] = useState<string[] | null>(null);

  const resetFates = (): void => {
    setStale(false);
    setBlockedIssues(null);
    setConflictEntries(null);
  };

  const handle = (outcome: SaveResult, body: SaveBody): void => {
    if (outcome.ok) {
      resetFates();
      onOk(body, outcome);
      return;
    }
    switch (outcome.kind) {
      case "stale":
        setStale(true);
        setBlockedIssues(null);
        break;
      case "new_issues":
        setStale(false);
        setBlockedIssues(outcome.newIssues);
        break;
      case "conflict":
        // pi rewrote an entry the edits touch: the server-side rebase
        // refused rather than clobber it. Which fate follows (auto-reload
        // vs. user-choice banner) belongs to the tab.
        setConflictEntries(outcome.entries);
        if (onConflict !== undefined) onConflict(outcome.entries);
        break;
      case "error":
        onToast(
          `Save failed: HTTP ${outcome.status}${outcome.status === 0 ? " (server unreachable)" : ""}.`,
          "error",
        );
        break;
    }
  };

  const runSave = async (body: SaveBody): Promise<void> => {
    setSaving(true);
    try {
      handle(await saveConfig(body), body);
    } finally {
      setSaving(false);
    }
  };

  const forceSave = async (buildBody: (fresh: ConfigPayload) => SaveBody): Promise<void> => {
    setSaving(true);
    try {
      let fresh;
      try {
        fresh = await getConfig(doc);
      } catch (err: unknown) {
        onToast(`Could not refresh the file from disk: ${err instanceof Error ? err.message : String(err)}`, "error");
        return;
      }
      const body = buildBody(fresh);
      handle(await saveConfig(body), body);
    } finally {
      setSaving(false);
    }
  };

  return {
    saving,
    stale,
    blockedIssues,
    conflictEntries,
    clearConflict: () => setConflictEntries(null),
    resetFates,
    runSave,
    forceSave,
  };
}
