import { describe, expect, it } from "vitest";

import { parseJsonc } from "../../src/core/jsonc";
import type { JsonValue, PathEdit } from "../../src/core/types";
import { editInText } from "../../src/ui/editor-path";

/**
 * The UI editing primitive: surgical `PathEdit[]` application over JSONC
 * text, byte-identical outside the edited paths. These tests pin the
 * browser-facing `editInText` contract (a thin wrapper over the SAME
 * `core/jsonc` apply loop the server uses — per the Task 11 controller
 * ruling there is no second implementation to drift).
 *
 * Fork note: the sister test additionally pins `entryShape` (v1/v2 provider
 * containers) and `reasoningFromVariants` (opencode variants conversion);
 * those components are opencode-specific and not part of the portable layer,
 * so only the harness-independent `editInText` sections were copied.
 */

const DOC = [
  "{",
  "  // top-level comment must survive every edit",
  '  "$schema": "https://opencode.ai/config.json",',
  '  "provider": {',
  '    "Basalt": {',
  '      "npm": "@ai-sdk/openai-compatible",',
  '      "options": { "baseURL": "http://127.0.0.1:8080/v1" }, // inline comment',
  "    },",
  '    "Maya": {',
  '      "npm": "@ai-sdk/openai-compatible",',
  '      "options": { "baseURL": "http://127.0.0.1:8081/v1" },',
  "    },",
  "  },",
  '  "model": "Maya/glm-5.3",',
  "}",
  "",
].join("\n");

/** Exact byte slice of the untouched Basalt block (trailing comma included). */
const BASALT_BLOCK = [
  '    "Basalt": {',
  '      "npm": "@ai-sdk/openai-compatible",',
  '      "options": { "baseURL": "http://127.0.0.1:8080/v1" }, // inline comment',
  "    },",
].join("\n");

const MAYA_BLOCK = [
  '    "Maya": {',
  '      "npm": "@ai-sdk/openai-compatible",',
  '      "options": { "baseURL": "http://127.0.0.1:8081/v1" },',
  "    },",
].join("\n");

function providerIds(text: string): string[] {
  const { value, errors } = parseJsonc(text);
  expect(errors).toEqual([]);
  const root = value as { provider: { [k: string]: JsonValue } };
  return Object.keys(root.provider);
}

function rootOf(text: string): { [k: string]: JsonValue } {
  const { value, errors } = parseJsonc(text);
  expect(errors).toEqual([]);
  return value as { [k: string]: JsonValue };
}

describe("editInText", () => {
  it("editInText_addsNewProviderWithModel_shouldKeepOtherProvidersByteIdentical", () => {
    const strata: JsonValue = {
      npm: "@ai-sdk/openai-compatible",
      name: "Strata (local)",
      options: { baseURL: "http://127.0.0.1:8082/v1" },
      models: {
        "strata/Qwen3.8-flash": {
          name: "strata/Qwen3.8-flash",
          limit: { context: 128000, output: 8192 },
        },
      },
    };
    const result = editInText(DOC, [{ path: ["provider", "Strata"], value: strata }]);

    // Everything outside the inserted key stays byte-identical.
    expect(result).toContain(BASALT_BLOCK);
    expect(result).toContain(MAYA_BLOCK);
    expect(result).toContain("// top-level comment must survive every edit");
    expect(result).toContain('  "$schema": "https://opencode.ai/config.json",');
    expect(result).toContain('  "model": "Maya/glm-5.3",');

    // The new provider landed, in full, as the last key of `provider`.
    expect(providerIds(result)).toEqual(["Basalt", "Maya", "Strata"]);
    const { value } = parseJsonc(result);
    const root = value as { provider: { Strata: JsonValue } };
    expect(root.provider.Strata).toEqual(strata);

    // A no-op edit list is the identity.
    expect(editInText(DOC, [])).toBe(DOC);
  });

  it("editInText_renamesProviderId_removesOldKeyAddsNewBlock", () => {
    // The rename protocol the UI emits: delete-old + create-new PAIR in a
    // single editInText call (later edits then target the new key).
    const basalt: JsonValue = {
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "http://127.0.0.1:8080/v1" },
    };
    const pair: PathEdit[] = [
      { path: ["provider", "Basalt"], value: undefined },
      { path: ["provider", "BasaltRenamed"], value: basalt },
    ];
    const result = editInText(DOC, pair);

    // Old key gone, new key present with the same content.
    expect(result).not.toContain('"Basalt"');
    expect(result).toContain('"BasaltRenamed"');
    expect(providerIds(result)).toEqual(["Maya", "BasaltRenamed"]); // re-created at the end
    const { value } = parseJsonc(result);
    const root = value as { provider: { BasaltRenamed: JsonValue } };
    expect(root.provider.BasaltRenamed).toEqual(basalt);

    // Untouched neighbours keep their exact bytes, comments intact.
    expect(result).toContain(MAYA_BLOCK);
    expect(result).toContain("// top-level comment must survive every edit");
    expect(result).toContain('  "model": "Maya/glm-5.3",');
  });

  it("refuses to edit text with hard parse errors (the UI's parse guard)", () => {
    expect(() => editInText('{ "provider": { , } }', [{ path: ["provider"], value: {} }])).toThrow(
      /malformed JSONC/,
    );
  });
});

describe("add-row edit construction (Task 11 fix round 1)", () => {
  it("envAddRowEdit_persistsEmptyStringAtIndex_soTheRowRendersAndIsEditable", () => {
    // What "+ env var" must compile to: a "" written AT THE NEXT INDEX.
    // (The pre-fix button filtered the "" away: a silent no-op.)
    const result = editInText(DOC, [{ path: ["provider", "Basalt", "env", 0], value: "" }]);
    const root = rootOf(result);
    const basalt = (root.provider as { Basalt: JsonValue }).Basalt as { env?: JsonValue };
    expect(basalt.env).toEqual([""]); // absent `env` array is CREATED, row survives
    expect(result).toContain(MAYA_BLOCK); // neighbours still byte-identical
    expect(result).toContain("// top-level comment must survive every edit");

    // And a typed value lands at the same index (the row is editable).
    const typed = editInText(result, [{ path: ["provider", "Basalt", "env", 0], value: "OPENAI_API_KEY" }]);
    const typedBasalt = (rootOf(typed).provider as { Basalt: { env: JsonValue } }).Basalt;
    expect(typedBasalt.env).toEqual(["OPENAI_API_KEY"]);
  });

  it("headerAddRowEdit_persistsEmptyKeyEntry_soTheRowRendersAndIsEditable", () => {
    // What "+ header" compiles to: the "" placeholder key persisted (the
    // empty-key filter is for key-RENAME/removal rewrites, not for adding).
    const result = editInText(DOC, [{ path: ["provider", "Basalt", "headers", ""], value: "" }]);
    const root = rootOf(result);
    const basalt = (root.provider as { Basalt: { headers: JsonValue } }).Basalt;
    expect(basalt.headers).toEqual({ "": "" });
    expect(result).toContain(MAYA_BLOCK);

    const renamed = editInText(result, [
      {
        path: ["provider", "Basalt", "headers"],
        value: { "X-Api-Version": "" }, // rename rewrite drops the "" placeholder key
      },
    ]);
    const renamedBasalt = (rootOf(renamed).provider as { Basalt: { headers: JsonValue } }).Basalt;
    expect(renamedBasalt.headers).toEqual({ "X-Api-Version": "" });
  });
});
