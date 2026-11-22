import { describe, expect, it } from "vitest";

import type { JsonValue } from "../../src/core/types";
import {
  conflictNotice,
  deleteEntryEdits,
  keyFormBadge,
  parseAuthDoc,
  setEntryEdits,
} from "../../src/ui/auth-logic";

/**
 * Pure-logic pins for the API Keys tab (Task 12). Components are compile-only
 * here (no DOM testing lib in the fork — same depth as the sister test/ui).
 */

const doc = (text: string): JsonValue => JSON.parse(text) as JsonValue;

describe("parseAuthDoc", () => {
  const mixed = doc(
    `{
      "github-copilot": { "type": "oauth", "token": "T1", "refresh": { "nested": true } },
      "anthropic": { "type": "api_key", "key": "sk-ant-1", "env": { "ACCOUNT_ID": "acct-9" } },
      "zebra": { "type": "api_key" },
      "device": { "type": "device_code", "device_id": "d1" },
      "broken": "not-an-object",
      "alsoBroken": [1, 2],
      "nullish": null,
      "noType": { "key": "sk-orphan" },
      "numericType": { "type": 7 }
    }`,
  );

  it("classifies every entry shape and sorts rows alphabetically by id", () => {
    const views = parseAuthDoc(mixed);
    expect(views.map((view) => view.id)).toEqual([
      "alsoBroken",
      "anthropic",
      "broken",
      "device",
      "github-copilot",
      "noType",
      "nullish",
      "numericType",
      "zebra",
    ]);
    const byId = new Map(views.map((view) => [view.id, view]));

    // Documented api_key entries are editable, carrying key + env.
    expect(byId.get("anthropic")).toEqual({
      id: "anthropic",
      kind: "api_key",
      key: "sk-ant-1",
      env: { ACCOUNT_ID: "acct-9" },
      extra: false,
    });
    // api_key WITHOUT a key stays editable (the validator's new_issues copy
    // explains why the server would refuse the save).
    expect(byId.get("zebra")).toEqual({ id: "zebra", kind: "api_key", env: {}, extra: false });

    // Unknown credential types → read-only rows, never blocked or dropped.
    expect(byId.get("github-copilot")).toEqual({
      id: "github-copilot",
      kind: "readonly",
      type: "oauth",
    });
    expect(byId.get("device")).toEqual({ id: "device", kind: "readonly", type: "device_code" });

    // Non-object entries and objects without a string `type` → shape_error.
    for (const id of ["broken", "alsoBroken", "nullish", "noType", "numericType"]) {
      expect(byId.get(id)).toEqual({ id, kind: "shape_error" });
    }
  });

  it("tolerates malformed key/env fields inside api_key entries", () => {
    const views = parseAuthDoc(
      doc(
        `{ "a": { "type": "api_key", "key": 42, "env": { "GOOD": "v", "BAD": 7, "OBJ": {} } },
           "b": { "type": "api_key", "env": "not-an-object" } }`,
      ),
    );
    // A non-string `key` reads as absent; env keeps only its string values
    // (the permissive auth-schema validator owns the blocking copy). Both
    // rows are flagged `extra` — the non-string env values (and b's
    // non-object env) are fields the structured editor does not model.
    expect(views[0]).toEqual({ id: "a", kind: "api_key", env: { GOOD: "v" }, extra: true });
    expect(views[1]).toEqual({ id: "b", kind: "api_key", env: {}, extra: true });
  });

  it("flags unmodeled fields via extra (false for a purely modeled entry)", () => {
    const views = parseAuthDoc(
      doc(
        `{ "plain": { "type": "api_key", "key": "sk-1" },
           "withHeaders": { "type": "api_key", "key": "sk-1", "headers": {} },
           "numericEnv": { "type": "api_key", "env": { "X": 5 } } }`,
      ),
    );
    const byId = new Map(views.map((view) => [view.id, view]));
    // Fully modeled (type + key only): no warning.
    expect(byId.get("plain")).toEqual({
      id: "plain",
      kind: "api_key",
      key: "sk-1",
      env: {},
      extra: false,
    });
    // Own key beyond type/key/env → warned (still editable, brief-mandated).
    const withHeaders = byId.get("withHeaders");
    expect(withHeaders !== undefined && withHeaders.kind === "api_key" && withHeaders.extra).toBe(true);
    // A non-string env value the parser filters out → warned.
    const numericEnv = byId.get("numericEnv");
    expect(numericEnv !== undefined && numericEnv.kind === "api_key" && numericEnv.extra).toBe(true);
  });

  it("returns no rows for a non-object document", () => {
    expect(parseAuthDoc(doc("[]"))).toEqual([]);
    expect(parseAuthDoc(doc("null"))).toEqual([]);
    expect(parseAuthDoc(doc(`"text"`))).toEqual([]);
  });

  it("returns no rows for an empty object", () => {
    expect(parseAuthDoc(doc("{}"))).toEqual([]);
  });
});

describe("setEntryEdits", () => {
  it("emits exactly ONE full-entry rewrite at the top level, never touching siblings", () => {
    const edits = setEntryEdits("anthropic", {
      key: "sk-new",
      env: { ACCOUNT_ID: "acct-9" },
    });
    // Review Focus 5: untouched entries are simply never addressed — the
    // server rebase keeps them byte-stable. One edit, path ["anthropic"].
    expect(edits).toHaveLength(1);
    expect(edits[0]!.path).toEqual(["anthropic"]);
    expect(edits[0]!.value).toEqual({
      type: "api_key",
      key: "sk-new",
      env: { ACCOUNT_ID: "acct-9" },
    });
    // No nested paths reach into the entry: the rewrite is the whole entry.
    expect(edits.every((edit) => edit.path.length === 1)).toBe(true);
  });

  it("omits key when undefined and omits an empty/absent env", () => {
    expect(setEntryEdits("zeta", {})).toStrictEqual([
      { path: ["zeta"], value: { type: "api_key" } },
    ]);
    expect(setEntryEdits("zeta", { key: "k", env: {} })).toStrictEqual([
      { path: ["zeta"], value: { type: "api_key", key: "k" } },
    ]);
    // An EMPTY-STRING key is still a string — passed through verbatim
    // (permissive validator: shape-legal; the UI clears fields to undefined).
    expect(setEntryEdits("zeta", { key: "" })).toStrictEqual([
      { path: ["zeta"], value: { type: "api_key", key: "" } },
    ]);
  });

  it("ignores previous: the rewrite carries only the fields the entry model knows", () => {
    // Documented lossy edge (see report): editing an api_key entry that
    // carries EXTRA unknown fields rewrites it from type/key/env.
    const edits = setEntryEdits(
      "anthropic",
      { key: "sk-new" },
      { id: "anthropic", kind: "api_key", key: "sk-old", env: {}, extra: false },
    );
    expect(edits[0]!.value).toEqual({ type: "api_key", key: "sk-new" });
  });
});

describe("deleteEntryEdits", () => {
  it("emits one top-level delete with value undefined", () => {
    const edits = deleteEntryEdits("github-copilot");
    expect(edits).toHaveLength(1);
    expect(edits[0]!.path).toEqual(["github-copilot"]);
    expect("value" in edits[0]!).toBe(true);
    expect(edits[0]!.value).toBeUndefined();
  });
});

describe("conflictNotice", () => {
  it("names the clashed entries and states the edits were not applied", () => {
    const notice = conflictNotice(["anthropic", "github-copilot"]);
    expect(notice).toContain("anthropic");
    expect(notice).toContain("github-copilot");
    expect(notice).toContain("auth.json");
    expect(notice).toMatch(/not (been )?saved/i);
  });

  it("names a single entry without inventing others", () => {
    const notice = conflictNotice(["openai"]);
    expect(notice).toContain("openai");
    expect(notice).not.toContain("anthropic");
  });
});

describe("keyFormBadge", () => {
  it("maps the three pi key forms to their display badges", () => {
    expect(keyFormBadge("literal")).toBe("literal");
    expect(keyFormBadge("env")).toBe("$ENV");
    expect(keyFormBadge("command")).toBe("!command");
  });
});
