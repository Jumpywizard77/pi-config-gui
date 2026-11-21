import { describe, expect, it } from "vitest";

import { validateAuthText } from "../../src/core/auth-schema";

describe("core/auth-schema validateAuthText", () => {
  it("shouldAcceptAPlainApiKeyEntry", () => {
    expect(validateAuthText(JSON.stringify({ anthropic: { type: "api_key", key: "sk-x", env: { A: "b" } } }))).toEqual([]);
  });

  it("shouldAcceptACommandKeyString", () => {
    // "!command" is just a string value to the validator (pi resolves it; we never execute it).
    expect(validateAuthText(JSON.stringify({ vault: { type: "api_key", key: "!security find-generic-password -w" } }))).toEqual([]);
  });

  it("shouldAcceptUnknownTypesAndUnknownFieldsWithoutComplaint", () => {
    // Review Focus 5: future pi auth shapes must validate clean so the GUI
    // renders them read-only instead of flagging them.
    expect(validateAuthText(JSON.stringify({ weird: { type: "oauth_future", blob: { any: [1] } } }))).toEqual([]);
  });

  it("shouldReportMissingKeyOnApiKeyEntry", () => {
    const issues = validateAuthText(JSON.stringify({ p: { type: "api_key" } }));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe("p.key");
  });

  it("shouldReportNonStringKeyOnApiKeyEntry", () => {
    const issues = validateAuthText(JSON.stringify({ p: { type: "api_key", key: 42 } }));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe("p.key");
  });

  it("shouldReportNonStringEnvValues", () => {
    const issues = validateAuthText(JSON.stringify({ p: { type: "api_key", key: "k", env: { A: 1 } } }));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe("p.env");
  });

  it("shouldReportNonObjectEntry", () => {
    const issues = validateAuthText(JSON.stringify({ p: "sk-openai-style-bare-string" }));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe("p");
  });

  it("shouldReportMissingOrNonStringType", () => {
    expect(validateAuthText(JSON.stringify({ p: { key: "k" } })).map((issue) => issue.path)).toEqual(["p.type"]);
    expect(validateAuthText(JSON.stringify({ p: { type: 7, key: "k" } })).map((issue) => issue.path)).toEqual(["p.type"]);
  });

  it("shouldReportOneRootIssueForNonObjectTopLevels", () => {
    for (const bad of ["[1,2]", '"scalar"', "42", "null"]) {
      const issues = validateAuthText(bad);
      expect(issues).toHaveLength(1);
      expect(issues[0]!.path).toBe("");
    }
  });

  it("shouldPassThroughParseErrorsAsItsIssues", () => {
    const issues = validateAuthText("{ \"anthropic\": {\"type\": ");
    expect(issues.length).toBeGreaterThan(0);
  });

  it("shouldAcceptJsoncCommentsAndTrailingCommas", () => {
    const text = `// managed by pi\n{\n  "anthropic": { "type": "api_key", "key": "sk-x" },\n}\n`;
    expect(validateAuthText(text)).toEqual([]);
  });
});
