import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

/**
 * Discovery of Pi's agent documents, following the layout pi documents: one
 * agent directory (`~/.pi/agent` by default, `%USERPROFILE%\.pi\agent` on
 * Windows, overridable via `PI_CODING_AGENT_DIR` or a `--agent-dir` flag)
 * holding the two managed documents `models.json` and `auth.json`, plus
 * read-only neighbours (`settings.json`, `mcp.json`, `keybindings.json`)
 * that are detected and listed but never edited.
 *
 * The module is pure: every filesystem read goes through the injected
 * `fsImpl` port and every platform/environment fact arrives via the input
 * arguments, so callers (the server layer, tests, a future desktop shell)
 * control side effects. The only eager node builtins here are `path` joins
 * and the `execFile` reference used as the default port of `findPiVersion`.
 */

export type DocId = "models" | "auth" | "settings" | "mcp" | "keybindings";

export interface PiDoc {
  id: DocId;
  path: string;
  kind: "models" | "auth" | "other";
  /** `false` for the `other` documents: detected read-only, never edited. */
  editable: boolean;
  exists: boolean;
}

/** Filesystem port; the server layer passes `node:fs` itself. */
export type FsImpl = Pick<typeof import("node:fs"), "existsSync" | "readdirSync">;

/** Child-process port for `findPiVersion` (promisified `execFile` shape). */
export type ExecFileImpl = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
) => Promise<{ stdout: string }>;

export interface DiscoverDocsInput {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** Pre-resolved agent dir; when absent, `resolveAgentDir` derives it. */
  agentDir?: string;
  fsImpl?: FsImpl;
}

/** One document slot in the agent directory, in report order. */
interface DocSpec {
  id: DocId;
  fileName: string;
  kind: PiDoc["kind"];
  editable: boolean;
  /** Managed docs are listed even when the file is absent (`exists: false`). */
  always: boolean;
}

const DOC_SPECS: readonly DocSpec[] = [
  { id: "models", fileName: "models.json", kind: "models", editable: true, always: true },
  { id: "auth", fileName: "auth.json", kind: "auth", editable: true, always: true },
  { id: "settings", fileName: "settings.json", kind: "other", editable: false, always: false },
  { id: "mcp", fileName: "mcp.json", kind: "other", editable: false, always: false },
  {
    id: "keybindings",
    fileName: "keybindings.json",
    kind: "other",
    editable: false,
    always: false,
  },
];

const VERSION_PROBE_TIMEOUT_MS = 5_000;

const defaultFs: FsImpl = { existsSync, readdirSync };

const execFileAsync = promisify(execFile);

function pathModule(platform: NodeJS.Platform): typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * Directory holding pi's agent documents. Resolution ladder: the
 * `--agent-dir` flag verbatim (the caller resolves it against the process
 * cwd before handing it in), else `$PI_CODING_AGENT_DIR`, else
 * `<home>/.pi/agent` — home from `USERPROFILE` on Windows and `HOME` on
 * POSIX. With neither home environment variable set we anchor at the
 * literal `~` so the path stays informative instead of throwing.
 */
export function resolveAgentDir(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  agentDirFlag?: string,
): string {
  if (agentDirFlag !== undefined) return agentDirFlag;
  if (env.PI_CODING_AGENT_DIR !== undefined) return env.PI_CODING_AGENT_DIR;
  const p = pathModule(platform);
  const home = platform === "win32" ? env.USERPROFILE : env.HOME;
  return p.join(home !== undefined ? home : "~", ".pi", "agent");
}

/**
 * Discover pi's agent documents inside the resolved agent dir. Order:
 * `models`, `auth`, then `settings`, `mcp`, `keybindings`. The two managed
 * documents are ALWAYS listed (`exists: false` when their file is absent,
 * ready to be seeded on first save); the read-only `other` documents appear
 * only when present. A missing or unreadable agent directory degrades to
 * "nothing present", never throws.
 */
export function discoverDocs(input: DiscoverDocsInput): { agentDir: string; docs: PiDoc[] } {
  const p = pathModule(input.platform);
  const fsImpl = input.fsImpl ?? defaultFs;
  const agentDir = input.agentDir ?? resolveAgentDir(input.platform, input.env);

  let present: Set<string>;
  try {
    present = new Set(fsImpl.readdirSync(agentDir).map(String));
  } catch {
    present = new Set();
  }

  const docs: PiDoc[] = [];
  for (const spec of DOC_SPECS) {
    const exists = present.has(spec.fileName);
    if (!exists && !spec.always) continue;
    docs.push({
      id: spec.id,
      path: p.join(agentDir, spec.fileName),
      kind: spec.kind,
      editable: spec.editable,
      exists,
    });
  }
  return { agentDir, docs };
}

/**
 * Best-effort `pi --version`. Returns the version string (e.g. "0.45.3") or
 * `null` when the binary is missing, times out (5 s cap), or prints
 * something unversion-like. This function never throws.
 */
export async function findPiVersion(execFileImpl?: ExecFileImpl): Promise<string | null> {
  const run: ExecFileImpl =
    execFileImpl ?? ((file, args, options) => execFileAsync(file, [...args], options));
  try {
    const { stdout } = await run("pi", ["--version"], {
      timeout: VERSION_PROBE_TIMEOUT_MS,
    });
    const match = String(stdout).match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}
