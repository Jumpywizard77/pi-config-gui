import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  REMOTE_SCHEMA_URL,
  loadSchema,
  validateConfigText,
  validatorFor,
  type SchemaSource,
} from "../../src/core/schema";

function readBundledSchema(): object {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL("../../src/core/schema-bundled.json", import.meta.url)), "utf8"),
  ) as object;
}

/** The vendored schema, presented as the validator sees it when `loadSchema` falls back. */
const bundledSource: SchemaSource = {
  schema: readBundledSchema(),
  source: "bundled",
  fetchedAt: "bundled",
};

function tempCacheDir(): string {
  return mkdtempSync(join(tmpdir(), "pcg-schema-"));
}

/** A minimal but representative pi `models.json`: custom provider, api, models, modelOverrides. */
const VALID_MODELS = JSON.stringify(
  {
    $schema: "https://pi.dev/schemas/models.schema.json",
    providers: {
      x: {
        name: "X Local",
        baseUrl: "http://localhost:8000/v1",
        api: "openai-completions",
        models: [{ id: "x-1", name: "X 1", contextWindow: 128000, maxTokens: 16384 }],
        modelOverrides: { "x-1": { name: "X 1 (local)", reasoning: true } },
      },
    },
  },
  null,
  2,
);

describe("core/schema", () => {
  it("vendoredSchema_shouldBeThePiModelsSchema", () => {
    expect(REMOTE_SCHEMA_URL).toBe("https://pi.dev/schemas/models.schema.json");
    expect((readBundledSchema() as { $id?: string }).$id).toBe("https://pi.dev/schemas/models.schema.json");
  });

  it("validateConfigText_withValidPiModelsSample_shouldReturnNoIssues", () => {
    // Compiles the vendored schema through the offline ladder: pi's schema is
    // self-contained (all $defs inline, zero remote $refs), so no fetch ever
    // happens inside ajv — the test would hang or fail if it did.
    expect(validateConfigText(VALID_MODELS, bundledSource)).toEqual([]);
  });

  it("validateConfigText_withModelMissingId_shouldReportIssueAtExactPath", () => {
    const doc = JSON.parse(VALID_MODELS);
    delete doc.providers.x.models[0].id;
    const issues = validateConfigText(JSON.stringify(doc, null, 2), bundledSource);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe("providers.x.models[0]");
    expect(issues[0]!.message).toContain("id");
  });

  it("loadSchema_withUnreachableRemote_shouldFallBackToBundled", async () => {
    const cacheDir = tempCacheDir();
    const result = await loadSchema({
      refresh: true,
      cacheDir,
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    expect(result.source).toBe("bundled");
    expect(result.fetchedAt).toBe("bundled");
    expect((result.schema as { $id?: string }).$id).toBe("https://pi.dev/schemas/models.schema.json");
  });

  it("loadSchema_withSuccessfulRefresh_shouldReturnRemoteAndWritePiNamedCache", async () => {
    const cacheDir = tempCacheDir();
    const schema = readBundledSchema();
    const fetchImpl = (async () => ({ ok: true, json: async () => schema })) as unknown as typeof fetch;

    const result = await loadSchema({ refresh: true, cacheDir, fetchImpl });
    expect(result.source).toBe("remote");
    expect(result.fetchedAt).not.toBe("bundled");
    expect(new Date(result.fetchedAt).toISOString()).toBe(result.fetchedAt);
    expect(result.schema).toEqual(schema);

    // pi-config-gui cache naming: models-schema.json under ~/.cache/pi-config-gui
    // (the dir is overridden here, so only the file name can be pinned).
    const cacheFile = join(cacheDir, "models-schema.json");
    expect(existsSync(cacheFile)).toBe(true);
    expect(JSON.parse(readFileSync(cacheFile, "utf8"))).toMatchObject({ schema });
  });

  it("loadSchema_withWarmCacheAndNoRefresh_shouldServeCacheWithoutFetching", async () => {
    const cacheDir = tempCacheDir();
    const schema = readBundledSchema();
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return { ok: true, json: async () => schema };
    }) as unknown as typeof fetch;

    const refreshed = await loadSchema({ refresh: true, cacheDir, fetchImpl });
    const cached = await loadSchema({ cacheDir, fetchImpl });
    expect(fetchCalls).toBe(1);
    expect(cached.source).toBe("remote");
    expect(cached.fetchedAt).toBe(refreshed.fetchedAt);
  });

  it("loadSchema_withMissingBundledFile_shouldFallBackToPermissiveSchemaWithoutThrowing", async () => {
    // Last rung of the ladder: a packaged copy that is absent (e.g. dist/
    // packaging forgot the JSON) must degrade to a permissive `{}` schema,
    // never throw. The degraded provenance keeps `source: 'bundled'` but a
    // distinct `fetchedAt` sentinel, so a `{}` validator can never masquerade
    // as the real vendored copy in the fetchedAt-keyed validator cache.
    const cacheDir = tempCacheDir();
    const result = await loadSchema({
      refresh: true,
      cacheDir,
      fetchImpl: async () => {
        throw new Error("network down");
      },
      bundledPath: join(cacheDir, "absent-bundled-copy.json"),
    });
    expect(result.source).toBe("bundled");
    expect(result.fetchedAt).toBe("bundled-missing");
    expect(result.schema).toEqual({});

    // Documented degradation: validation against `{}` becomes a permissive
    // no-op rather than an error.
    expect(validateConfigText(JSON.stringify({ bogus_root: 1, nonsense: [1, 2] }), result)).toEqual([]);
  });

  it("loadSchema_withCorruptCacheFile_shouldFallBackToBundled", async () => {
    const cacheDir = tempCacheDir();
    writeFileSync(join(cacheDir, "models-schema.json"), "{not json");
    const result = await loadSchema({
      refresh: true,
      cacheDir,
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    expect(result.source).toBe("bundled");
    expect(result.fetchedAt).toBe("bundled");
    expect((result.schema as { $id?: string }).$id).toBe("https://pi.dev/schemas/models.schema.json");
  });

  it("loadSchema_withNonOkHttpResponse_shouldFallBackToCacheOrBundled", async () => {
    const cacheDir = tempCacheDir();
    const notFound = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;

    // Cold cache: a 404 walks all the way down to the bundled copy.
    const cold = await loadSchema({ refresh: true, cacheDir, fetchImpl: notFound });
    expect(cold.source).toBe("bundled");

    // Warm cache: after one good refresh, a failing refresh serves the cache.
    const schema = readBundledSchema();
    const ok = (async () => ({ ok: true, json: async () => schema })) as unknown as typeof fetch;
    const warmed = await loadSchema({ refresh: true, cacheDir, fetchImpl: ok });
    const stale = await loadSchema({ refresh: true, cacheDir, fetchImpl: notFound });
    expect(stale.source).toBe("remote");
    expect(stale.fetchedAt).toBe(warmed.fetchedAt);
  });

  it("validatorFor_shouldRoutePerDocument", () => {
    const missingIdDoc = JSON.stringify(
      { providers: { x: { api: "openai-completions", models: [{ name: "no id" }] } } },
      null,
      2,
    );

    // "models" → the ajv ladder validator.
    const models = validatorFor("models", bundledSource);
    expect(models(VALID_MODELS)).toEqual([]);
    expect(models(missingIdDoc).some((issue) => issue.path === "providers.x.models[0]")).toBe(true);

    // "auth" → the hand-rolled permissive validator, schema-independent.
    const auth = validatorFor("auth", bundledSource);
    expect(auth(JSON.stringify({ anthropic: { type: "api_key", key: "sk-x" } }))).toEqual([]);
    const authIssues = auth(JSON.stringify({ p: { type: "api_key" } }));
    expect(authIssues.some((issue) => issue.path === "p.key")).toBe(true);

    // The `other` documents are listed read-only and never validated.
    for (const docId of ["settings", "mcp", "keybindings"] as const) {
      expect(validatorFor(docId, bundledSource)("{ this is not even json ]")).toEqual([]);
    }
  });
});
