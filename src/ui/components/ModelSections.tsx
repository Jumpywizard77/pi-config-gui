import type { JsonValue, PathEdit } from "../../core/types";

/**
 * Task 11 MOUNT POINT (intentional stub). Task 10 wires the provider editor's
 * Models + modelOverrides sections through this component so the tree
 * compiles today; Task 11 REPLACES this file with the real model editors
 * (per the plan's Task 11 Files list) and consumes `onEdits` with the same
 * pending-`PathEdit[]` contract the provider fields already use.
 */
export interface ModelSectionsProps {
  providerId: string;
  /** The provider's `models` ARRAY (pi's shape), or undefined when absent. */
  models: JsonValue | undefined;
  /** The provider's `modelOverrides` map, or undefined when absent. */
  overrides: JsonValue | undefined;
  onEdits: (edits: PathEdit[]) => void;
}

export function ModelSections(_props: ModelSectionsProps) {
  return (
    <div className="model-sections">
      <span className="field-label">Models &amp; modelOverrides</span>
      <div className="hint">
        The structured model editor arrives in Task 11. Model entries are untouched by this
        tab&rsquo;s provider edits — until then, edit them in the Raw JSON tab.
      </div>
    </div>
  );
}
