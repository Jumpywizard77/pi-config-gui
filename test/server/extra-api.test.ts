import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createExtraApiHandlers, type ExtraApiDeps } from "../../src/server/extra-api";
import { createServer } from "../../src/server/server";

/**
 * Integration tests for Task 7's extra routes (`POST /api/probe`,
 * `POST /api/schema/refresh`) over real HTTP, adapted from the sister app's
 * extra-api.test.ts (the upgrade routes are opencode-only and absent here).
 *
 * Hermeticity: the server boots `createServer` on 127.0.0.1:0 with ONLY the
 * extra route table; probe networking is intercepted by stubbing the global
 * `fetch` (which `probeModels` resolves at call time), and schema refresh
 * networking goes through the injected `loadSchemaOptions.fetchImpl` pinned
 * to a private cacheDir. Nothing here touches the network.
 *
 * Review Focus 3 pins: a `!command` apiKey is refused pre-network (the fetch
 * recorder must show ZERO calls); an unresolvable `$NAME` probes KEYLESS with
 * the `env_key_unresolved` warning and the `$NAME` text never reaches a
 * request; refresh reports `source:"remote"` on a stubbed fetch.
 */

// Real fetch, captured BEFORE any vi.stubGlobal, so the test CLIENT keeps
// talking to the loopback server while the probe hits the stub.
const clientFetch = globalThis.fetch.bind(globalThis);

const failFetch = (async () => {
  throw new Error("offline test: server tests must not touch the network");
}) as unknown as typeof fetch;

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
}

/** Global-fetch stub: records every probe request and answers via `respond`. */
function installFetchStub(respond: () => Response): RecordedRequest[] {
  const calls: RecordedRequest[] = [];
  vi.stubGlobal(
    "fetch",
    (async (input: unknown, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      if (init?.headers) {
        for (const [name, value] of Object.entries(init.headers as Record<string, string>)) {
          headers[name.toLowerCase()] = value;
        }
      }
      calls.push({ url: String(input), headers });
      return respond();
    }) as unknown as typeof fetch,
  );
  return calls;
}

const modelListResponse = () =>
  new Response(JSON.stringify({ data: [{ id: "alpha-model" }, { id: "beta-model" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

interface Harness {
  server: http.Server;
  base: string;
  dir: string;
}

const harnesses: Harness[] = [];

function boot(deps: ExtraApiDeps = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "pcg-xapi-"));
  const full: ExtraApiDeps = {
    env: {}, // never inherit a real developer environment into key resolution
    loadSchemaOptions: { cacheDir: join(dir, "schema-cache"), fetchImpl: failFetch },
    ...deps,
  };
  const server = createServer(createExtraApiHandlers(full));
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      const harness: Harness = { server, base: `http://127.0.0.1:${port}`, dir };
      harnesses.push(harness);
      done(harness);
    });
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  while (harnesses.length > 0) {
    const harness = harnesses.pop()!;
    harness.server.closeAllConnections();
    await new Promise<void>((done) => harness.server.close(() => done()));
    try {
      rmSync(harness.dir, { recursive: true, force: true });
    } catch {
      // Windows may briefly hold a handle; temp dirs are disposable.
    }
  }
});

interface CallResponse {
  status: number;
  body: any;
}

async function call(harness: Harness, method: string, path: string, body?: unknown): Promise<CallResponse> {
  const res = await clientFetch(harness.base + path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? null : JSON.parse(text) };
}

/** Every header value of every recorded request, concatenated. */
function allHeaders(calls: RecordedRequest[]): string {
  return calls.map((c) => Object.entries(c.headers).map(([k, v]) => `${k}=${v}`).join(" ")).join(" | ");
}

describe("server/extra-api", () => {
  describe("POST /api/probe", () => {
    it("probe_withLiteralKey_shouldSendBearerAndPassThroughModelIds", async () => {
      const harness = await boot();
      const calls = installFetchStub(modelListResponse);

      const got = await call(harness, "POST", "/api/probe", {
        baseUrl: "https://api.example.test/v1",
        apiKey: "sk-secret-do-not-echo",
      });
      expect(got.status).toBe(200);
      expect(got.body.status).toBe("ok");
      expect(got.body.modelIds).toEqual(["alpha-model", "beta-model"]);
      expect(got.body.warning).toBeUndefined();
      expect(calls.map((c) => c.url)).toEqual(["https://api.example.test/v1/models"]);
      expect(calls[0]!.headers.authorization).toBe("Bearer sk-secret-do-not-echo");
      // The apiKey never appears anywhere in the response.
      expect(JSON.stringify(got.body)).not.toContain("sk-secret-do-not-echo");
    });

    it("probe_withCommandKey_shouldReturn400CommandKeyAndZeroFetchCalls", async () => {
      const harness = await boot();
      const calls = installFetchStub(modelListResponse);

      const got = await call(harness, "POST", "/api/probe", {
        baseUrl: "https://api.example.test/v1",
        apiKey: "!printenv MY_SECRET | base64",
      });
      expect(got.status).toBe(400);
      expect(got.body.error).toBe("command_key");
      // Review Focus 3: refused PRE-network — nothing was ever requested.
      expect(calls).toEqual([]);
      // The command string is never echoed back.
      expect(JSON.stringify(got.body)).not.toContain("printenv");
    });

    it("probe_withUnresolvedEnvKey_shouldProbeKeylessAndFlagWarning", async () => {
      const harness = await boot({ env: {} }); // $MISSING_PI_KEY is absent
      const calls = installFetchStub(modelListResponse);

      const got = await call(harness, "POST", "/api/probe", {
        baseUrl: "https://api.example.test/v1",
        apiKey: "$MISSING_PI_KEY",
      });
      expect(got.status).toBe(200);
      expect(got.body.status).toBe("ok");
      expect(got.body.modelIds).toEqual(["alpha-model", "beta-model"]);
      expect(got.body.warning).toEqual({ kind: "env_key_unresolved", names: ["MISSING_PI_KEY"] });
      // Keyless: no Authorization header anywhere, and the $NAME text was
      // never sent as a key (or anywhere else).
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) {
        expect(c.headers.authorization).toBeUndefined();
      }
      expect(allHeaders(calls)).not.toContain("MISSING_PI_KEY");
      expect(JSON.stringify(got.body)).not.toContain("Bearer $");
    });

    it("probe_withResolvableEnvKey_shouldSendResolvedValueAsBearer", async () => {
      const harness = await boot({ env: { PI_TEST_KEY: "sk-from-env" } });
      const calls = installFetchStub(modelListResponse);

      const got = await call(harness, "POST", "/api/probe", {
        baseUrl: "https://api.example.test/v1",
        apiKey: "${PI_TEST_KEY}",
      });
      expect(got.status).toBe(200);
      expect(got.body.status).toBe("ok");
      expect(got.body.warning).toBeUndefined();
      expect(calls[0]!.headers.authorization).toBe("Bearer sk-from-env");
      expect(JSON.stringify(got.body)).not.toContain("sk-from-env");
    });

    it("probe_withMissingBaseUrl_shouldReturn400BadRequestWithoutFetching", async () => {
      const harness = await boot();
      const calls = installFetchStub(modelListResponse);

      const got = await call(harness, "POST", "/api/probe", { apiKey: "sk-x" });
      expect(got.status).toBe(400);
      expect(got.body.error).toBe("bad_request");
      expect(calls).toEqual([]);
    });

    it("probe_withNonStringApiKeyOrGarbageBody_shouldReturn400", async () => {
      const harness = await boot();
      installFetchStub(modelListResponse);

      const badKey = await call(harness, "POST", "/api/probe", {
        baseUrl: "https://api.example.test/v1",
        apiKey: 42,
      });
      expect(badKey.status).toBe(400);
      expect(badKey.body.error).toBe("bad_request");

      const garbage = await clientFetch(harness.base + "/api/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      });
      expect(garbage.status).toBe(400);
    });

    it("probe_apiRequest_withForeignOrigin_shouldReturn403", async () => {
      const harness = await boot();
      const res = await clientFetch(harness.base + "/api/probe", {
        method: "POST",
        headers: { origin: "http://evil.example", "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://api.example.test/v1" }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe("POST /api/schema/refresh", () => {
    it("schemaRefresh_withStubbedFetch_shouldReportRemoteSource", async () => {
      const schemaFetch = (async () =>
        new Response(JSON.stringify({ type: "object", properties: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;
      const dir = mkdtempSync(join(tmpdir(), "pcg-xapi-cache-"));
      try {
        const harness = await boot({
          loadSchemaOptions: { cacheDir: join(dir, "schema-cache"), fetchImpl: schemaFetch },
        });
        const got = await call(harness, "POST", "/api/schema/refresh", {});
        expect(got.status).toBe(200);
        expect(got.body.source).toBe("remote");
        expect(Date.parse(got.body.fetchedAt as string)).toBeGreaterThan(0);
      } finally {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // temp dir, disposable
        }
      }
    });

    it("schemaRefresh_withFailingFetch_shouldDegradeToBundled", async () => {
      const harness = await boot(); // boot default: failFetch + private cacheDir
      const got = await call(harness, "POST", "/api/schema/refresh", {});
      expect(got.status).toBe(200);
      expect(got.body.source).toBe("bundled");
      expect(got.body.fetchedAt).toBe("bundled");
    });

    it("upgradeRoutes_shouldNotExist_onPi", async () => {
      const harness = await boot();
      for (const path of ["/api/upgrade/preview", "/api/upgrade/apply"]) {
        const got = await call(harness, "POST", path, {});
        expect(got.status, path).toBe(404);
        expect(got.body.error, path).toBe("unknown_route");
      }
    });
  });

  it("probe_fetchFailure_shouldReturnUnreachableStatus", async () => {
    const harness = await boot();
    vi.stubGlobal(
      "fetch",
      (async () => {
        throw new Error("ECONNREFUSED api.example.test");
      }) as unknown as typeof fetch,
    );
    const got = await call(harness, "POST", "/api/probe", {
      baseUrl: "https://api.example.test/v1",
      apiKey: "sk-secret-do-not-echo",
    });
    expect(got.status).toBe(200);
    expect(got.body.status).toBe("unreachable");
    expect(got.body.detail).not.toContain("sk-secret-do-not-echo");
  });
});
