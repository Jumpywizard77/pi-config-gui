import { describe, expect, it } from "vitest";

import { parseJsonc } from "../../src/core/jsonc";
import { applyPathEdits } from "../../src/core/jsonc";
import {
  addModelEdits,
  addOverrideEdits,
  envKeyWarningText,
  isCommandKeyRejection,
  mergeImportEdits,
  planImportRows,
  renameModelEdits,
  renameOverrideEdits,
  setModelFieldEdits,
  setOverrideFieldEdits,
} from "../../src/ui/model-logic";

/**
 * Pure-logic pins for the model / modelOverrides editors (Task 11). No DOM
 * testing lib in the fork (sister standard) — components are compile-only;
 * everything decision-shaped lives in `src/ui/model-logic.ts`.
 *
 * The `models` container is an ARRAY of `{ id, … }` entries (pi schema). All
 * appends use the jsonc-parser out-of-range index sentinel `MODEL_APPEND`
 * (-1), which `modify` resolves to "append at end" — pinned end-to-end below
 * through the SAME `applyPathEdits` the UI runs.
 */

const DEFAULTS = { id: "b", contextWindow: 128000, maxTokens: 16384 };

describe("addModelEdits", () => {
  it("appends a bare {id} entry under the provider's models array", () => {
    expect(addModelEdits("p", "gpt-4o")).toEqual([
      { path: ["providers", "p", "models", -1], value: { id: "gpt-4o" } },
    ]);
  });

  it("applies to a document with no models array yet, creating it", () => {
    const text = `{
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": { "p": { "baseUrl": "http://x" } }
}`;
    const out = applyPathEdits(text, addModelEdits("p", "new-model"));
    const { value, errors } = parseJsonc(out);
    expect(errors).toEqual([]);
    expect((value as any).providers.p.models).toEqual([{ id: "new-model" }]);
    expect(out).toContain("$schema"); // surgical: sibling keys byte-stable
  });
});

describe("setModelFieldEdits", () => {
  it("addresses the array index + field", () => {
    expect(setModelFieldEdits("p", 1, "contextWindow", 200000)).toEqual([
      { path: ["providers", "p", "models", 1, "contextWindow"], value: 200000 },
    ]);
  });

  it("undefined deletes the path (brief pin: reasoning)", () => {
    const edits = setModelFieldEdits("p", 0, "reasoning", undefined);
    expect(edits).toEqual([{ path: ["providers", "p", "models", 0, "reasoning"], value: undefined }]);

    const text = `{"providers":{"p":{"models":[{"id":"a","reasoning":true},{"id":"b"}]}}}`;
    const out = applyPathEdits(text, edits);
    const { value } = parseJsonc(out);
    expect((value as any).providers.p.models[0]).toEqual({ id: "a" });
    // The sibling entry is untouched.
    expect((value as any).providers.p.models[1]).toEqual({ id: "b" });
  });

  it("numeric fields accept the plain number write", () => {
    const text = `{"providers":{"p":{"models":[{"id":"a"}]}}}`;
    const out = applyPathEdits(text, setModelFieldEdits("p", 0, "maxTokens", 8192));
    const { value } = parseJsonc(out);
    expect((value as any).providers.p.models[0].maxTokens).toBe(8192);
  });
});

describe("mergeImportEdits (binding merge rule: never overwrites)", () => {
  it("mergeImportEdits('p', ['a'], ['a','b']) is ONE edit adding b with defaults, none touching a", () => {
    const edits = mergeImportEdits("p", ["a"], ["a", "b"]);
    expect(edits).toEqual([
      { path: ["providers", "p", "models", -1], value: DEFAULTS },
    ]);
    expect(edits.some((edit) => JSON.stringify(edit.path).includes('"a"'))).toBe(false);
  });

  it("every already-present id is excluded; only genuinely-new models ride edits", () => {
    expect(mergeImportEdits("p", ["a", "b"], ["a", "b"])).toEqual([]);
    expect(mergeImportEdits("p", [], [])).toEqual([]);
    expect(mergeImportEdits("p", ["a", "b"], ["a", "c", "d"])).toEqual([
      { path: ["providers", "p", "models", -1], value: { id: "c", contextWindow: 128000, maxTokens: 16384 } },
      { path: ["providers", "p", "models", -1], value: { id: "d", contextWindow: 128000, maxTokens: 16384 } },
    ]);
  });

  it("duplicate picks collapse to one entry per id", () => {
    const edits = mergeImportEdits("p", [], ["x", "x", "y"]);
    expect(edits.map((edit) => (edit.value as { id: string }).id)).toEqual(["x", "y"]);
  });

  it("probe re-run on a commented doc appends unseen ids only; existing entries byte-stable, $schema and other providers untouched", () => {
    const text = `{
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": {
    // my local server
    "p": {
      "baseUrl": "http://localhost:11434/v1",
      "models": [
        { "id": "a", "contextWindow": 4096, "maxTokens": 512 } // hand-tuned limits
      ]
    },
    "other": { "models": [{ "id": "b" }] }
  }
}`;
    const out = applyPathEdits(text, mergeImportEdits("p", ["a"], ["a", "b"]));
    const { value, errors } = parseJsonc(out);
    expect(errors).toEqual([]);
    const models = (value as any).providers.p.models;
    expect(models).toHaveLength(2);
    expect(models[0]).toEqual({ id: "a", contextWindow: 4096, maxTokens: 512 });
    expect(models[1]).toEqual(DEFAULTS);
    // Other provider + $schema survive surgically.
    expect((value as any).providers.other).toEqual({ models: [{ id: "b" }] });
    expect((value as any).$schema).toBe("https://pi.dev/schemas/models.schema.json");
    expect(out).toContain("// my local server");
    expect(out).toContain("// hand-tuned limits");
  });

  it("import preserves the endpoint's own ordering", () => {
    const edits = mergeImportEdits("p", [], ["z", "y", "x"]);
    expect(edits.map((edit) => (edit.value as { id: string }).id)).toEqual(["z", "y", "x"]);
  });
});

describe("addOverrideEdits / setOverrideFieldEdits / renameOverrideEdits", () => {
  it("adds an empty override map entry under modelOverrides", () => {
    expect(addOverrideEdits("p", "gpt-4o")).toEqual([
      { path: ["providers", "p", "modelOverrides", "gpt-4o"], value: {} },
    ]);
  });

  it("field edits are path-addressed; undefined deletes", () => {
    expect(setOverrideFieldEdits("p", "m", "contextWindow", 10)).toEqual([
      { path: ["providers", "p", "modelOverrides", "m", "contextWindow"], value: 10 },
    ]);
    const text = `{"providers":{"p":{"modelOverrides":{"m":{"reasoning":true}}}}}`;
    const { value } = parseJsonc(applyPathEdits(text, setOverrideFieldEdits("p", "m", "reasoning", undefined)));
    expect((value as any).providers.p.modelOverrides.m).toEqual({});
  });

  it("rename is delete-old + create-new carrying the value over", () => {
    const edits = renameOverrideEdits("p", "old", { contextWindow: 7 }, "new");
    expect(edits).toEqual([
      { path: ["providers", "p", "modelOverrides", "old"], value: undefined },
      { path: ["providers", "p", "modelOverrides", "new"], value: { contextWindow: 7 } },
    ]);
  });

  it("deleting an override is a single delete edit", () => {
    expect(setOverrideFieldEdits("p", "m", "", undefined)).toEqual([
      { path: ["providers", "p", "modelOverrides", "m"], value: undefined },
    ]);
  });
});

describe("renameModelEdits (array key rename = delete + re-create at end)", () => {
  it("emits delete-at-index then append of the copy with the new id", () => {
    const model = { id: "old", contextWindow: 5 };
    const edits = renameModelEdits("p", 1, model, "new");
    expect(edits).toEqual([
      { path: ["providers", "p", "models", 1], value: undefined },
      { path: ["providers", "p", "models", -1], value: { id: "new", contextWindow: 5 } },
    ]);
  });

  it("applied to a document, the entry moves to the end with its fields, siblings intact", () => {
    const text = `{"providers":{"p":{"models":[{"id":"a"},{"id":"old","name":"Old"},{"id":"c"}]}}}`;
    const out = applyPathEdits(text, renameModelEdits("p", 1, { id: "old", name: "Old" }, "new"));
    const { value } = parseJsonc(out);
    expect((value as any).providers.p.models).toEqual([{ id: "a" }, { id: "c" }, { id: "new", name: "Old" }]);
  });
});

describe("planImportRows (review list state)", () => {
  it("pre-checks unseen ids only; already-present rows are flagged and unchecked", () => {
    const rows = planImportRows(["a", "b", "c"], ["b"]);
    expect(rows).toEqual([
      { id: "a", alreadyPresent: false, checked: true },
      { id: "b", alreadyPresent: true, checked: false },
      { id: "c", alreadyPresent: false, checked: true },
    ]);
  });

  it("dedupes the discovered list (first occurrence wins) and keeps endpoint order", () => {
    expect(planImportRows(["x", "y", "x"], []).map((row) => row.id)).toEqual(["x", "y"]);
  });

  it("an all-existing probe result checks nothing (re-run never re-imports)", () => {
    expect(planImportRows(["a"], ["a"]).every((row) => !row.checked)).toBe(true);
  });
});

describe("probe outcome display helpers", () => {
  it("isCommandKeyRejection recognizes the server's machine-readable 400 code", () => {
    expect(isCommandKeyRejection(new Error("POST /api/probe: HTTP 400 command_key"))).toBe(true);
    expect(isCommandKeyRejection(new Error("POST /api/probe: HTTP 404 nope"))).toBe(false);
    expect(isCommandKeyRejection("command_key")).toBe(true);
    expect(isCommandKeyRejection(null)).toBe(false);
  });

  it("envKeyWarningText names the unresolved keys probed without them", () => {
    expect(envKeyWarningText({ kind: "env_key_unresolved", names: ["FOO", "BAR"] })).toBe(
      "probed keyless — env key(s) not set on the server: FOO, BAR",
    );
    expect(envKeyWarningText(undefined)).toBeNull();
  });
});
