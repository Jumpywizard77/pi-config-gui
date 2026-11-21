/**
 * The structured editors' browser-side editing primitive.
 *
 * This module deliberately contains NO editing logic of its own: it
 * re-exports the server's apply loop from `core/jsonc` (which imports only
 * `jsonc-parser` — browser-safe, Vite bundles it), so UI edits and server
 * edits are byte-for-byte identical BY CONSTRUCTION. (This replaces the
 * plan's "UI copy of the apply loop" per the Task 11 controller ruling:
 * no second implementation can drift out of sync.)
 */
import { applyPathEdits } from "../core/jsonc";
import type { PathEdit } from "../core/types";

export { applyPathEdits } from "../core/jsonc";
export type { PathEdit } from "../core/types";

/**
 * Apply `edits` (in order, each resolved against the running text) to a
 * JSONC document, leaving every byte outside the edited paths untouched.
 *
 * Contract (inherited from `applyPathEdits`): THROWS an `Error` on text
 * that has hard parse errors — the Providers tab must therefore refuse to
 * edit configs that do not parse cleanly (see `parseJsonc` in App/the tab)
 * and still wrap calls defensively.
 */
export function editInText(text: string, edits: PathEdit[]): string {
  return applyPathEdits(text, edits);
}
