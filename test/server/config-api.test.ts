import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  createConfigApiHandlers,
  seedText,
  vetDoc,
  type ConfigApiDeps,
} from "../../src/server/config-api";
import { sha256 } from "../../src/server/http";
import { createServer } from "../../src/server/server";

/**
 * Integration tests over real HTTP (global fetch + real node:fs on mkdtemp
 * dirs) plus one raw `node:http` request for the Host/Origin checks, mirroring
 * the sister app's harness. The server boots `createServer` on 127.0.0.1:0.
 *
 * Hermeticity: `platform`/`env`/`agentDir` are injected so discovery never
 * touches the developer's real `~/.pi/agent`; the schema load is pinned to the
 * bundled fallback (failing fetch + private cacheDir) and the pi version probe
 * to a failing execFileImpl, so no network or child processes happen here.
 *
 * Scope note: the auth rebase-save behavior (conflict detection, byte-stable
 * untouched entries, SaveRebased response) is Task 5's test surface. These
 * tests pin only that auth saves WITHOUT `edits` take the classic path.
 */

const failFetch = (async () => {
  throw new Error("offline test: server tests must not touch the network");
}) as unknown as typeof fetch;

const failExec = (): Promise<{ stdout: string }> =>
  Promise.reject(new Error("offline test: no pi binary may run"));

/** Seed contents pinned verbatim per the task brief (and re-checked via seedText()). */
const SEED_MODELS = `{\n  "$schema": "https://pi.dev/schemas/models.schema.json",\n  "providers": {}\n}\n`;
const SEED_AUTH = "{}\n";

/**
 * Review-Focus 2 fixture: pi-era `models.json` with `//` and block comments
 * plus trailing commas — valid JSONC, so it must read AND save with every
 * comment and comma alive.
 */
const COMMENTED_MODELS = `{
  // pi keeps this comment alive; so must the GUI.
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": {
    /* block comment too */
    "x": {
      "name": "X Local",
      "baseUrl": "http://localhost:8000/v1",
      "api": "openai-completions",
      "models": [
        {
          "id": "x-1",
          "contextWindow": 128000, // hand-chosen limit
          "maxTokens": 16384,
        },
      ],
    },
  },
}
`;

/** Schema-clean models document used by the save-pipeline tests. */
const VALID_MODELS = JSON.stringify(
  {
    $schema: "https://pi.dev/schemas/models.schema.json",
    providers: {
      x: {
        name: "X Local",
        baseUrl: "http://localhost:8000/v1",
        api: "openai-completions",
        models: [{ id: "x-1", contextWindow: 128000, maxTokens: 16384 }],
      },
    },
  },
  null,
  2,
) + "\n";

interface Harness {
  server: http.Server;
  base: string;
  /** The mkdtemp root; `agentDir` lives inside it. */
  dir: string;
  /** The injected agent dir (real node:fs, no discovery fake needed). */
  agentDir: string;
  modelsPath: string;
  authPath: string;
}

const harnesses: Harness[] = [];

/** Shared injected deps for direct vetDoc calls (no server booted). */
function baseDeps(agentDir: string): ConfigApiDeps {
  return { platform: process.platform, env: {}, agentDir };
}

function boot(overrides: Partial<ConfigApiDeps> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "pcg-srv-"));
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });

  const deps: ConfigApiDeps = {
    platform: process.platform,
    env: {}, // never inherit a real PI_CODING_AGENT_DIR / HOME
    agentDir,
    loadSchemaOptions: { cacheDir: join(dir, "schema-cache"), fetchImpl: failFetch },
    execFileImpl: failExec,
    ...overrides,
  };

  const server = createServer(createConfigApiHandlers(deps));
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      const harness: Harness = {
        server,
        base: `http://127.0.0.1:${port}`,
        dir,
        agentDir,
        modelsPath: join(agentDir, "models.json"),
        authPath: join(agentDir, "auth.json"),
      };
      harnesses.push(harness);
      done(harness);
    });
  });
}

afterEach(async () => {
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

function query(params: Record<string, string>): string {
  return `?${Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&")}`;
}

interface Response {
  status: number;
  body: any;
  headers: Headers;
}

async function call(
  harness: Harness,
  method: string,
  pathWithQuery: string,
  body?: unknown,
): Promise<Response> {
  const res = await fetch(harness.base + pathWithQuery, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? null : JSON.parse(text), headers: res.headers };
}

const getConfig = (harness: Harness, doc: string): Promise<Response> =>
  call(harness, "GET", `/api/config${query({ doc })}`);

const save = (
  harness: Harness,
  body: Record<string, unknown>,
): Promise<Response> => call(harness, "POST", "/api/config/save", body);

/** Bodies posted to /api/config/save carry the classic base-flow fields. */
const saveBody = (
  doc: string,
  text: string,
  baseSha256: string,
  baseIssues: unknown[] = [],
): Record<string, unknown> => ({ doc, text, baseSha256, baseIssues });

function rawGet(
  harness: Harness,
  pathWithQuery: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const { port } = harness.server.address() as AddressInfo;
    const request = http.request({ host: "127.0.0.1", port, path: pathWithQuery, headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => done({ status: res.statusCode ?? 0, body: data }));
    });
    request.on("error", fail);
    request.end();
  });
}

const tmpResidue = (agentDir: string): string[] =>
  readdirSync(agentDir).filter((name) => name.includes(".tmp-"));
const backupsIn = (agentDir: string): string[] =>
  readdirSync(agentDir).filter((name) => name.includes(".bak-"));

describe("server/config-api", () => {
  describe("seedText", () => {
    it("seedText_shouldMatchTheDocumentedStubs", () => {
      expect(seedText("models")).toBe(SEED_MODELS);
      expect(seedText("auth")).toBe(SEED_AUTH);
    });
  });

  describe("vetDoc", () => {
    it("vetDoc_unknownDocId_shouldReturn400BadDoc", () => {
      const dir = mkdtempSync(join(tmpdir(), "pcg-vet-"));
      try {
        expect(vetDoc(baseDeps(dir), "bogus")).toEqual({
          ok: false,
          status: 400,
          error: "bad_doc",
        });
        // An `other` document that is NOT present is not discovered either.
        expect(vetDoc(baseDeps(dir), "settings")).toEqual({
          ok: false,
          status: 400,
          error: "bad_doc",
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("vetDoc_discoveredReadOnlyDoc_shouldReturn403ReadOnlyDoc", () => {
      const dir = mkdtempSync(join(tmpdir(), "pcg-vet-"));
      try {
        writeFileSync(join(dir, "settings.json"), "{}\n");
        expect(vetDoc(baseDeps(dir), "settings")).toEqual({
          ok: false,
          status: 403,
          error: "read_only_doc",
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("vetDoc_absentManagedDocs_shouldBeOkWithExistsFalse", () => {
      const dir = mkdtempSync(join(tmpdir(), "pcg-vet-"));
      try {
        const models = vetDoc(baseDeps(dir), "models");
        expect(models.ok).toBe(true);
        if (models.ok) {
          expect(models.doc.id).toBe("models");
          expect(models.doc.exists).toBe(false);
          expect(models.doc.editable).toBe(true);
        }
        const auth = vetDoc(baseDeps(dir), "auth");
        expect(auth.ok).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("state_onEmptyAgentDir_shouldListManagedDocsExistsFalse_plusPiVersionAndSchema", async () => {
    const harness = await boot();
    writeFileSync(join(harness.agentDir, "settings.json"), "{}\n"); // the only file present

    const got = await call(harness, "GET", "/api/state");
    expect(got.status).toBe(200);
    expect(got.body.agentDir).toBe(harness.agentDir);
    expect(got.body.piVersion).toBeNull();
    expect(got.body.schemaSource).toBe("bundled");
    expect(got.body.schemaFetchedAt).toBe("bundled");

    // Exact list, order and flags (Review Focus 4): models + auth always listed
    // with exists:false; the read-only neighbour appears only because present.
    expect(got.body.docs).toEqual([
      {
        id: "models",
        path: join(harness.agentDir, "models.json"),
        kind: "models",
        editable: true,
        exists: false,
      },
      {
        id: "auth",
        path: join(harness.agentDir, "auth.json"),
        kind: "auth",
        editable: true,
        exists: false,
      },
      {
        id: "settings",
        path: join(harness.agentDir, "settings.json"),
        kind: "other",
        editable: false,
        exists: true,
      },
    ]);

    // API responses carry no CORS headers (same-origin tool, no cross-site writes).
    expect(got.headers.get("access-control-allow-origin")).toBeNull();
    expect(got.headers.get("access-control-allow-methods")).toBeNull();
  });

  describe("GET /api/config", () => {
    it("getConfig_absentModelsDoc_shouldServeSeedTextAndSeedSha", async () => {
      const harness = await boot();
      const got = await getConfig(harness, "models");
      expect(got.status).toBe(200);
      expect(got.body.text).toBe(SEED_MODELS);
      expect(got.body.sha256).toBe(sha256(SEED_MODELS));
      expect(got.body.issues).toEqual([]); // the seed validates clean
      expect(got.body.exists).toBe(false);
    });

    it("getConfig_absentAuthDoc_shouldServeEmptyObjectSeed", async () => {
      const harness = await boot();
      const got = await getConfig(harness, "auth");
      expect(got.status).toBe(200);
      expect(got.body.text).toBe(SEED_AUTH);
      expect(got.body.sha256).toBe(sha256(SEED_AUTH));
      expect(got.body.issues).toEqual([]);
      expect(got.body.exists).toBe(false);
    });

    it("getConfig_existingDoc_shouldServeDiskTextWithExistsTrue", async () => {
      const harness = await boot();
      writeFileSync(harness.modelsPath, VALID_MODELS);
      const got = await getConfig(harness, "models");
      expect(got.status).toBe(200);
      expect(got.body.text).toBe(VALID_MODELS);
      expect(got.body.sha256).toBe(sha256(VALID_MODELS));
      expect(got.body.issues).toEqual([]);
      expect(got.body.exists).toBe(true);
    });

    it("getConfig_missingOrUnknownOrReadOnlyDoc_shouldReturn400BadRequest_or400BadDoc_or403", async () => {
      const harness = await boot();
      writeFileSync(join(harness.agentDir, "mcp.json"), "{}\n");

      expect((await call(harness, "GET", "/api/config")).status).toBe(400);
      expect((await call(harness, "GET", "/api/config")).body.error).toBe("bad_request");

      const bad = await getConfig(harness, "nope");
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe("bad_doc");

      const readOnly = await getConfig(harness, "mcp");
      expect(readOnly.status).toBe(403);
      expect(readOnly.body.error).toBe("read_only_doc");
    });
  });

  describe("classic save (models + raw auth)", () => {
    it("save_validEdit_shouldWriteBackupAndReplaceAtomically", async () => {
      const harness = await boot();
      writeFileSync(harness.modelsPath, VALID_MODELS);
      const got = await getConfig(harness, "models");

      const editedText = got.body.text.replace("X Local", "X (renamed)");
      expect(editedText).not.toBe(VALID_MODELS);

      const saved = await save(harness, saveBody("models", editedText, got.body.sha256));
      expect(saved.status).toBe(200);
      expect(saved.body.sha256).toBe(sha256(editedText));
      expect(typeof saved.body.backupPath).toBe("string");

      // Backup: next to the file, named *.bak-YYYYMMDD-HHmmss, holding the OLD bytes.
      const backupName = basename(saved.body.backupPath as string);
      expect(backupName).toMatch(/^models\.json\.bak-\d{8}-\d{6}$/);
      expect(resolve(saved.body.backupPath)).toBe(join(harness.agentDir, backupName));
      expect(readFileSync(saved.body.backupPath, "utf8")).toBe(VALID_MODELS);

      // The file now matches the submitted text byte-for-byte, and the temp
      // file used for the atomic rename left no residue.
      expect(readFileSync(harness.modelsPath, "utf8")).toBe(editedText);
      expect(tmpResidue(harness.agentDir)).toEqual([]);
    });

    it("save_twiceInSameSecond_shouldKeepBothBackups", async () => {
      // Rapid sequential saves must never let the backup net eat an earlier
      // backup: each save gets its own file (port of the sister's pin).
      const harness = await boot();
      writeFileSync(harness.modelsPath, VALID_MODELS);
      const got = await getConfig(harness, "models");

      const firstText = (got.body.text as string).replace("X Local", "X (one)");
      const secondText = firstText.replace("X (one)", "X (two)");

      const first = await save(harness, saveBody("models", firstText, got.body.sha256));
      expect(first.status).toBe(200);
      const second = await save(harness, saveBody("models", secondText, first.body.sha256));
      expect(second.status).toBe(200);

      expect(second.body.backupPath).not.toBe(first.body.backupPath);
      const backups = backupsIn(harness.agentDir).sort();
      expect(backups).toHaveLength(2);
      for (const name of backups) {
        expect(name).toMatch(/^models\.json\.bak-\d{8}-\d{6}(-\d+)?$/);
      }
      expect(readFileSync(first.body.backupPath, "utf8")).toBe(VALID_MODELS);
      expect(readFileSync(second.body.backupPath, "utf8")).toBe(firstText);
      expect(readFileSync(harness.modelsPath, "utf8")).toBe(secondText);
    });

    it("save_withStaleBaseSha256_shouldReturn409WithDiskSha256", async () => {
      const harness = await boot();
      writeFileSync(harness.modelsPath, VALID_MODELS);
      const got = await getConfig(harness, "models");
      appendFileSync(harness.modelsPath, "\n"); // someone else edited the file

      const saved = await save(harness, saveBody("models", got.body.text, got.body.sha256));
      expect(saved.status).toBe(409);
      expect(saved.body.error).toBe("stale");
      expect(saved.body.diskSha256).toBe(sha256(VALID_MODELS + "\n"));
      // Nothing was written: still the appended-to disk text, no backup.
      expect(readFileSync(harness.modelsPath, "utf8")).toBe(VALID_MODELS + "\n");
      expect(backupsIn(harness.agentDir)).toEqual([]);
    });

    it("save_introducingNewSchemaError_shouldReturn400WithOnlyNewIssues", async () => {
      const harness = await boot();
      // Pre-existing (tolerated) issue: provider name is a number.
      const flawed = VALID_MODELS.replace('"name": "X Local"', '"name": 123');
      writeFileSync(harness.modelsPath, flawed);
      const got = await getConfig(harness, "models");
      expect(
        (got.body.issues as { path: string }[]).some((issue) => issue.path === "providers.x.name"),
      ).toBe(true);

      // The submitted text keeps that old error but NEWLY drops the model id.
      const worseText = flawed.replace('"id": "x-1",\n      ', "");
      expect(worseText).not.toBe(flawed);

      const saved = await save(
        harness,
        saveBody("models", worseText, got.body.sha256, got.body.issues),
      );
      expect(saved.status).toBe(400);
      expect(saved.body.error).toBe("new_issues");
      const newPaths = (saved.body.newIssues as { path: string }[]).map((issue) => issue.path);
      expect(newPaths).toContain("providers.x.models[0]");
      // Only the set difference newSet \ oldSet may stop this save.
      expect(newPaths).not.toContain("providers.x.name");

      // Blocked saves touch nothing: same bytes, no backup created.
      expect(readFileSync(harness.modelsPath, "utf8")).toBe(flawed);
      expect(backupsIn(harness.agentDir)).toEqual([]);
    });

    it("save_withPreExistingIssueInUntouchedField_shouldSucceed", async () => {
      const harness = await boot();
      const flawed = VALID_MODELS.replace('"name": "X Local"', '"name": 123');
      writeFileSync(harness.modelsPath, flawed);
      const got = await getConfig(harness, "models");

      const editedText = flawed.replace("http://localhost:8000/v1", "http://127.0.0.1:8000/v1");
      const saved = await save(
        harness,
        saveBody("models", editedText, got.body.sha256, got.body.issues),
      );
      expect(saved.status).toBe(200);
      expect(Object.keys(saved.body).sort()).toEqual(["backupPath", "sha256"]);
      expect(readFileSync(harness.modelsPath, "utf8")).toBe(editedText);
    });

    it("save_overAbsentModelsFile_shouldSeedCreateItWithoutBackup", async () => {
      // Review Focus 4: first save seeds and creates the file. The staleness
      // baseline was the SEED hash, so an unchanged-on-disk (absent) file
      // counts as the seed content, and no backup is taken for a creation.
      const harness = await boot();
      const got = await getConfig(harness, "models");

      const edited = SEED_MODELS.replace(
        '"providers": {}',
        `"providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions"
    }
  }`,
      );
      const saved = await save(harness, saveBody("models", edited, got.body.sha256));
      expect(saved.status).toBe(200);
      expect(saved.body.sha256).toBe(sha256(edited));
      expect(saved.body.backupPath).toBe(""); // created files have no backup
      expect(readFileSync(harness.modelsPath, "utf8")).toBe(edited);
      expect(backupsIn(harness.agentDir)).toEqual([]);
      expect(tmpResidue(harness.agentDir)).toEqual([]);

      // The doc flipped to exists:true through the same discovery pipeline.
      const after = await getConfig(harness, "models");
      expect(after.body.exists).toBe(true);
      expect(after.body.text).toBe(edited);
    });

    it("save_overAbsentAuthFile_shouldSeedCreateItWithoutBackup", async () => {
      const harness = await boot();
      const got = await getConfig(harness, "auth");

      const edited = `{"anthropic": {"type": "api_key", "key": "sk-test-1"}}\n`;
      const saved = await save(harness, saveBody("auth", edited, got.body.sha256));
      expect(saved.status).toBe(200);
      expect(saved.body.sha256).toBe(sha256(edited));
      expect(saved.body.backupPath).toBe("");
      expect(readFileSync(harness.authPath, "utf8")).toBe(edited);
      expect(backupsIn(harness.agentDir)).toEqual([]);
    });

    it("save_authWithoutEdits_shouldUseClassicStaleSemantics", async () => {
      // The raw-tab auth path (no `edits`): classic staleness, NOT rebase.
      const harness = await boot();
      writeFileSync(harness.authPath, `{"anthropic": {"type": "api_key", "key": "sk-old"}}\n`);
      const got = await getConfig(harness, "auth");
      appendFileSync(harness.authPath, " "); // pi churned the file

      const saved = await save(harness, saveBody("auth", got.body.text, got.body.sha256));
      expect(saved.status).toBe(409);
      expect(saved.body.error).toBe("stale");
      expect(saved.body.diskSha256).toBe(sha256(got.body.text + " "));
      expect(backupsIn(harness.agentDir)).toEqual([]);
    });

    it("save_readOnlyDoc_shouldReturn403AndWriteNothing", async () => {
      const harness = await boot();
      writeFileSync(join(harness.agentDir, "settings.json"), `{"theme": "dark"}\n`);

      const saved = await save(harness, saveBody("settings", "{}\n", sha256("{}\n")));
      expect(saved.status).toBe(403);
      expect(saved.body.error).toBe("read_only_doc");
      expect(readFileSync(join(harness.agentDir, "settings.json"), "utf8")).toBe(
        `{"theme": "dark"}\n`,
      );
    });

    it("save_withNonStringFieldsOrGarbageBody_shouldReturn400BadRequest", async () => {
      const harness = await boot();

      const missingDoc = await save(harness, { text: "{}", baseSha256: "x", baseIssues: [] });
      expect(missingDoc.status).toBe(400);
      expect(missingDoc.body.error).toBe("bad_request");

      const nonStringText = await save(harness, {
        doc: "models",
        text: 42,
        baseSha256: "x",
        baseIssues: [],
      });
      expect(nonStringText.status).toBe(400);
      expect(nonStringText.body.error).toBe("bad_request");

      const garbage = await call(harness, "POST", "/api/config/save", "not-an-object" as never);
      expect(garbage.status).toBe(400);
      expect(garbage.body.error).toBe("bad_request");
    });
  });

  it("save_modelsThroughCommentedFile_shouldPreserveCommentsAndTrailingCommasInWrittenBytes", async () => {
    // Review Focus 2 re-pin through the save route: a legacy/odd models.json
    // with `//` comments and trailing commas round-trips with them alive.
    const harness = await boot();
    writeFileSync(harness.modelsPath, COMMENTED_MODELS);

    const got = await getConfig(harness, "models");
    expect(got.status).toBe(200);
    expect(got.body.text).toBe(COMMENTED_MODELS);
    expect(got.body.issues).toEqual([]); // comments/trailing commas are not issues

    const edited = got.body.text.replace("http://localhost:8000/v1", "http://127.0.0.1:8000/v1");
    const saved = await save(harness, saveBody("models", edited, got.body.sha256));
    expect(saved.status).toBe(200);

    const written = readFileSync(harness.modelsPath, "utf8");
    expect(written).toBe(edited); // byte-for-byte the submitted (edited) text
    expect(written).toContain("// pi keeps this comment alive; so must the GUI.");
    expect(written).toContain("/* block comment too */");
    expect(written).toContain("// hand-chosen limit");
    expect(written).toMatch(/"maxTokens": 16384,\n\s*\}/); // trailing comma survives
    expect(written).toMatch(/"maxTokens": 16384,\n\s*\},\n\s*\]/); // …and after the array element
    // The backup holds the ORIGINAL commented bytes too.
    expect(readFileSync(saved.body.backupPath, "utf8")).toBe(COMMENTED_MODELS);
  });

  it.skipIf(process.platform === "win32")(
    "save_creatingAuthFileOnPosix_shouldChmodTo0600",
    async () => {
      // Global constraint: POSIX-created auth.json gets mode 0600 (seeded
      // first save creates the file). Skipped on win32, where NTFS ACLs
      // make st_mode meaningless.
      const harness = await boot();
      const got = await getConfig(harness, "auth");

      const edited = `{"anthropic": {"type": "api_key", "key": "sk-mode"}}\n`;
      const saved = await save(harness, saveBody("auth", edited, got.body.sha256));
      expect(saved.status).toBe(200);

      const mode = statSync(harness.authPath).mode & 0o777;
      expect(mode).toBe(0o600);
    },
  );

  describe("loopback gate (server glue, exercised through this route set)", () => {
    it("api_withForeignHostHeader_shouldReturn403", async () => {
      // DNS-rebinding shape: connection is local but Host names another site.
      const harness = await boot();
      const got = await rawGet(harness, "/api/state", { host: "attacker.example" });
      expect(got.status).toBe(403);
      expect(JSON.parse(got.body).error).toBeTruthy();
    });

    it("api_withForeignOrigin_shouldReturn403", async () => {
      const harness = await boot();
      const got = await rawGet(harness, "/api/state", { origin: "http://evil.example" });
      expect(got.status).toBe(403);
      expect(JSON.parse(got.body).error).toBeTruthy();

      // Control: a self-consistent localhost Host+Origin pair is accepted.
      const { port } = harness.server.address() as AddressInfo;
      const good = await rawGet(harness, "/api/state", {
        host: `localhost:${port}`,
        origin: `http://localhost:${port}`,
      });
      expect(good.status).toBe(200);
    });
  });
});
