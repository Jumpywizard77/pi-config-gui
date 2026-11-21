import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getConfig,
  getState,
  probe,
  refreshSchema,
  saveConfig,
} from "../../src/ui/api";

/**
 * Unit tests for the pi fork's UI HTTP client (`src/ui/api.ts`) with
 * `globalThis.fetch` stubbed: no server is booted. They pin (a) URL/body
 * building (doc-keyed, NO `?folder=` anywhere — the sister's folder plumbing
 * is gone) and (b) the HTTP-status → discriminated-union mapping:
 * `saveConfig`'s 409→stale / 400→new_issues / 409-with-entries→conflict /
 * other→error, and `probe`'s body passthrough + `warning` surfacing.
 *
 * The bare-payload calls (`getState`/`getConfig`/`refreshSchema`/`probe`)
 * THROW on non-OK responses or transport failure — the brief's signatures
 * return the payload itself, so there is no error channel besides exceptions.
 */

interface FetchCall {
  url: string;
  init: RequestInit;
}

interface StubResponse {
  status: number;
  body: unknown;
}

/** Records every call; every response is `body` serialized as JSON. */
function stubFetch(calls: FetchCall[], respond: (call: FetchCall) => StubResponse): void {
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: FetchCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    const { status, body } = respond(call);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  vi.stubGlobal("fetch", fetchImpl as unknown as typeof fetch);
}

function networkFailFetch(): void {
  const fetchImpl = (): Promise<Response> => Promise.reject(new Error("boom"));
  vi.stubGlobal("fetch", fetchImpl as unknown as typeof fetch);
}

const query = (params: Record<string, string>): string =>
  new URLSearchParams(params).toString();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("saveConfig", () => {
  it("POSTs exactly {doc, text, baseSha256, baseIssues} and maps 200 to {ok:true,…}", async () => {
    const calls: FetchCall[] = [];
    stubFetch(calls, () => ({ status: 200, body: { sha256: "new-sha", backupPath: "p.bak-x" } }));

    const result = await saveConfig({
      doc: "models",
      text: '{"a":1}',
      baseSha256: "base-sha",
      baseIssues: [{ path: "providers.x", message: "pre-existing warning" }],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/config/save");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      doc: "models",
      text: '{"a":1}',
      baseSha256: "base-sha",
      baseIssues: [{ path: "providers.x", message: "pre-existing warning" }],
    });
    expect(result).toEqual({ ok: true, sha256: "new-sha", backupPath: "p.bak-x" });
  });

  it("carries `rebased: true` through on a rebase-save 200", async () => {
    const calls: FetchCall[] = [];
    stubFetch(calls, () => ({
      status: 200,
      body: { sha256: "s", backupPath: "b", rebased: true },
    }));

    const result = await saveConfig({ doc: "auth", text: "{}", baseSha256: "b", baseIssues: [] });
    expect(result).toEqual({ ok: true, sha256: "s", backupPath: "b", rebased: true });
  });

  it("passes `edits` and `baseText` through in the body when supplied (structured auth save)", async () => {
    const calls: FetchCall[] = [];
    stubFetch(calls, () => ({ status: 200, body: { sha256: "s", backupPath: "b", rebased: true } }));

    const edits = [{ path: ["tokenflow"], value: { type: "api_key", key: "sk-test" } }];
    await saveConfig({
      doc: "auth",
      text: "",
      baseSha256: "b",
      baseIssues: [],
      edits,
      baseText: '{ "tokenflow": { "type": "api_key", "key": "sk-old" } }',
    });

    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.doc).toBe("auth");
    expect(body.edits).toEqual(edits);
    expect(body.baseText).toBe('{ "tokenflow": { "type": "api_key", "key": "sk-old" } }');
  });

  it("maps 409 {error:'stale', diskSha256} to {ok:false, kind:'stale', diskSha256}", async () => {
    const calls: FetchCall[] = [];
    stubFetch(calls, () => ({ status: 409, body: { error: "stale", diskSha256: "disk-sha" } }));

    const result = await saveConfig({ doc: "models", text: "t", baseSha256: "stale-base", baseIssues: [] });
    expect(result).toEqual({ ok: false, kind: "stale", diskSha256: "disk-sha" });
  });

  it("maps 409 {error:'conflict', entries} to {ok:false, kind:'conflict', entries}", async () => {
    const calls: FetchCall[] = [];
    stubFetch(calls, () => ({
      status: 409,
      body: { error: "conflict", entries: ["tokenflow", "anthropic"] },
    }));

    const result = await saveConfig({ doc: "auth", text: "", baseSha256: "b", baseIssues: [] });
    expect(result).toEqual({ ok: false, kind: "conflict", entries: ["tokenflow", "anthropic"] });
  });

  it("maps 400 {error:'new_issues', newIssues} to {ok:false, kind:'new_issues', newIssues}", async () => {
    const calls: FetchCall[] = [];
    const newIssues = [{ path: "providers", message: "must be an object" }];
    stubFetch(calls, () => ({ status: 400, body: { error: "new_issues", newIssues } }));

    const result = await saveConfig({ doc: "models", text: "t", baseSha256: "base", baseIssues: [] });
    expect(result).toEqual({ ok: false, kind: "new_issues", newIssues });
  });

  it("maps other error statuses to {ok:false, kind:'error', status}", async () => {
    const calls: FetchCall[] = [];
    stubFetch(calls, () => ({ status: 403, body: { error: "read_only_doc" } }));

    const result = await saveConfig({ doc: "models", text: "t", baseSha256: "base", baseIssues: [] });
    expect(result).toEqual({ ok: false, kind: "error", status: 403 });
  });

  it("maps a rejected fetch (network failure) to kind 'error' with status 0", async () => {
    networkFailFetch();
    const result = await saveConfig({ doc: "models", text: "t", baseSha256: "base", baseIssues: [] });
    expect(result).toEqual({ ok: false, kind: "error", status: 0 });
  });
});

describe("getState", () => {
  it("GETs /api/state and splits wire docs into docs + otherDocs", async () => {
    const wireBody = {
      agentDir: "C:/Users/tlree/.pi/agent",
      docs: [
        { id: "models", path: "C:/pi/agent/models.json", kind: "models", editable: true, exists: true },
        { id: "auth", path: "C:/pi/agent/auth.json", kind: "auth", editable: true, exists: false },
        { id: "settings", path: "C:/pi/agent/settings.json", kind: "other", editable: false, exists: true },
        { id: "mcp", path: "C:/pi/agent/mcp.json", kind: "other", editable: false, exists: true },
      ],
      piVersion: "0.45.3",
      schemaSource: "remote",
      schemaFetchedAt: "2026-11-19T00:00:00.000Z",
    };
    const calls: FetchCall[] = [];
    stubFetch(calls, () => ({ status: 200, body: wireBody }));

    const result = await getState();
    expect(calls[0]!.url).toBe("/api/state");
    expect(calls[0]!.init.method ?? "GET").toBe("GET");
    expect(result).toEqual({
      agentDir: "C:/Users/tlree/.pi/agent",
      docs: [
        { id: "models", path: "C:/pi/agent/models.json", exists: true, editable: true },
        { id: "auth", path: "C:/pi/agent/auth.json", exists: false, editable: true },
      ],
      otherDocs: [
        { id: "settings", path: "C:/pi/agent/settings.json" },
        { id: "mcp", path: "C:/pi/agent/mcp.json" },
      ],
      piVersion: "0.45.3",
      schemaSource: "remote",
      schemaFetchedAt: "2026-11-19T00:00:00.000Z",
    });
  });

  it("throws on a non-OK response (message carries the status)", async () => {
    const calls: FetchCall[] = [];
    stubFetch(calls, () => ({ status: 500, body: { error: "internal_error" } }));
    await expect(getState()).rejects.toThrow(/500/);
  });
});

describe("getConfig", () => {
  it("GETs /api/config?doc= and passes the {text, sha256, issues, exists} payload through", async () => {
    const payload = { text: "{}\n", sha256: "abc", issues: [], exists: false };
    const calls: FetchCall[] = [];
    stubFetch(calls, () => ({ status: 200, body: payload }));

    const result = await getConfig("auth");
    expect(calls[0]!.url).toBe(`/api/config?${query({ doc: "auth" })}`);
    expect(result).toEqual(payload);
  });

  it("throws on error responses (e.g. 400 bad_doc)", async () => {
    const calls: FetchCall[] = [];
    stubFetch(calls, () => ({ status: 400, body: { error: "bad_doc" } }));
    await expect(getConfig("models")).rejects.toThrow(/400|bad_doc/);
  });
});

describe("refreshSchema", () => {
  it("POSTs /api/schema/refresh and returns the pi-keyed {source, fetchedAt}", async () => {
    const payload = { source: "remote", fetchedAt: "2026-11-19T00:00:00.000Z" };
    const calls: FetchCall[] = [];
    stubFetch(calls, () => ({ status: 200, body: payload }));

    const result = await refreshSchema();
    expect(calls[0]!.url).toBe("/api/schema/refresh");
    expect(calls[0]!.init.method).toBe("POST");
    expect(result).toEqual(payload);
  });
});

describe("probe", () => {
  it("POSTs {baseUrl} and omits apiKey unless supplied", async () => {
    const payload = { status: "ok", modelIds: ["gpt"], detail: "", latencyMs: 5 };
    const calls: FetchCall[] = [];
    stubFetch(calls, () => ({ status: 200, body: payload }));

    await probe({ baseUrl: "http://127.0.0.1:9/v1" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ baseUrl: "http://127.0.0.1:9/v1" });

    await probe({ baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-test" });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "sk-test",
    });
  });

  it("surfaces the optional env_key_unresolved warning when present", async () => {
    const payload = {
      status: "unreachable",
      modelIds: [],
      detail: "no answer",
      latencyMs: 12,
      warning: { kind: "env_key_unresolved", names: ["LM_API_KEY"] },
    };
    const calls: FetchCall[] = [];
    stubFetch(calls, () => ({ status: 200, body: payload }));

    const result = await probe({ baseUrl: "http://127.0.0.1:9/v1", apiKey: "$LM_API_KEY" });
    expect(result.warning).toEqual({ kind: "env_key_unresolved", names: ["LM_API_KEY"] });
  });

  it("omits `warning` when the server did not flag one", async () => {
    const calls: FetchCall[] = [];
    stubFetch(calls, () => ({
      status: 200,
      body: { status: "ok", modelIds: [], detail: "", latencyMs: 1 },
    }));

    const result = await probe({ baseUrl: "http://127.0.0.1:9/v1" });
    expect("warning" in result).toBe(false);
  });

  it("throws on 400 {error:'command_key'} (message carries the error code)", async () => {
    const calls: FetchCall[] = [];
    stubFetch(calls, () => ({ status: 400, body: { error: "command_key" } }));
    await expect(probe({ baseUrl: "http://x", apiKey: "!opencode auth print" })).rejects.toThrow(
      /command_key/,
    );
  });
});
