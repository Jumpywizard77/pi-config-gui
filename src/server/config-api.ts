import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import nodePath from "node:path";

import { applyPathEdits, parseJsonc } from "../core/jsonc.js";
import {
  discoverDocs,
  findPiVersion,
  type DocId,
  type ExecFileImpl,
  type FsImpl,
  type PiDoc,
} from "../core/discovery.js";
import {
  loadSchema,
  validatorFor,
  type DocValidator,
  type LoadSchemaOptions,
  type SchemaSource,
} from "../core/schema.js";
import type { Issue, JsonValue, PathEdit } from "../core/types.js";
import { json, readBody, sha256, type ApiRoutes } from "./http.js";

/**
 * HTTP-facing config endpoints for pi's agent documents: state, read, save.
 * All filesystem side effects live here (the `core/` modules stay pure).
 *
 * Path safety REPLACES the sister app's `vetConfigPath` machinery entirely:
 * there are no client-supplied paths anywhere in this API. Every read and
 * write goes to a fixed file name inside the resolved agent dir, addressed
 * only by the doc-ID allowlist (`vetDoc`), so no `?folder=` plumbing, root
 * vetting or canonical-path comparison is needed.
 */

/** Injection ports; every default is the real platform (tests go hermetic). */
export interface ConfigApiDeps {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** Pre-resolved agent dir (cli.ts `--agent-dir`); else derived from `env`. */
  agentDir?: string;
  /**
   * Hermetic home anchor for tests: substituted for `HOME`/`USERPROFILE`
   * during agent-dir resolution (the real `homedir()` is never consulted).
   * Inert when `agentDir` is given.
   */
  homeDir?: string;
  loadSchemaOptions?: LoadSchemaOptions;
  execFileImpl?: ExecFileImpl;
  /** Filesystem port for discovery only (config IO always uses node:fs). */
  discoveryFs?: FsImpl;
}

// ---------------------------------------------------------------------------
// Document safety (the allowlist that replaces sister path vetting)
// ---------------------------------------------------------------------------

export type VetOutcome =
  | { ok: true; doc: PiDoc }
  | { ok: false; status: number; error: string };

function discoverFor(deps: ConfigApiDeps): { agentDir: string; docs: PiDoc[] } {
  const env = deps.env ?? process.env;
  return discoverDocs({
    platform: deps.platform ?? process.platform,
    env:
      deps.homeDir !== undefined
        ? { ...env, HOME: deps.homeDir, USERPROFILE: deps.homeDir }
        : env,
    ...(deps.agentDir !== undefined ? { agentDir: deps.agentDir } : {}),
    ...(deps.discoveryFs !== undefined ? { fsImpl: deps.discoveryFs } : {}),
  });
}

/**
 * Resolve a client-supplied doc id against THIS server's discovered
 * documents. Anything not on the list is a `bad_doc` 400 (including the
 * read-only ids while their files are absent — they are only discovered
 * when present); discovered read-only neighbours (settings/mcp/keybindings)
 * are refused by KIND with 403 before any file is touched. `models` and
 * `auth` pass even while absent: the read/save routes serve/seed the
 * documented stub. This is the ONLY way a request reaches a file path.
 */
export function vetDoc(deps: ConfigApiDeps, docId: string): VetOutcome {
  const { docs } = discoverFor(deps);
  const doc = docs.find((candidate) => candidate.id === docId);
  if (doc === undefined) return { ok: false, status: 400, error: "bad_doc" };
  if (!doc.editable) return { ok: false, status: 403, error: "read_only_doc" };
  return { ok: true, doc };
}

/**
 * The documented stub a managed document gets when it does not exist yet
 * (spec Anti-goals): served by `GET /api/config` and used as the staleness
 * base and issue-set source for a first save that CREATES the file.
 */
export function seedText(docId: DocId): string {
  if (docId === "auth") return "{}\n";
  return (
    `{\n  "$schema": "https://pi.dev/schemas/models.schema.json",\n` +
    `  "providers": {}\n}\n`
  );
}

// ---------------------------------------------------------------------------
// Save pipeline
// ---------------------------------------------------------------------------

export interface SaveDeps {
  /** The per-document validator (already bound to the loaded schema). */
  validate: DocValidator;
}

export interface SaveWritten {
  ok: true;
  sha256: string;
  /** `""` when the save CREATED the file (there was nothing to back up). */
  backupPath: string;
}
export interface SaveStale {
  ok: false;
  kind: "stale";
  diskSha256: string;
}
export interface SaveBlocked {
  ok: false;
  kind: "new_issues";
  newIssues: Issue[];
}
export type SaveResult = SaveWritten | SaveStale | SaveBlocked;

/** Rebase-save success: edits replayed onto freshly-read disk content. */
export interface SaveRebased {
  ok: true;
  sha256: string;
  backupPath: string;
  rebased: true;
}
/** A touched `auth.json` entry differs on disk from the client's base. */
export interface SaveConflict {
  ok: false;
  kind: "conflict";
  entries: string[];
}

const issueKey = (issue: Issue): string => `${issue.path}|${issue.message}`;

/** Local-time `YYYYMMDD-HHmmss` stamp for backup file names. */
function backupStamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

const MAX_BACKUP_ATTEMPTS = 50;

/**
 * Copy `source` to a FRESH backup path next to it and return that path.
 * The stamp has 1-second granularity, and rapid sequential saves (double
 * Ctrl+S) collide on it — a plain `copyFileSync` would silently overwrite
 * the earlier backup, letting the safety net itself lose data. So the copy
 * is exclusive (`COPYFILE_EXCL`, also race-proof against a concurrent
 * saver) and a colliding name is retried with `-1`, `-2`, … suffixes.
 */
function writeBackup(source: string): string {
  const stem = `${source}.bak-${backupStamp(new Date())}`;
  for (let attempt = 0; attempt < MAX_BACKUP_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? stem : `${stem}-${attempt}`;
    try {
      copyFileSync(source, candidate, constants.COPYFILE_EXCL);
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
  }
  throw new Error(
    `could not create a unique backup next to ${source} after ${MAX_BACKUP_ATTEMPTS} attempts`,
  );
}

/**
 * Atomic replace: temp file in the SAME directory, then rename onto the
 * target (rename is atomic within a filesystem; on Windows Node replaces
 * the existing file via MoveFileExW(REPLACE_EXISTING)). When CREATING a
 * `auth.json` on POSIX the secret-file mode is applied to the temp file
 * BEFORE the rename, so the finished file is never briefly world-readable.
 */
function atomicWrite(path: string, text: string, creating: boolean): void {
  const tempPath = nodePath.join(
    nodePath.dirname(path),
    `.${nodePath.basename(path)}.tmp-${randomBytes(6).toString("hex")}`,
  );
  writeFileSync(tempPath, text);
  try {
    if (creating && process.platform !== "win32" && nodePath.basename(path) === "auth.json") {
      chmodSync(tempPath, 0o600);
    }
    renameSync(tempPath, path);
  } catch (err) {
    rmSync(tempPath, { force: true }); // no orphaned temp residue on failure
    throw err;
  }
}

/**
 * The shared tail of both save flavors: block only on issues NEWLY
 * introduced by the edit (the OLD issue set is recomputed from the text
 * that was on disk, never from a client claim — disk truth wins), then the
 * backup-then-atomic-write net. `diskText`/`existed` are the snapshot the
 * caller took, so the caller's staleness or conflict gate composes with
 * this without re-reading (same small race window as the sister app).
 */
function commitSave(
  deps: SaveDeps,
  path: string,
  diskText: string,
  existed: boolean,
  text: string,
): SaveWritten | SaveBlocked {
  const oldKeys = new Set(deps.validate(diskText).map(issueKey));
  const introduced = new Map<string, Issue>();
  for (const issue of deps.validate(text)) {
    const key = issueKey(issue);
    // set difference newSet \ oldSet, de-duplicated by `path|message`
    if (!oldKeys.has(key) && !introduced.has(key)) introduced.set(key, issue);
  }
  if (introduced.size > 0) {
    return { ok: false, kind: "new_issues", newIssues: [...introduced.values()] };
  }

  const backupPath = existed ? writeBackup(path) : ""; // backup BEFORE any overwrite
  atomicWrite(path, text, !existed);
  return { ok: true, sha256: sha256(text), backupPath };
}

/**
 * The classic validated-save pipeline (models.json, and auth.json saves
 * from the raw tab with no structured edits).
 *
 * PATH SAFETY IS THE CALLER'S JOB: `path` must already come from `vetDoc`.
 * This function happily writes any path it is handed.
 *
 * A file that does not exist yet is compared (and issue-diffed) against the
 * document's `seed` text instead: the read route handed the client the seed
 * with the seed's hash, so the client's base hash lines up and the save
 * CREATES the file (no backup — there was nothing to preserve).
 */
export async function saveValidated(
  deps: SaveDeps,
  path: string,
  seed: string,
  text: string,
  baseSha256: string,
): Promise<SaveResult> {
  const existed = existsSync(path);
  const diskText = existed ? readFileSync(path, "utf8") : seed;

  const diskSha = sha256(diskText);
  if (diskSha !== baseSha256) return { ok: false, kind: "stale", diskSha256: diskSha };

  return commitSave(deps, path, diskText, existed, text);
}

/** Top-level object view of a JSONC parse result; non-objects see no entries. */
function asObject(value: JsonValue | undefined): Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : {};
}

/**
 * The `auth.json` rebase save (spec "Settled during builder-check" 1): pi
 * rewrites this file live (OAuth token refresh), so a stale full-text
 * Force-save could revoke a live session. Instead the client's surgical
 * `edits` are replayed onto the FRESHLY-READ disk text. Conflict only when
 * a TOP-LEVEL ENTRY a touched path addresses differs between the client's
 * `baseText` and disk (`JSON.stringify` deep-compare; both-absent counts as
 * equal, one-absent as a conflict). Untouched entries are never addressed
 * and therefore survive byte-for-byte. The resulting text then runs the
 * exact same new-issues/backup/atomic-write policy as `saveValidated`.
 *
 * PATH SAFETY IS THE CALLER'S JOB, as for `saveValidated`.
 */
export async function saveAuthRebased(
  deps: SaveDeps,
  path: string,
  baseText: string,
  edits: PathEdit[],
): Promise<SaveResult | SaveRebased | SaveConflict> {
  const existed = existsSync(path);
  const diskText = existed ? readFileSync(path, "utf8") : seedText("auth");

  const baseObj = asObject(parseJsonc(baseText).value);
  const diskObj = asObject(parseJsonc(diskText).value);

  // The distinct top-level entries the edit paths touch.
  const touched: string[] = [];
  for (const edit of edits) {
    const entry = String(edit.path[0]);
    if (!touched.includes(entry)) touched.push(entry);
  }
  const conflicts = touched.filter((entry) => {
    // Own-property lookup, never a prototype one: a path segment named
    // "__proto__" must not compare Object.prototype against itself (or
    // against a real disk value) instead of the entries the client touched.
    const inBase = Object.prototype.hasOwnProperty.call(baseObj, entry);
    const inDisk = Object.prototype.hasOwnProperty.call(diskObj, entry);
    if (!inBase || !inDisk) return inBase !== inDisk; // both-absent = equal, as before
    return JSON.stringify(baseObj[entry]) !== JSON.stringify(diskObj[entry]);
  });
  if (conflicts.length > 0) return { ok: false, kind: "conflict", entries: conflicts };

  const text = applyPathEdits(diskText, edits);
  const written = commitSave(deps, path, diskText, existed, text);
  if (!written.ok) return written;
  return { ok: true, sha256: written.sha256, backupPath: written.backupPath, rebased: true };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Structural check for the `edits` the structured tabs send (Task 1 shape). */
function isPathEditArray(value: unknown[]): value is PathEdit[] {
  return value.every((edit) => {
    if (typeof edit !== "object" || edit === null) return false;
    const path = (edit as PathEdit).path;
    return (
      Array.isArray(path) &&
      // An EMPTY path edits the ROOT: `applyPathEdits` would then REPLACE
      // THE WHOLE DOCUMENT with the client's value — the one way a stale
      // OAuth blob could clobber a live token through the rebase path. The
      // structured tabs only ever address `["<entry>", …]`, so rejecting
      // `length === 0` costs nothing real and closes that hole (Task 5).
      path.length > 0 &&
      path.every((segment) => typeof segment === "string" || typeof segment === "number")
    );
  });
}

/** One HTTP mapping for every outcome of both save flavors. */
function sendSaveResult(
  res: ServerResponse,
  result: SaveResult | SaveRebased | SaveConflict,
): void {
  if (result.ok) {
    json(res, 200, {
      sha256: result.sha256,
      backupPath: result.backupPath,
      ...("rebased" in result ? { rebased: true } : {}),
    });
    return;
  }
  if (result.kind === "stale") {
    json(res, 409, { error: "stale", diskSha256: result.diskSha256 });
  } else if (result.kind === "new_issues") {
    json(res, 400, { error: "new_issues", newIssues: result.newIssues });
  } else {
    json(res, 409, { error: "conflict", entries: result.entries });
  }
}

export function createConfigApiHandlers(deps: ConfigApiDeps = {}): ApiRoutes {
  const schemaSource = (): Promise<SchemaSource> => loadSchema(deps.loadSchemaOptions ?? {});

  return {
    "GET /api/state": async ({ res }) => {
      const { agentDir, docs } = discoverFor(deps);
      const [source, piVersion] = await Promise.all([
        schemaSource(),
        findPiVersion(deps.execFileImpl),
      ]);
      json(res, 200, {
        agentDir,
        docs,
        piVersion,
        schemaSource: source.source,
        schemaFetchedAt: source.fetchedAt,
      });
    },

    "GET /api/config": async ({ res, url }) => {
      const docId = url.searchParams.get("doc");
      if (docId === null || docId === "") {
        json(res, 400, { error: "bad_request" });
        return;
      }
      const vet = vetDoc(deps, docId);
      if (!vet.ok) {
        json(res, vet.status, { error: vet.error });
        return;
      }
      let text: string;
      let exists: boolean;
      if (existsSync(vet.doc.path)) {
        exists = true;
        try {
          text = readFileSync(vet.doc.path, "utf8");
        } catch {
          // discovered a moment ago yet unreadable (race/permissions): a read
          // failure, not a safety refusal.
          json(res, 500, { error: "read_failed" });
          return;
        }
      } else {
        // Absent editable file: serve the seed so the classic base-hash flow
        // (GET → edit → save with the served sha) seeds the file on first save.
        exists = false;
        text = seedText(vet.doc.id);
      }
      const source = await schemaSource();
      json(res, 200, {
        text,
        sha256: sha256(text),
        issues: validatorFor(vet.doc.id, source)(text),
        exists,
      });
    },

    "POST /api/config/save": async ({ req, res }) => {
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(await readBody(req));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          json(res, 400, { error: "bad_request" });
          return;
        }
        body = parsed as Record<string, unknown>;
      } catch {
        json(res, 400, { error: "bad_request" });
        return;
      }
      const docId = body["doc"];
      if (typeof docId !== "string" || docId === "") {
        json(res, 400, { error: "bad_request" });
        return;
      }
      const vet = vetDoc(deps, docId);
      if (!vet.ok) {
        json(res, vet.status, { error: vet.error });
        return;
      }
      const source = await schemaSource();
      const saveDeps: SaveDeps = { validate: validatorFor(vet.doc.id, source) };

      const edits = body["edits"];
      if (vet.doc.id === "auth" && Array.isArray(edits) && edits.length > 0) {
        // Structured auth save: rebase onto disk. `baseText` must be the
        // parseable text the edits were computed against, and `edits` must
        // have the PathEdit shape — anything else is a malformed request.
        const baseText = body["baseText"];
        if (
          typeof baseText !== "string" ||
          !isPathEditArray(edits) ||
          parseJsonc(baseText).errors.length > 0
        ) {
          json(res, 400, { error: "bad_request" });
          return;
        }
        const result = await saveAuthRebased(saveDeps, vet.doc.path, baseText, edits);
        sendSaveResult(res, result);
        return;
      }

      // Classic path: models.json always, auth.json without structured
      // edits (the raw tab's full-text save).
      const text = body["text"];
      const baseSha256 = body["baseSha256"];
      if (typeof text !== "string" || typeof baseSha256 !== "string") {
        json(res, 400, { error: "bad_request" });
        return;
      }
      const baseIssues: Issue[] = Array.isArray(body["baseIssues"])
        ? (body["baseIssues"] as Issue[])
        : [];
      void baseIssues; // informational by design, exactly as in the sister app
      const result = await saveValidated(
        saveDeps,
        vet.doc.path,
        seedText(vet.doc.id),
        text,
        baseSha256,
      );
      sendSaveResult(res, result);
    },
  };
}
