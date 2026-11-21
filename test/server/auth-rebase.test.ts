import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createConfigApiHandlers, type ConfigApiDeps } from "../../src/server/config-api";
import { sha256 } from "../../src/server/http";
import { createServer } from "../../src/server/server";

/**
 * Task 5's behavioral gate for the `auth.json` rebase save (spec Goal 11 /
 * "Settled during builder-check" 1, Review Focus 1 + 5). Same harness shape
 * as the sister `config-api.test.ts`: real `createServer` on 127.0.0.1:0,
 * mkdtemp agent dirs on real node:fs, injected `env: {}` + failFetch +
 * failExec so nothing touches the network, a real HOME, or a pi binary.
 *
 * Design intent pinned here: pi rewrites `auth.json` live (OAuth token
 * rotation), so structured edits rebase onto the FRESHLY-READ disk text and
 * a conflict fires ONLY when a top-level entry a touched path addresses
 * changed between the client's `baseText` and disk.
 */

const failFetch = (async () => {
  throw new Error("offline test: server tests must not touch the network");
}) as unknown as typeof fetch;

const failExec = (): Promise<{ stdout: string }> =>
  Promise.reject(new Error("offline test: no pi binary may run"));

interface Harness {
  server: http.Server;
  base: string;
  dir: string;
  agentDir: string;
  authPath: string;
}

const harnesses: Harness[] = [];

function boot(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "pcg-rebase-"));
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });

  const deps: ConfigApiDeps = {
    platform: process.platform,
    env: {}, // never inherit a real PI_CODING_AGENT_DIR / HOME
    agentDir,
    loadSchemaOptions: { cacheDir: join(dir, "schema-cache"), fetchImpl: failFetch },
    execFileImpl: failExec,
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

interface Response {
  status: number;
  body: any;
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
  return { status: res.status, body: text === "" ? null : JSON.parse(text) };
}

const save = (harness: Harness, body: Record<string, unknown>): Promise<Response> =>
  call(harness, "POST", "/api/config/save", body);

/** A structured (rebase-path) auth save: `edits` + `baseText`, no `text`. */
const saveRebase = (
  harness: Harness,
  edits: unknown[],
  baseText?: unknown,
): Promise<Response> =>
  save(harness, {
    doc: "auth",
    edits,
    ...(baseText === undefined ? {} : { baseText }),
  });

/** Bodies posted to the classic raw-tab path (no `edits`). */
const classicSaveBody = (
  doc: string,
  text: string,
  baseSha256: string,
): Record<string, unknown> => ({ doc, text, baseSha256, baseIssues: [] });

const tmpResidue = (agentDir: string): string[] =>
  readdirSync(agentDir).filter((name) => name.includes(".tmp-"));
const backupsIn = (agentDir: string): string[] =>
  readdirSync(agentDir).filter((name) => name.includes(".bak-"));

describe("server/auth-rebase", () => {
  it("rebaseSave_editInOneEntry_shouldRebaseOntoDiskAndKeepUnrelatedEntryBytesStable", async () => {
    // Brief scenario 1 / Review Focus 1: the client's base still holds the
    // OLD OAuth token `T0`, pi has already rotated the entry to `T1`, and the
    // user's only edit touches `anthropic.key → B`. The save must SUCCEED
    // (untouched entries never conflict) and the freshly-read `T1` must land
    // in the written file with every byte outside the edited path unchanged.
    const harness = await boot();
    const DISK = `{"anthropic": {"type": "api_key", "key": "A"}, "copilot": {"type": "oauth", "token": "T1"}}\n`;
    const BASE = `{"anthropic": {"type": "api_key", "key": "A"}, "copilot": {"type": "oauth", "token": "T0"}}\n`;
    writeFileSync(harness.authPath, DISK);

    const saved = await saveRebase(harness, [{ path: ["anthropic", "key"], value: "B" }], BASE);
    expect(saved.status).toBe(200);
    expect(saved.body.rebased).toBe(true);

    // Byte-stable everywhere except the surgical `"A" → "B"` replacement:
    // the `copilot` entry (including the rotated `T1`) survives verbatim.
    const expected = DISK.replace('"key": "A"', '"key": "B"');
    const written = readFileSync(harness.authPath, "utf8");
    expect(written).toBe(expected);
    expect(written).toContain(`"copilot": {"type": "oauth", "token": "T1"}`);
    expect(saved.body.sha256).toBe(sha256(expected));

    // Same backup/atomic-write net as the classic path: backup holds the
    // pre-save disk bytes, no temp-file residue.
    expect(readFileSync(saved.body.backupPath, "utf8")).toBe(DISK);
    expect(tmpResidue(harness.agentDir)).toEqual([]);
  });

  it("rebaseSave_touchedEntryChangedOnDisk_shouldReturn409ConflictAndWriteNothing", async () => {
    // Brief scenario 2: pi rotated something INSIDE the entry the user's edit
    // touches (base key `A0`, disk key `A1`) → 409 conflict naming exactly
    // the touched entries; the file and every byte stay untouched.
    const harness = await boot();
    const DISK = `{"anthropic": {"type": "api_key", "key": "A1"}, "copilot": {"type": "oauth", "token": "T1"}}\n`;
    const BASE = `{"anthropic": {"type": "api_key", "key": "A0"}, "copilot": {"type": "oauth", "token": "T0"}}\n`;
    writeFileSync(harness.authPath, DISK);

    const saved = await saveRebase(harness, [{ path: ["anthropic", "key"], value: "B" }], BASE);
    expect(saved.status).toBe(409);
    expect(saved.body.error).toBe("conflict");
    expect(saved.body.entries).toEqual(["anthropic"]);
    // `copilot` also differs (T0 vs T1) but is NOT touched → not reported.
    expect(saved.body.entries).not.toContain("copilot");

    expect(readFileSync(harness.authPath, "utf8")).toBe(DISK);
    expect(backupsIn(harness.agentDir)).toEqual([]);
    expect(tmpResidue(harness.agentDir)).toEqual([]);
  });

  it("rebaseSave_addNewEntryWhileDiskGainedUnrelatedOne_shouldKeepBoth", async () => {
    // Brief scenario 3: the edit ADDS a brand-new top-level entry while the
    // disk gained a different, unrelated one since the client's base (pi /
    // login flow). Both-absent counts as equal for the touched (new) entry,
    // so no conflict fires and the write keeps the disk's new entry AND the
    // user's new entry.
    const harness = await boot();
    const BASE = `{"anthropic": {"type": "api_key", "key": "A"}}\n`;
    const DISK = `{"anthropic": {"type": "api_key", "key": "A"}, "superbrain": {"type": "oauth", "token": "SB1"}}\n`;
    writeFileSync(harness.authPath, DISK);

    const saved = await saveRebase(
      harness,
      [{ path: ["zeta"], value: { type: "api_key", key: "sk-new" } }],
      BASE,
    );
    expect(saved.status).toBe(200);
    expect(saved.body.rebased).toBe(true);

    const writtenText = readFileSync(harness.authPath, "utf8");
    const written = JSON.parse(writtenText);
    expect(Object.keys(written).sort()).toEqual(["anthropic", "superbrain", "zeta"]);
    expect(written.zeta).toEqual({ type: "api_key", key: "sk-new" });
    expect(written.superbrain).toEqual({ type: "oauth", token: "SB1" });
    // Value-level "keeps both" is what this scenario pins. NOTE (current
    // shared-layer behavior, not a rebase-path choice): inserting a NEW key
    // makes jsonc-parser's `modify` reflow the containing object, so a
    // compactly-formatted disk file comes back pretty-printed. Byte-stability
    // of untouched entries under the surgical case (in-place value
    // replacement) is pinned by the two byte-exact tests above.
    expect(writtenText).not.toBe(DISK);
    expect(writtenText).toContain("\n    \"token\": \"SB1\"");
  });

  it("rebaseSave_unknownShapeEntryUntouched_shouldStayByteStable", async () => {
    // Brief scenario 4 / Review Focus 5: a future-pi entry shape the schema
    // layer does not understand, left untouched by the edits, must come
    // through the rebase write byte-identical — quirky spacing and all.
    const harness = await boot();
    const DISK =
      `{"anthropic": {"type": "api_key", "key": "A"},\n` +
      `  "zeta":  { "type": "weird",  "nested": { "x": [1,  2] } }\n` +
      `}\n`;
    const BASE = `{"anthropic": {"type": "api_key", "key": "A"}, "zeta": {"type": "weird", "nested": {"x": [1, 2]}}}\n`;
    writeFileSync(harness.authPath, DISK);

    const saved = await saveRebase(harness, [{ path: ["anthropic", "key"], value: "B" }], BASE);
    expect(saved.status).toBe(200);
    expect(saved.body.rebased).toBe(true);

    const written = readFileSync(harness.authPath, "utf8");
    expect(written).toBe(DISK.replace('"key": "A"', '"key": "B"'));
    expect(written).toContain(`  "zeta":  { "type": "weird",  "nested": { "x": [1,  2] } }`);
  });

  it("rebaseSave_withMissingOrMalformedBaseTextOrBadEdits_shouldReturn400AndWriteNothing", async () => {
    // Brief scenario 5: the rebase path requires a parseable string
    // `baseText` and a structurally valid `edits` array — anything else is a
    // malformed request (400), and the file is not touched.
    const harness = await boot();
    const DISK = `{"anthropic": {"type": "api_key", "key": "A"}}\n`;
    writeFileSync(harness.authPath, DISK);
    const edit = [{ path: ["anthropic", "key"], value: "B" }];

    const noBaseText = await saveRebase(harness, edit);
    expect(noBaseText.status).toBe(400);
    expect(noBaseText.body.error).toBe("bad_request");

    const nonStringBaseText = await saveRebase(harness, edit, 42);
    expect(nonStringBaseText.status).toBe(400);
    expect(nonStringBaseText.body.error).toBe("bad_request");

    const malformedBaseText = await saveRebase(harness, edit, `{"anthropic": `);
    expect(malformedBaseText.status).toBe(400);
    expect(malformedBaseText.body.error).toBe("bad_request");

    const editPathNotArray = await saveRebase(harness, [{ path: "anthropic", value: "B" }], DISK);
    expect(editPathNotArray.status).toBe(400);
    expect(editPathNotArray.body.error).toBe("bad_request");

    expect(readFileSync(harness.authPath, "utf8")).toBe(DISK);
    expect(backupsIn(harness.agentDir)).toEqual([]);
    expect(tmpResidue(harness.agentDir)).toEqual([]);
  });

  it("authSave_withoutEdits_shouldStillUseClassicStaleSemantics", async () => {
    // Brief scenario 6: the raw-tab full-text auth save (no `edits`) keeps
    // the classic sha-vs-disk staleness contract — 409 `stale`, not rebase.
    const harness = await boot();
    const ON_DISK = `{"anthropic": {"type": "api_key", "key": "sk-live"}}\n`;
    writeFileSync(harness.authPath, ON_DISK);
    const got = await call(harness, "GET", "/api/config?doc=auth");

    const edited = got.body.text.replace("sk-live", "sk-mine");
    const saved = await save(
      harness,
      classicSaveBody("auth", edited, sha256((got.body.text as string) + "churned")),
    );
    expect(saved.status).toBe(409);
    expect(saved.body.error).toBe("stale");
    expect(saved.body.diskSha256).toBe(sha256(ON_DISK));
    expect(readFileSync(harness.authPath, "utf8")).toBe(ON_DISK);
    expect(backupsIn(harness.agentDir)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Controller-mandated hardening from Task 4's approved review.
  // -------------------------------------------------------------------------

  it("rebaseSave_withEmptyPathEdit_shouldReturn400AndNeverReplaceRoot", async () => {
    // Hardening 1: a `path: []` edit edits the ROOT — `applyPathEdits` would
    // replace the WHOLE document with the client's (stale) value, the one
    // way an old OAuth blob could clobber a live token through the rebase
    // path. The structural `edits` pre-check must reject it with 400.
    const harness = await boot();
    const DISK = `{"anthropic": {"type": "api_key", "key": "A"}, "copilot": {"type": "oauth", "token": "T1"}}\n`;
    const BASE = `{"anthropic": {"type": "api_key", "key": "A"}, "copilot": {"type": "oauth", "token": "T0"}}\n`;
    writeFileSync(harness.authPath, DISK);

    const saved = await saveRebase(
      harness,
      [{ path: [], value: { anthropic: { type: "api_key", key: "STALE-BLOB" } } }],
      BASE,
    );
    expect(saved.status).toBe(400);
    expect(saved.body.error).toBe("bad_request");

    // The stale full-document blob never reaches disk: `T1` still there.
    expect(readFileSync(harness.authPath, "utf8")).toBe(DISK);
    expect(backupsIn(harness.agentDir)).toEqual([]);
    expect(tmpResidue(harness.agentDir)).toEqual([]);
  });

  it("rebaseSave_overHardMalformedDiskAuth_shouldReturn500ViaServerCatchAndWriteNothing", async () => {
    // Hardening 2 (pin of CURRENT behavior, no redesign): with a hard-
    // malformed auth.json on disk, the conflict gate can no longer see any
    // disk entry (tolerant parse yields no usable object), so a NEW-entry
    // edit passes the gate and `applyPathEdits` refuses to edit malformed
    // JSONC. The throw escapes the route handler and the server's top-level
    // catch answers 500 `internal_error`. No write, no backup.
    const harness = await boot();
    const MALFORMED = `{"anthropic": {"type": "api_key", "key": "A"},\n`; // unclosed root
    writeFileSync(harness.authPath, MALFORMED);

    const saved = await saveRebase(
      harness,
      [{ path: ["zeta"], value: { type: "api_key", key: "sk-new" } }],
      "{}\n",
    );
    expect(saved.status).toBe(500);
    expect(saved.body.error).toBe("internal_error");

    expect(readFileSync(harness.authPath, "utf8")).toBe(MALFORMED);
    expect(backupsIn(harness.agentDir)).toEqual([]);
    expect(tmpResidue(harness.agentDir)).toEqual([]);
  });

  it("rebaseSave_keyReorderInsideTouchedEntryOnDisk_shouldConflictConservatively", async () => {
    // Hardening 3 (pin of CURRENT behavior): touched entries are compared
    // with `JSON.stringify`, so a key REORDER of a semantically identical
    // entry on disk counts as a conflict. This is a false positive, but
    // deliberately conservative (better a spurious 409 + reload than a blind
    // overwrite of an entry pi is managing) — pinned so a future switch to
    // a semantic deep-compare is a conscious decision.
    const harness = await boot();
    const DISK = `{"anthropic": {"key": "A", "type": "api_key"}}\n`; // reordered
    const BASE = `{"anthropic": {"type": "api_key", "key": "A"}}\n`;
    writeFileSync(harness.authPath, DISK);

    const saved = await saveRebase(harness, [{ path: ["anthropic", "key"], value: "B" }], BASE);
    expect(saved.status).toBe(409);
    expect(saved.body.error).toBe("conflict");
    expect(saved.body.entries).toEqual(["anthropic"]);

    expect(readFileSync(harness.authPath, "utf8")).toBe(DISK);
    expect(backupsIn(harness.agentDir)).toEqual([]);
  });
});
