import { useEffect, useRef, useState } from "react";

import { classifyKey } from "../../core/keyref";
import type { JsonValue, PathEdit } from "../../core/types";
import type { ToastKind } from "../App";
import { probe, type ProbeApiResponse } from "../api";
import { envRefName, escapeLiteralDollar } from "../provider-logic";
import { JsonField } from "./JsonField";
import { ModelSections } from "./ModelSections";

type Obj = { [k: string]: JsonValue };

/** The documented `api` families (schema description) + the codex variant. */
const API_FAMILIES = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "openai-codex-responses",
];

function isObj(value: JsonValue | undefined): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStr(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
}

interface ProviderEditorProps {
  entryId: string;
  /** The provider's current parsed object (re-derived after every edit). */
  entry: Obj;
  /** Key-path: `["providers", id]`. */
  path: (string | number)[];
  /** Other provider ids (rename collision checks). */
  otherIds: string[];
  apply: (edits: PathEdit[]) => void;
  onToast: (message: string, kind?: ToastKind) => void;
  /** After a committed ID rename, so the parent can move the selection. */
  onRenamed: (newId: string) => void;
  /**
   * Preset-dialog handoff: run ONE probe for this baseUrl when the editor
   * mounts (the caller gates on `isLocalhostUrl` — never auto-hit a remote).
   */
  autoProbeBaseUrl?: string;
}

/**
 * Structured editor for one `models.json` provider (pi shape: the fields live
 * directly on the entry — name/baseUrl/api/apiKey/headers/authHeader/compat).
 * Rename = delete-old + create-new edit pair (sister pattern).
 *
 * apiKey forms (core/keyref): `!command` renders READ-ONLY (pi EXECUTES it at
 * runtime; this GUI never does) with a one-off [paste key to test] field that
 * feeds `probe` only — it is never applied to the document. Literal and
 * `$NAME` values are masked inputs; the [$ENV]/[unwrap] helpers convert the
 * whole value between `$NAME` and its `$$`-escaped literal.
 */
export function ProviderEditor({
  entryId,
  entry,
  path,
  otherIds,
  apply,
  onToast,
  onRenamed,
  autoProbeBaseUrl,
}: ProviderEditorProps) {
  const [idDraft, setIdDraft] = useState(entryId);
  const [revealed, setRevealed] = useState(false);
  const [pasteKey, setPasteKey] = useState("");
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<ProbeApiResponse | null>(null);

  const apiKeyValue = typeof entry["apiKey"] === "string" ? (entry["apiKey"] as string) : "";
  const keyForm = apiKeyValue === "" ? null : classifyKey(apiKeyValue);
  const baseUrl = asStr(entry["baseUrl"]);

  const setField = (key: string, value: JsonValue | undefined): void => {
    apply([{ path: [...path, key], value }]);
  };

  const commitRename = (): void => {
    const next = idDraft.trim();
    if (next === "" || otherIds.includes(next)) {
      setIdDraft(entryId);
      return;
    }
    if (next === entryId) return;
    apply([
      { path, value: undefined },
      { path: [...path.slice(0, -1), next], value: entry },
    ]);
    onRenamed(next);
  };

  const runProbe = async (apiKey: string | undefined): Promise<void> => {
    if (baseUrl === "") {
      onToast("Set a baseUrl before probing.", "error");
      return;
    }
    setProbing(true);
    try {
      setProbeResult(await probe({ baseUrl, ...(apiKey === undefined || apiKey === "" ? {} : { apiKey }) }));
    } catch (err: unknown) {
      setProbeResult({
        status: "unreachable",
        modelIds: [],
        detail: err instanceof Error ? err.message : String(err),
        latencyMs: 0,
      });
    } finally {
      setProbing(false);
    }
  };

  // Preset-dialog auto-probe (localhost URLs only — gated by the caller).
  const autoProbed = useRef(false);
  useEffect(() => {
    if (autoProbeBaseUrl !== undefined && !autoProbed.current) {
      autoProbed.current = true;
      void runProbe(undefined);
    }
    // Mount-only by design: the editor is keyed by provider id upstream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoProbeBaseUrl]);

  return (
    <div className="provider-editor">
      <div className="field-grid">
        <label>
          <span className="field-label">ID (rename = delete + re-create)</span>
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
        <label>
          <span className="field-label">Display name</span>
          <input
            type="text"
            spellCheck={false}
            value={asStr(entry["name"])}
            onChange={(event) => setField("name", event.target.value === "" ? undefined : event.target.value)}
          />
        </label>
      </div>

      <div className="field-grid">
        <label>
          <span className="field-label">baseUrl</span>
          <input
            type="text"
            spellCheck={false}
            value={baseUrl}
            onChange={(event) => setField("baseUrl", event.target.value === "" ? undefined : event.target.value)}
          />
        </label>
        <label>
          <span className="field-label">api</span>
          <input
            type="text"
            spellCheck={false}
            list="pi-api-families"
            value={asStr(entry["api"])}
            onChange={(event) => setField("api", event.target.value === "" ? undefined : event.target.value)}
          />
          <datalist id="pi-api-families">
            {API_FAMILIES.map((family) => (
              <option key={family} value={family} />
            ))}
          </datalist>
        </label>
      </div>

      <div className="api-key-block">
        <span className="field-label">apiKey</span>
        {keyForm === "command" ? (
          <>
            <div className="warning-banner">
              Stored as a <code>!command</code> — pi runs it at runtime to fetch the key. This GUI
              never executes it, so the key is hidden here.
            </div>
            <div className="api-key-row">
              <input
                type="password"
                spellCheck={false}
                placeholder="paste a key to test this endpoint once (not saved)"
                value={pasteKey}
                onChange={(event) => setPasteKey(event.target.value)}
              />
              <button
                type="button"
                disabled={probing || pasteKey === ""}
                onClick={() => void runProbe(pasteKey)}
              >
                {probing ? "probing…" : "probe with pasted key"}
              </button>
            </div>
          </>
        ) : (
          <div className="api-key-row">
            <input
              type={revealed ? "text" : "password"}
              spellCheck={false}
              value={apiKeyValue}
              onChange={(event) => setField("apiKey", event.target.value === "" ? undefined : event.target.value)}
            />
            <button type="button" onClick={() => setRevealed((shown) => !shown)}>
              {revealed ? "hide" : "show"}
            </button>
            <button
              type="button"
              title="Store the key as an environment reference: $NAME"
              onClick={() => {
                const answer = window.prompt("Environment variable name to store the key as ($NAME):");
                if (answer === null) return;
                const name = answer.trim();
                if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
                  onToast("Not a valid environment variable name.", "error");
                  return;
                }
                setField("apiKey", `$${name}`);
              }}
            >
              {"$ENV"}
            </button>
            <button
              type="button"
              disabled={keyForm !== "env" || envRefName(apiKeyValue) === null}
              title="Rewrite this $NAME reference as its own literal ($$NAME-escaped) value"
              onClick={() => setField("apiKey", escapeLiteralDollar(apiKeyValue))}
            >
              unwrap
            </button>
            <button type="button" disabled={probing || baseUrl === ""} onClick={() => void runProbe(apiKeyValue)}>
              {probing ? "probing…" : "probe"}
            </button>
          </div>
        )}
        {keyForm === "env" && (
          <div className="hint">
            <code>${envRefName(apiKeyValue) ?? "…"}</code> — the server resolves this from its own
            environment when probing.
          </div>
        )}
        {probeResult !== null && (
          <div className={`probe-status probe-${probeResult.status}`}>
            <span className="probe-chip">{probeResult.status}</span>
            <span className="probe-latency">{probeResult.latencyMs} ms</span>
            <span className="probe-detail">
              {probeResult.status === "ok"
                ? `${probeResult.modelIds.length} model(s)`
                : probeResult.detail}
            </span>
            {probeResult.warning !== undefined && (
              <span className="probe-detail">
                warning: env key(s) not set on the server: {probeResult.warning.names.join(", ")}
              </span>
            )}
          </div>
        )}
      </div>

      <HeaderRows headers={isObj(entry["headers"]) ? (entry["headers"] as Obj) : undefined} path={path} apply={apply} />

      <div className="bool-row">
        <label className="bool">
          <input
            type="checkbox"
            checked={entry["authHeader"] === true}
            onChange={(event) => setField("authHeader", event.target.checked ? true : undefined)}
          />
          authHeader — send the key as Authorization: Bearer
        </label>
      </div>

      <JsonField
        label="compat (JSON)"
        value={entry["compat"]}
        onChange={(next) => setField("compat", next)}
        deleteWhenUndefined
      />

      <ModelSections
        providerId={entryId}
        models={entry["models"]}
        overrides={entry["modelOverrides"]}
        onEdits={apply}
      />
    </div>
  );
}

function HeaderRows({
  headers,
  path,
  apply,
}: {
  headers: Obj | undefined;
  path: (string | number)[];
  apply: (edits: PathEdit[]) => void;
}) {
  const entries: [string, string][] = Object.entries(headers ?? {}).map(
    ([key, value]) => [key, asStr(value)] as [string, string],
  );
  // Key edits rewrite the whole object (dropping empty-key rows); value edits
  // are path-addressed (sister pattern). Clearing the last row deletes the
  // `headers` key instead of writing `headers: {}` debris.
  const rewrite = (next: [string, string][]): void => {
    const cleaned = next.filter(([key]) => key !== "");
    const value: Obj = {};
    for (const [key, headerValue] of cleaned) value[key] = headerValue;
    apply([{ path: [...path, "headers"], value: cleaned.length === 0 ? undefined : value }]);
  };
  const replace = (index: number, next: [string, string]): void => {
    rewrite(entries.map((entry, i) => (i === index ? next : entry)));
  };
  return (
    <div className="kv-block">
      <span className="field-label">headers</span>
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
            onChange={(event) => apply([{ path: [...path, "headers", key], value: event.target.value }])}
          />
          <button type="button" onClick={() => rewrite(entries.filter((_, i) => i !== index))}>
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={entries.some(([key]) => key === "")}
        onClick={() => apply([{ path: [...path, "headers", ""], value: "" }])}
      >
        + header
      </button>
    </div>
  );
}
