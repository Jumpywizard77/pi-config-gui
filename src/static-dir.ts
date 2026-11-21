import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { execDataDir } from "./exec-data-dir.js";

/**
 * Static-UI directory resolution, extracted from `cli.ts` so the candidate
 * ladder is unit-testable (and so importing it has no side effects).
 * Injectable deps exist purely for tests.
 */
export interface StaticDirDeps {
  /** Anchor URL for the package-root candidate; defaults to the module's own. */
  importMetaUrl?: string;
  /** Defaults to `process.execPath`. */
  execPath?: string;
  /** Directory-existence probe; defaults to `existsSync`. */
  exists?: (path: string) => boolean;
}

/**
 * Candidate `dist/ui` directories, ordered old-path-first, first EXISTING one
 * wins:
 *  - `--static` (verbatim, when given — the only candidate then);
 *  - for `node dist/cli.js` / the npm bin: this module sits in <package>/dist,
 *    so the package root is one up from the anchor URL;
 *  - for a Bun-compiled single-file binary (see .github/workflows/release.yml):
 *    the module URL points INSIDE the executable's embedded virtual FS
 *    (`bunfs:///` or `file:///<drive>:\~BUN\...`), so the release archive
 *    instead ships `dist/ui` next to the binary itself — the candidate is the
 *    shared `execDataDir` (dirname of the executable FILE) plus `dist/ui`.
 *    Under plain Node this candidate is just <node dir>/dist/ui, which does
 *    not exist, so it is inert there.
 *
 * The anchor-URL candidate's CONSTRUCTION is guarded, not just its use:
 * `fileURLToPath` THROWS on a `bunfs:///` scheme, and an unguarded throw would
 * crash startup before the executable-relative candidate is ever consulted —
 * the opposite of the ladder's purpose. A throwing candidate contributes
 * nothing instead.
 */
export function staticDirCandidates(
  staticFlag: string | undefined,
  deps: StaticDirDeps = {},
): string[] {
  if (staticFlag !== undefined) {
    return [resolve(staticFlag)];
  }
  const candidates: string[] = [join(execDataDir(deps.execPath ?? process.execPath), "dist", "ui")];
  try {
    candidates.unshift(
      join(fileURLToPath(new URL("..", deps.importMetaUrl ?? import.meta.url)), "dist", "ui"),
    );
  } catch {
    // anchor URL not convertible to a path (compiled-binary virtual FS):
    // contribute no candidate for it; the executable-relative one remains
  }
  return candidates;
}

/** The first candidate that exists, or undefined (static serving stays off). */
export function resolveStaticDir(
  staticFlag: string | undefined,
  deps: StaticDirDeps = {},
): string | undefined {
  const exists = deps.exists ?? existsSync;
  return staticDirCandidates(staticFlag, deps).find((candidate) => exists(candidate));
}
