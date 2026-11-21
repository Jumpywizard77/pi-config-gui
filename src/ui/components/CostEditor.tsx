import type { JsonValue, PathEdit } from "../../core/types";

type Obj = { [k: string]: JsonValue };

function isObj(value: JsonValue | undefined): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface CostEditorProps {
  /** The stored `cost` object (`undefined` = absent). */
  cost: JsonValue | undefined;
  /** Path of the entry's `cost` object; parents are created on first write. */
  costPath: (string | number)[];
  apply: (edits: PathEdit[]) => void;
}

/** Required numeric fields of one `cost.tiers[i]` row, in schema order. */
const TIER_FIELDS = ["inputTokensAbove", "input", "output", "cacheRead", "cacheWrite"] as const;

/**
 * pi's `cost` block: four USD-per-million-tokens prices plus optional
 * request-wide `tiers` rows (`inputTokensAbove|input|output|cacheRead|
 * cacheWrite`, all five required by the schema — a new row starts at zeros
 * so it validates immediately). Field edits are path-addressed; clearing a
 * number deletes the key; [delete cost] deletes the whole object. Used by
 * both model entries and modelOverrides entries (identical shape).
 */
export function CostEditor({ cost, costPath, apply }: CostEditorProps) {
  const costObj = isObj(cost) ? cost : undefined;
  const tiers: JsonValue[] = Array.isArray(costObj?.["tiers"]) ? (costObj["tiers"] as JsonValue[]) : [];

  const setField = (key: string, value: JsonValue | undefined): void => {
    apply([{ path: [...costPath, key], value }]);
  };

  return (
    <div className="kv-block">
      <div className="cost-head">
        <span className="field-label">cost — USD per million tokens</span>
        {costObj !== undefined && (
          <button type="button" onClick={() => apply([{ path: costPath, value: undefined }])}>
            delete cost
          </button>
        )}
      </div>
      <div className="field-grid cost-grid">
        {(["input", "output", "cacheRead", "cacheWrite"] as const).map((key) => (
          <label key={key}>
            <span className="field-label">{key}</span>
            <NumInput
              value={costObj?.[key]}
              integerOnly={false}
              onChange={(next) => setField(key, next)}
            />
          </label>
        ))}
      </div>

      <span className="field-label">tiers (highest matching inputTokensAbove applies to the full request)</span>
      {tiers.map((tier, index) => {
        const tierObj = isObj(tier) ? tier : {};
        return (
          <div className="tier-row" key={index}>
            {TIER_FIELDS.map((field) => (
              <label key={field}>
                <span className="field-label">{field}</span>
                <NumInput
                  value={tierObj[field]}
                  integerOnly={field === "inputTokensAbove"}
                  onChange={(next) =>
                    apply([{ path: [...costPath, "tiers", index, field], value: next }])
                  }
                />
              </label>
            ))}
            <button
              type="button"
              title="delete tier"
              onClick={() =>
                // Deleting the last row removes `tiers` entirely instead of
                // leaving `"tiers": []` debris.
                apply(
                  tiers.length === 1
                    ? [{ path: [...costPath, "tiers"], value: undefined }]
                    : [{ path: [...costPath, "tiers", index], value: undefined }],
                )
              }
            >
              ✕
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() =>
          apply([
            {
              // Out-of-range index → jsonc-parser appends (see model-logic).
              path: [...costPath, "tiers", -1],
              value: { inputTokensAbove: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ])
        }
      >
        + tier
      </button>
    </div>
  );
}

/** Number input: blank deletes the key; partial/invalid input is ignored. */
export function NumInput({
  value,
  onChange,
  integerOnly,
}: {
  value: JsonValue | undefined;
  onChange: (next: JsonValue | undefined) => void;
  integerOnly: boolean;
}) {
  return (
    <input
      type="number"
      step={integerOnly ? 1 : "any"}
      value={typeof value === "number" ? String(value) : ""}
      onChange={(event) => {
        const raw = event.target.value.trim();
        if (raw === "") {
          onChange(undefined);
          return;
        }
        const ok = integerOnly ? /^-?\d+$/.test(raw) : /^-?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(raw);
        if (ok) onChange(Number(raw));
      }}
    />
  );
}
