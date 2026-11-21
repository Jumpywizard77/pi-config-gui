import { useState } from "react";

import { classifyKey } from "../../core/keyref";
import type { JsonValue, PathEdit } from "../../core/types";
import { probe, type ProbeApiResponse } from "../api";
import type { ToastKind } from "../App";
import {
  addModelEdits,
  addOverrideEdits,
  deleteModelEdits,
  envKeyWarningText,
  isCommandKeyRejection,
  mergeImportEdits,
  modelEditorKeys,
  planImportRows,
  renameModelEdits,
  renameOverrideEdits,
  setOverrideFieldEdits,
  type ImportRow,
} from "../model-logic";
import { ModelEditor } from "./ModelEditor";

type Obj = { [k: string]: JsonValue };

function isObj(value: JsonValue | undefined): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Task 11 mount point wired up: the provider editor's `models` (ARRAY of
 * `{ id, … }` entries) + `modelOverrides` (map) sections, and the hero-flow
 * import dialog. All edits ride the same pending-`PathEdit[]` contract as the
 * provider fields; the parent re-derives the entry after every apply.
 */
export interface ModelSectionsProps {
  providerId: string;
  /** The provider's `models` ARRAY (pi's shape), or undefined when absent. */
  models: JsonValue | undefined;
  /** The provider's `modelOverrides` map, or undefined when absent. */
  overrides: JsonValue | undefined;
  /** The provider's baseUrl/apiKey — what the import dialog probes. */
  baseUrl: string;
  apiKey: string;
  onEdits: (edits: PathEdit[]) => void;
  onToast: (message: string, kind?: ToastKind) => void;
}

export function ModelSections({
  providerId,
  models,
  overrides,
  baseUrl,
  apiKey,
  onEdits,
  onToast,
}: ModelSectionsProps) {
  const [newModelId, setNewModelId] = useState("");
  const [newOverrideId, setNewOverrideId] = useState("");
  /** UI-only (spec settled-item 2): rows imported this session, never stored. */
  const [reviewIds, setReviewIds] = useState<Set<string>>(new Set());

  const modelsBroken = models !== undefined && !Array.isArray(models);
  const modelList: JsonValue[] = Array.isArray(models) ? models : [];
  // Index-aligned: non-object/malformed entries hold their slot as "".
  const modelIdsAligned = modelList.map((m) => (isObj(m) && typeof m["id"] === "string" ? m["id"] : ""));
  const modelIds = modelIdsAligned.filter((id) => id !== "");
  // ENTRY-stable React keys (id-aware): survives a rename's index shift so an
  // editor's keyDraft can never be inherited by a different entry.
  const modelKeys = modelEditorKeys(modelList);
  const overridesBroken = overrides !== undefined && !isObj(overrides);
  const overrideEntries: [string, Obj][] = isObj(overrides)
    ? Object.entries(overrides).flatMap(([key, value]) => (isObj(value) ? [[key, value] as [string, Obj]] : []))
    : [];
  const overrideKeys = overrideEntries.map(([key]) => key);

  const addModel = (): void => {
    const id = newModelId.trim();
    if (id === "" || modelIds.includes(id)) return;
    onEdits(addModelEdits(providerId, id));
    setNewModelId("");
  };

  const addOverride = (): void => {
    const id = newOverrideId.trim();
    if (id === "" || overrideKeys.includes(id)) return;
    onEdits(addOverrideEdits(providerId, id));
    setNewOverrideId("");
  };

  return (
    <div className="model-sections">
      <div className="model-section-head">
        <span className="field-label">models ({modelList.length})</span>
      </div>

      <ImportDialog
        providerId={providerId}
        baseUrl={baseUrl}
        apiKey={apiKey}
        existingIds={modelIds}
        onEdits={onEdits}
        onToast={onToast}
        onImported={(ids) => setReviewIds((previous) => new Set([...previous, ...ids]))}
      />

      {modelsBroken && (
        <div className="warning-banner">
          <code>providers.{providerId}.models</code> is not an array in the file — its entries
          cannot be listed or edited here; use the Raw JSON tab.
        </div>
      )}

      {modelList.map((model, index) =>
        isObj(model) ? (
          <div className="model-card" key={modelKeys[index]}>
            <ModelEditor
              entry={model}
              entryPath={["providers", providerId, "models", index]}
              variant="model"
              entryKey={typeof model["id"] === "string" ? model["id"] : String(index)}
              siblingKeys={modelIdsAligned.filter((id, i) => i !== index && id !== "")}
              reviewLimits={reviewIds.has(typeof model["id"] === "string" ? model["id"] : "")}
              onRename={(newId) => onEdits(renameModelEdits(providerId, index, model, newId))}
              onDelete={() => {
                const label = typeof model["id"] === "string" ? model["id"] : `entry #${index}`;
                if (window.confirm(`Delete model "${label}" from this provider?`)) {
                  onEdits(deleteModelEdits(providerId, index));
                }
              }}
              apply={onEdits}
            />
          </div>
        ) : (
          <div className="model-card" key={modelKeys[index]}>
            <div className="warning-banner">
              models[{index}] is not an object ({JSON.stringify(model)}) — edit it in the Raw JSON
              tab.
            </div>
            <button
              type="button"
              onClick={() => {
                if (window.confirm(`Delete malformed models[${index}]?`)) {
                  onEdits(deleteModelEdits(providerId, index));
                }
              }}
            >
              delete entry
            </button>
          </div>
        ),
      )}
      {modelList.length === 0 && !modelsBroken && <div className="hint">no models listed yet</div>}

      <div className="model-add">
        <input
          type="text"
          spellCheck={false}
          placeholder="new model id"
          value={newModelId}
          onChange={(event) => setNewModelId(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") addModel();
          }}
        />
        <button type="button" disabled={newModelId.trim() === "" || modelIds.includes(newModelId.trim())} onClick={addModel}>
          + model
        </button>
      </div>

      <div className="model-section-head">
        <span className="field-label">modelOverrides ({overrideKeys.length})</span>
        <span className="hint">per-model overrides for pi&rsquo;s built-in models — unknown ids are ignored by pi</span>
      </div>

      {overridesBroken && (
        <div className="warning-banner">
          <code>providers.{providerId}.modelOverrides</code> is not an object in the file — edit it
          in the Raw JSON tab.
        </div>
      )}

      {overrideEntries.map(([key, value]) => (
        <div className="model-card" key={key}>
          <ModelEditor
            entry={value}
            entryPath={["providers", providerId, "modelOverrides", key]}
            variant="override"
            entryKey={key}
            siblingKeys={overrideKeys.filter((k) => k !== key)}
            onRename={(newId) => onEdits(renameOverrideEdits(providerId, key, value, newId))}
            onDelete={() => {
              if (window.confirm(`Delete the override for "${key}"?`)) {
                onEdits(setOverrideFieldEdits(providerId, key, "", undefined));
              }
            }}
            apply={onEdits}
          />
        </div>
      ))}

      <div className="model-add">
        <input
          type="text"
          spellCheck={false}
          placeholder="model id to override"
          list={`pi-override-ids-${providerId}`}
          value={newOverrideId}
          onChange={(event) => setNewOverrideId(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") addOverride();
          }}
        />
        <datalist id={`pi-override-ids-${providerId}`}>
          {modelIds.filter((id) => id !== "").map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
        <button
          type="button"
          disabled={newOverrideId.trim() === "" || overrideKeys.includes(newOverrideId.trim())}
          onClick={addOverride}
        >
          + override
        </button>
      </div>
    </div>
  );
}

interface ImportDialogProps {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  existingIds: string[];
  onEdits: (edits: PathEdit[]) => void;
  onToast: (message: string, kind?: ToastKind) => void;
  onImported: (ids: string[]) => void;
}

/**
 * The hero flow's review: [Probe] runs the SERVER's probe (`api.probe`,
 * key policy owned there — a stored `!command` key is refused pre-network and
 * surfaces as the "resolve the key" notice; the paste field below is offered
 * for that case and is never applied to the document). Successful results
 * open a checkbox review list: unseen ids pre-checked, ids already in the
 * file disabled + "already configured"; Import emits `mergeImportEdits`
 * (merge by id, NEVER overwrites) and badges the new rows "review limits"
 * (UI state only).
 */
function ImportDialog({ providerId, baseUrl, apiKey, existingIds, onEdits, onToast, onImported }: ImportDialogProps) {
  const [probing, setProbing] = useState(false);
  const [result, setResult] = useState<ProbeApiResponse | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pasteKey, setPasteKey] = useState("");

  const keyIsCommand = apiKey !== "" && classifyKey(apiKey) === "command";

  const run = async (): Promise<void> => {
    setProbing(true);
    setResult(null);
    setNotice(null);
    setRows(null);
    try {
      const key = keyIsCommand && pasteKey !== "" ? pasteKey : apiKey === "" ? undefined : apiKey;
      const outcome = await probe({ baseUrl, ...(key === undefined ? {} : { apiKey: key }) });
      setResult(outcome);
      if (outcome.status === "ok") {
        const planned = planImportRows(outcome.modelIds, existingIds);
        setRows(planned);
        setSelected(new Set(planned.filter((row) => row.checked).map((row) => row.id)));
      }
    } catch (err: unknown) {
      if (isCommandKeyRejection(err)) {
        setNotice(
          "apiKey is stored as a !command — resolve the key to test (paste a key below, or store it as a literal/$NAME in the field above).",
        );
      } else {
        onToast(`Probe request failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    } finally {
      setProbing(false);
    }
  };

  const toggle = (id: string): void => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const importPicked = (): void => {
    if (rows === null) return;
    // Endpoint order preserved; mergeImportEdits re-guards against existing ids.
    const picked = rows.filter((row) => selected.has(row.id)).map((row) => row.id);
    const edits = mergeImportEdits(providerId, existingIds, picked);
    if (edits.length === 0) return;
    onEdits(edits);
    onImported(edits.map((edit) => (edit.value as { id: string }).id));
    setRows(null);
    setResult(null);
    setPasteKey("");
    onToast(
      `Imported ${edits.length} model(s) with default limits (128000 / 16384) — review them and Save.`,
    );
  };

  return (
    <div className="endpoint-panel model-import">
      <div className="endpoint-actions">
        <button type="button" disabled={probing || baseUrl === ""} onClick={() => void run()}>
          {probing ? "probing…" : "Probe"}
        </button>
        <span className="hint">
          {baseUrl === "" ? "set a baseUrl first" : `check ${baseUrl} and import what it serves`}
        </span>
      </div>

      {keyIsCommand && (
        <>
          <div className="warning-banner">
            Stored apiKey is a <code>!command</code> — the server never runs it, so probing needs a
            key you paste here once (never saved).
          </div>
          <div className="api-key-row">
            <input
              type="password"
              spellCheck={false}
              placeholder="paste a key to test this endpoint once (not saved)"
              value={pasteKey}
              onChange={(event) => setPasteKey(event.target.value)}
            />
          </div>
        </>
      )}

      {notice !== null && <div className="warning-banner">{notice}</div>}

      {result !== null && (
        <div className={`probe-status probe-${result.status}`}>
          <span className="probe-chip">{result.status}</span>
          <span className="probe-latency">{result.latencyMs} ms</span>
          <span className="probe-detail">
            {result.status === "ok" ? `${result.modelIds.length} model(s)` : result.detail}
          </span>
          {envKeyWarningText(result.warning) !== null && (
            <span className="probe-detail">{envKeyWarningText(result.warning)}</span>
          )}
        </div>
      )}

      {rows !== null && rows.length > 0 && (
        <div className="probe-models">
          <div className="probe-models-head">
            {rows.length} model(s) at the endpoint — already-configured ids are never overwritten:
          </div>
          <ul>
            {rows.map((row) => (
              <li key={row.id}>
                <label>
                  <input
                    type="checkbox"
                    disabled={row.alreadyPresent}
                    checked={selected.has(row.id)}
                    onChange={() => toggle(row.id)}
                  />{" "}
                  <code>{row.id}</code>
                  {row.alreadyPresent && (
                    <span className="shape-badge import-already">already configured</span>
                  )}
                </label>
              </li>
            ))}
          </ul>
          <button type="button" disabled={selected.size === 0} onClick={importPicked}>
            Import {selected.size} model(s)
          </button>
          {selected.size === 0 && (
            <span className="hint">nothing new to import — everything at this endpoint is already configured.</span>
          )}
        </div>
      )}
      {rows !== null && rows.length === 0 && <div className="hint">The endpoint serves no models.</div>}
    </div>
  );
}
