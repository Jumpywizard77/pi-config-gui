import { useCallback, useEffect, useMemo, useState } from "react";

import { parseJsonc } from "../../core/jsonc";
import { BUILTIN_PROVIDER_IDS } from "../../core/builtins";
import { LOCAL_PRESETS, type LocalPreset } from "../../core/presets";
import type { JsonValue, PathEdit } from "../../core/types";
import type { CurrentDoc, ToastKind } from "../App";
import type { DocId } from "../api";
import { editInText } from "../editor-path";
import { addProviderEdits, isLocalhostUrl, parseProviders } from "../provider-logic";
import { useSaveFates } from "../use-save-fates";
import { ProviderEditor } from "./ProviderEditor";

type Obj = { [k: string]: JsonValue };

function isObj(value: JsonValue | undefined): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ProviderListProps {
  /** The open `models` document (App guarantees the doc before mounting). */
  doc: CurrentDoc;
  /** Bumped by App on every disk load — the re-seed trigger (as in RawJsonTab). */
  loadNonce: number;
  onSaved: (doc: DocId, text: string, sha256: string, backupPath: string) => void;
  onReload: () => void;
  onToast: (message: string, kind?: ToastKind) => void;
  /** Reports unsaved structured edits so App can confirm on tab switch. */
  onDirty: (dirty: boolean) => void;
}

/**
 * The Providers & Models tab. Holds a LIST OF PENDING `PathEdit[]` (sister
 * architecture): the displayed doc is `editInText(doc.text, edits)` recomputed
 * per edit, and Save compiles the edits to full text client-side and sends it
 * CLASSIC-style (models.json has no rebase path — the staleness base is
 * always the currently-loaded doc's sha). Stale / new_issues handling lives
 * in the shared `useSaveFates` hook (Task 12 extraction) and mirrors
 * RawJsonTab. Switching tabs discards pending edits (React remount) — App
 * confirms via onDirty.
 */
export function ProviderList({ doc, loadNonce, onSaved, onReload, onToast, onDirty }: ProviderListProps) {
  const [edits, setEdits] = useState<PathEdit[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [newProviderId, setNewProviderId] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  /** Preset-dialog handoff: probe this baseUrl once when its editor mounts. */
  const [autoProbe, setAutoProbe] = useState<{ id: string; baseUrl: string } | null>(null);
  const { saving, stale, blockedIssues, resetFates, runSave, forceSave } = useSaveFates({
    doc: "models",
    onToast,
    onReload,
    onOk: (body, outcome) => {
      onSaved("models", body.text, outcome.sha256, outcome.backupPath);
      setEdits([]);
    },
    onConflict: (entries) => {
      // Cannot normally occur on classic saves; the shared union covers it.
      onToast(`pi changed ${entries.join(", ")} in models.json — reloaded`, "error");
      onReload();
    },
  });

  useEffect(() => {
    setEdits([]);
    setSelected(null);
    setNewProviderId("");
    setDialogOpen(false);
    setAutoProbe(null);
    resetFates();
  }, [loadNonce]);

  const dirty = edits.length > 0;
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);

  // Parse guard: applyPathEdits REFUSES malformed JSONC, so with hard parse
  // issues the structured tab is disabled until the Raw tab fixes them.
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
  const views = derivedDoc === undefined ? [] : parseProviders(derivedDoc);
  const rawProviders =
    derivedDoc !== undefined && isObj(derivedDoc) && isObj(derivedDoc["providers"])
      ? (derivedDoc["providers"] as Obj)
      : {};
  const selectedView = views.find((view) => view.id === selected);
  const selectedRaw = selected === undefined || selected === null ? undefined : rawProviders[selected];

  const apply = useCallback((newEdits: PathEdit[]) => {
    setEdits((previous) => [...previous, ...newEdits]);
  }, []);

  const save = async (): Promise<void> => {
    if (derived === null) return;
    await runSave({ doc: "models", text: derived, baseSha256: doc.sha256, baseIssues: doc.issues });
  };

  if (parseBroken) {
    return (
      <section className="provider-list-tab">
        <div className="error-banner">
          models.json has parse errors — fix them in the Raw JSON tab first; structured editing is
          disabled while the document does not parse.
        </div>
      </section>
    );
  }

  return (
    <section className="provider-list-tab">
      {derivedError !== null && <div className="error-banner">{derivedError}</div>}

      {!doc.exists && (
        <div className="hint">
          models.json does not exist yet — the editor shows the documented seed; the first save
          creates the file.
        </div>
      )}

      {stale && (
        <div className="stale-banner">
          The file changed on disk since you loaded it — your pending edits are not lost.{" "}
          <button type="button" onClick={onReload} disabled={saving}>
            Reload
          </button>{" "}
          <button
            type="button"
            onClick={() =>
              void forceSave((fresh) => ({
                doc: "models",
                text: derived ?? "",
                baseSha256: fresh.sha256,
                baseIssues: fresh.issues,
              }))
            }
            disabled={saving || !dirty || derived === null}
          >
            Force save
          </button>{" "}
          <span className="hint">(Force save overwrites the disk copy with your edited text — it is
          still validated and backed up.)</span>
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
          <div className="provider-list-head">Providers ({views.length})</div>
          {views.map((view) => (
            <div
              key={view.id}
              className={`provider-row${selected === view.id ? " provider-row-active" : ""}`}
            >
              <button
                type="button"
                title={[view.name, view.baseUrl].filter(Boolean).join(" — ") || view.id}
                onClick={() => {
                  setSelected(view.id);
                  setAutoProbe(null);
                }}
              >
                {view.id}
              </button>
              {view.builtinReroute && (
                <span className="shape-badge" title="reroutes a pi built-in provider">
                  built-in
                </span>
              )}
              {view.shapeError === true && (
                <span className="shape-badge" title="not an object in the file — read-only here">
                  raw only
                </span>
              )}
              <span className="provider-row-counts" title="models / modelOverrides">
                {view.modelCount}/{view.overrideCount}
              </span>
            </div>
          ))}
          {views.length === 0 && <div className="hint">no providers yet</div>}
          <div className="provider-add">
            <input
              type="text"
              spellCheck={false}
              placeholder="new provider id"
              value={newProviderId}
              onChange={(event) => setNewProviderId(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addFree();
              }}
            />
            <button type="button" onClick={addFree} disabled={newProviderId.trim() === ""}>
              + add
            </button>
          </div>
          <button type="button" className="preset-dialog-open" onClick={() => setDialogOpen(true)}>
            Add local endpoint…
          </button>
        </div>

        <div className="provider-detail">
          {selectedView === undefined ? (
            <div className="hint">Select a provider to edit it, add one, or use “Add local endpoint…”.</div>
          ) : selectedView.shapeError === true ? (
            <>
              <div className="provider-detail-head">
                <span className="field-label">providers.{selectedView.id}</span>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`Delete provider "${selectedView!.id}"?`)) {
                      apply([{ path: ["providers", selectedView!.id], value: undefined }]);
                      setSelected(null);
                    }
                  }}
                >
                  delete provider
                </button>
              </div>
              <div className="warning-banner">
                This entry is not an object in the file — it is shown read-only; edit it in the Raw
                JSON tab.
              </div>
            </>
          ) : (
            <>
              <div className="provider-detail-head">
                <span className="field-label">providers.{selectedView.id}</span>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`Delete provider "${selectedView.id}" and all its models?`)) {
                      apply([{ path: ["providers", selectedView.id], value: undefined }]);
                      setSelected(null);
                    }
                  }}
                >
                  delete provider
                </button>
              </div>
              <ProviderEditor
                key={selectedView.id}
                entryId={selectedView.id}
                entry={isObj(selectedRaw) ? selectedRaw : {}}
                path={["providers", selectedView.id]}
                otherIds={views.filter((view) => view.id !== selectedView.id).map((view) => view.id)}
                apply={apply}
                onToast={onToast}
                onRenamed={(newId) => {
                  setSelected(newId);
                  setAutoProbe(null);
                }}
                autoProbeBaseUrl={autoProbe !== null && autoProbe.id === selectedView.id ? autoProbe.baseUrl : undefined}
              />
            </>
          )}
        </div>
      </div>

      {dialogOpen && (
        <PresetDialog
          existingIds={views.map((view) => view.id)}
          onClose={() => setDialogOpen(false)}
          onCreate={(id, preset) => {
            apply(addProviderEdits(id, preset));
            setDialogOpen(false);
            setSelected(id);
            if (preset !== null && isLocalhostUrl(preset.baseUrl)) {
              setAutoProbe({ id, baseUrl: preset.baseUrl });
            } else {
              setAutoProbe(null);
            }
          }}
        />
      )}

      <div className="raw-actions">
        <button type="button" onClick={() => void save()} disabled={saving || !dirty || derived === null}>
          {saving ? "Saving…" : `Save${dirty ? ` (${pendingTouches(edits)})` : ""}`}
        </button>
        <button type="button" onClick={onReload} disabled={saving}>
          Reload from disk
        </button>
        {dirty && <span className="dirty-marker">unsaved provider changes</span>}
      </div>
    </section>
  );

  function addFree(): void {
    const id = newProviderId.trim();
    if (id === "" || views.some((view) => view.id === id)) return;
    apply(addProviderEdits(id, null));
    setNewProviderId("");
    setSelected(id);
    setAutoProbe(null);
  }
}

function pendingTouches(edits: PathEdit[]): string {
  return `${edits.length} edit${edits.length === 1 ? "" : "s"}`;
}

/**
 * “Add local endpoint…”: radio list over LOCAL_PRESETS (+ a blank option),
 * provider id free text with a datalist of built-ins and preset ids. On
 * create the caller applies `addProviderEdits` and opens the editor — with a
 * one-off auto-probe when the preset's baseUrl is loopback.
 */
function PresetDialog({
  existingIds,
  onClose,
  onCreate,
}: {
  existingIds: string[];
  onClose: () => void;
  onCreate: (id: string, preset: LocalPreset | null) => void;
}) {
  const BLANK = "";
  const [presetId, setPresetId] = useState<string>(LOCAL_PRESETS[0]!.id);
  const [providerId, setProviderId] = useState<string>(
    LOCAL_PRESETS[0]!.id === "ollama" && existingIds.includes("ollama") ? "" : LOCAL_PRESETS[0]!.id,
  );

  const preset = LOCAL_PRESETS.find((candidate) => candidate.id === presetId) ?? null;
  const id = providerId.trim();
  const taken = id !== "" && existingIds.includes(id);
  const suggested = [...new Set([...LOCAL_PRESETS.map((entry) => entry.id), ...BUILTIN_PROVIDER_IDS])];

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <h2>Add local endpoint</h2>
        <div className="preset-options">
          {LOCAL_PRESETS.map((entry) => (
            <label key={entry.id} className="preset-option">
              <input
                type="radio"
                name="pi-preset"
                checked={presetId === entry.id}
                onChange={() => {
                  // Re-prefill the id only while it still mirrors a preset id.
                  if (providerId.trim() === "" || LOCAL_PRESETS.some((p) => p.id === providerId.trim())) {
                    setProviderId(existingIds.includes(entry.id) ? "" : entry.id);
                  }
                  setPresetId(entry.id);
                }}
              />
              <span>{entry.label}</span>
              <span className="hint">{entry.baseUrl === "" ? "(fill baseUrl yourself)" : entry.baseUrl}</span>
            </label>
          ))}
          <label className="preset-option">
            <input
              type="radio"
              name="pi-preset"
              checked={presetId === BLANK}
              onChange={() => {
                if (providerId.trim() === "" || LOCAL_PRESETS.some((p) => p.id === providerId.trim())) {
                  setProviderId("");
                }
                setPresetId(BLANK);
              }}
            />
            <span>Blank provider</span>
            <span className="hint">empty entry — fill everything yourself</span>
          </label>
        </div>
        <label>
          <span className="field-label">Provider id</span>
          <input
            type="text"
            spellCheck={false}
            list="pi-provider-ids"
            value={providerId}
            onChange={(event) => setProviderId(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && id !== "" && !taken) onCreate(id, preset);
            }}
          />
          <datalist id="pi-provider-ids">
            {suggested.map((suggestion) => (
              <option key={suggestion} value={suggestion} />
            ))}
          </datalist>
          {taken && <div className="field-error">A provider with that id already exists.</div>}
        </label>
        {preset !== null && preset.apiKey !== "" && (
          <div className="hint">
            The preset stores placeholder key <code>{preset.apiKey}</code> in models.json — local
            servers ignore it unless started with an explicit key.
          </div>
        )}
        {preset !== null && isLocalhostUrl(preset.baseUrl) && (
          <div className="hint">baseUrl is loopback — the endpoint will be probed once after creation.</div>
        )}
        <div className="raw-actions">
          <button type="button" disabled={id === "" || taken} onClick={() => onCreate(id, preset)}>
            Create provider
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
