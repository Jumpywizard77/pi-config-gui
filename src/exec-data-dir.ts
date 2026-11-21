import { dirname } from "node:path";

/**
 * The directory that shipped `dist/` data (built UI, vendored schema) lives
 * UNDER, relative to the running executable. Release archives lay out
 * `<exe dir>/dist/ui` and `<exe dir>/dist/core/schema-bundled.json` next to
 * the Bun-compiled binary (see .github/workflows/release.yml); under plain
 * Node this is the node binary's own directory and the derived candidates do
 * not exist there, so they stay inert.
 *
 * `execPath` is the path to the executable FILE (`process.execPath` is a file
 * path, not a directory — joining `dist/` onto it directly would describe a
 * path INSIDE the executable). Every executable-relative ladder — the static
 * UI one (`static-dir.ts`) and the schema one (`core/schema.ts`) — derives
 * its candidate from this ONE helper, so the two can never disagree again.
 */
export function execDataDir(execPath: string = process.execPath): string {
  return dirname(execPath);
}
