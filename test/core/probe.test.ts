import { describe, expect, it } from "vitest";

import {
  buildModelsUrls,
  probeModels,
} from "../../src/core/probe";

/**
 * fetchImpl fake: records the (url, headers) of every call and replies from a
 * script of handlers. Cast to `typeof fetch` because the real signature takes
 * RequestInfo/RequestInit overloads a plain fake cannot structurally satisfy.
 */
interface FetchCall {
  url: string;
  authorization: string | undefined;
}

function fetchFake(
  calls: FetchCall[],
  respond: (call: FetchCall, index: number) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const authorization =
      (init?.headers as Record<string, string> | undefined)?.["authorization"] ??
      (init?.headers as Record<string, string> | undefined)?.["Authorization"];
    const call: FetchCall = { url: String(input), authorization };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("buildModelsUrls", () => {
  it("buildModelsUrls_withoutVersionSuffix_shouldPreferV1Candidate", () => {
    expect(buildModelsUrls("http://h:8080")).toEqual([
      "http://h:8080/v1/models",
      "http://h:8080/models",
    ]);
  });

  it("buildModelsUrls_withVersionSuffixOrTrailingSlashes_shouldReturnSingleCandidate", () => {
    expect(buildModelsUrls("http://h:8080/v1")).toEqual(["http://h:8080/v1/models"]);
    expect(buildModelsUrls("http://h:8080/v1/")).toEqual(["http://h:8080/v1/models"]);
    expect(buildModelsUrls("http://h:8080/")).toEqual([
      "http://h:8080/v1/models",
      "http://h:8080/models",
    ]);
  });
});

describe("probeModels", () => {
  it("probeModels_withOpenAiStyleResponse_shouldReturnOkAndModelIds", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = fetchFake(calls, () =>
      jsonResponse({
        object: "list",
        data: [{ id: "llama-3.1-8b" }, { id: "qwen3-32b" }],
      }),
    );

    const result = await probeModels({ baseURL: "http://h:8080/v1", fetchImpl });

    expect(calls.map((c) => c.url)).toEqual(["http://h:8080/v1/models"]);
    expect(result.status).toBe("ok");
    expect(result.modelIds).toEqual(["llama-3.1-8b", "qwen3-32b"]);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("probeModels_withConnectionRefused_shouldReturnUnreachableWithinTimeoutBudget", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = fetchFake(calls, () => {
      throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:1234");
    });

    const startedAt = Date.now();
    const result = await probeModels({
      baseURL: "http://127.0.0.1:1234",
      fetchImpl,
      timeoutMs: 500,
    });
    const elapsed = Date.now() - startedAt;

    expect(result.status).toBe("unreachable");
    expect(result.modelIds).toEqual([]);
    // A dead host short-circuits on the first failure: no candidate stacking,
    // so the probe resolves well inside one timeout budget.
    expect(elapsed).toBeLessThan(500);
  });

  it("probeModels_withApiKeyAnd401_shouldReturnAuthFailedAndRedactKeyInDetail", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = fetchFake(
      calls,
      () => new Response("Invalid API key sk-secret supplied", { status: 401 }),
    );

    const result = await probeModels({
      baseURL: "http://h:8080/v1",
      apiKey: "sk-secret",
      fetchImpl,
    });

    expect(result.status).toBe("auth_failed");
    expect(result.detail).not.toContain("sk-secret");
    expect(result.detail).toContain("***");
    // Bearer attempt first, then the one keyless retry per candidate.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.authorization).toBe("Bearer sk-secret");
    expect(calls[1]?.authorization).toBeUndefined();
  });

  it("probeModels_withKeyStraddlingDetailTruncation_shouldNotLeakKeyPrefix", async () => {
    // The key sits across the truncation boundary: truncating before redacting
    // would leave a `"…padpadpadsk-sec"` prefix the exact-match scrub misses.
    // 285 padding chars + key starting at index 285: a 300-char truncation
    // without prior redaction would strand "sk-sec".
    const body = `${"pad".repeat(95)}sk-secret-squirrel${"tail".repeat(100)}`;
    const calls: FetchCall[] = [];
    const fetchImpl = fetchFake(calls, () => new Response(body, { status: 403 }));

    const result = await probeModels({
      baseURL: "http://h:8080/v1",
      apiKey: "sk-secret-squirrel",
      fetchImpl,
    });

    expect(result.status).toBe("auth_failed");
    expect(result.detail).not.toMatch(/sk-|squirrel/);
  });

  it("probeModels_withBearer401AndKeylessSuccess_shouldRetryWithoutKeyAndReturnOk", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = fetchFake(calls, (_call, index) =>
      index === 0
        ? new Response("no key for you", { status: 401 })
        : jsonResponse({ data: [{ id: "tinyllama" }] }),
    );

    const result = await probeModels({
      baseURL: "http://h:8080",
      apiKey: "sk-secret",
      fetchImpl,
    });

    expect(result.status).toBe("ok");
    expect(result.modelIds).toEqual(["tinyllama"]);
    expect(calls.map((c) => c.url)).toEqual([
      "http://h:8080/v1/models",
      "http://h:8080/v1/models",
    ]);
  });

  it("probeModels_withKeyEchoedInModelIds_shouldRedactEveryModelId", async () => {
    // A malicious/misconfigured endpoint echoing the Bearer key back as model
    // ids: no ProbeResult field — modelIds included — may contain the key.
    const calls: FetchCall[] = [];
    const fetchImpl = fetchFake(calls, () =>
      jsonResponse({
        data: [
          { id: "sk-secret-echoed" },
          { id: "pre-sk-secret-echoed-post" },
          { id: "harmless-model" },
        ],
      }),
    );

    const result = await probeModels({
      baseURL: "http://h:8080/v1",
      apiKey: "sk-secret-echoed",
      fetchImpl,
    });

    expect(result.status).toBe("ok");
    expect(result.modelIds).toEqual(["***", "pre-***-post", "harmless-model"]);
    for (const id of result.modelIds) {
      expect(id).not.toContain("sk-secret-echoed");
    }
  });

  it("probeModels_withNonOpenAiBody_shouldReturnNotCompatible", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = fetchFake(calls, () => jsonResponse({ models: ["a", "b"] }));

    const result = await probeModels({ baseURL: "http://h:8080/v1", fetchImpl });

    expect(result.status).toBe("not_compatible");
    expect(result.modelIds).toEqual([]);
  });

  it("probeModels_withFailingV1Candidate_shouldFallThroughToBareModelsCandidate", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = fetchFake(calls, (call) =>
      call.url.endsWith("/v1/models")
        ? new Response("<html>404</html>", { status: 404 })
        : jsonResponse({ data: [{ id: "phi-4" }] }),
    );

    const result = await probeModels({ baseURL: "http://h:8080", fetchImpl });

    expect(result.status).toBe("ok");
    expect(result.modelIds).toEqual(["phi-4"]);
    expect(calls.map((c) => c.url)).toEqual([
      "http://h:8080/v1/models",
      "http://h:8080/models",
    ]);
  });
});
