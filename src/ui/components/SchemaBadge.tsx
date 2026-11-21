import { useEffect, useState } from "react";

import type { StatePayload } from "../api";
import { refreshSchema } from "../api";
import type { ToastKind } from "../App";

interface SchemaBadgeProps {
  /** Server state for the agent dir (null while loading). */
  state: StatePayload | null;
  onToast: (message: string, kind?: ToastKind) => void;
}

interface RefreshOverride {
  source: string;
  fetchedAt: string;
}

/**
 * Schema provenance badge for the topbar (sister pattern): green
 * `remote (<fetchedAt>)`, amber `bundled`, or a RED degraded notice when
 * even the bundled schema is missing (`schemaFetchedAt ===
 * "bundled-missing"` → validation disabled). The refresh button re-downloads
 * the pi schema and updates the badge from the response — whose keys are
 * `source`/`fetchedAt` (the pi route's names, not the sister's
 * `schemaSource`/`schemaFetchedAt`). The detected pi version rides beside.
 */
export function SchemaBadge({ state, onToast }: SchemaBadgeProps) {
  const [override, setOverride] = useState<RefreshOverride | null>(null);
  const [busy, setBusy] = useState(false);

  // A fresh server state (refetch) supersedes any local post-refresh override.
  useEffect(() => {
    setOverride(null);
  }, [state]);

  const source = override?.source ?? state?.schemaSource;
  const fetchedAt = override?.fetchedAt ?? state?.schemaFetchedAt;

  const refresh = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await refreshSchema();
      setOverride({ source: result.source, fetchedAt: result.fetchedAt });
      onToast(`Schema refreshed: ${result.source}.`);
    } catch (err: unknown) {
      onToast(`Schema refresh failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="schema-badge">
      {state === null && override === null ? (
        <span className="provenance">…</span>
      ) : fetchedAt === "bundled-missing" ? (
        <span className="badge badge-degraded" title="Neither the remote nor the bundled schema is available">
          validation disabled — schema unavailable
        </span>
      ) : source === "remote" ? (
        <span className="badge badge-green" title="Schema downloaded from pi.dev">
          remote ({fetchedAt})
        </span>
      ) : (
        <span className="badge badge-amber" title="Shipped-with-the-app schema (stale but valid)">
          bundled
        </span>
      )}
      <button type="button" onClick={() => void refresh()} disabled={busy || state === null}>
        {busy ? "Refreshing…" : "refresh schema"}
      </button>
      <span className="provenance" title="pi CLI detected on PATH">
        pi: {state === null ? "…" : state.piVersion ?? "not found"}
      </span>
    </span>
  );
}
