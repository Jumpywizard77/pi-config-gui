import { describe, expect, it } from "vitest";

import { classifyKey, envVarNames, resolveEnvKey } from "../../src/core/keyref";

describe("core/keyref classifyKey", () => {
  it("classifiesBangPrefixedAsCommand", () => {
    expect(classifyKey("!security find-generic-password")).toBe("command");
  });

  it("classifiesBareBangAsCommand", () => {
    expect(classifyKey("!")).toBe("command");
  });

  it("classifiesDollarDollarEscapeAsLiteral", () => {
    expect(classifyKey("$$literal")).toBe("literal");
  });

  it("classifiesDollarBangEscapeAsLiteral", () => {
    expect(classifyKey("$!")).toBe("literal");
  });

  it("classifiesPlainStringAsLiteral", () => {
    expect(classifyKey("sk-abc123")).toBe("literal");
    expect(classifyKey("")).toBe("literal");
  });

  it("classifiesValueWithUnescapedDollarAsEnv", () => {
    expect(classifyKey("sk-$KEY$OTHER")).toBe("env");
    expect(classifyKey("${NAME}")).toBe("env");
    expect(classifyKey("pre-$NAME")).toBe("env");
  });
});

describe("core/keyref envVarNames", () => {
  it("extractsDollarNamesInOrder", () => {
    expect(envVarNames("sk-$KEY$OTHER")).toEqual(["KEY", "OTHER"]);
  });

  it("extractsBraceNames", () => {
    expect(envVarNames("pre-${NAME}-post")).toEqual(["NAME"]);
    expect(envVarNames("$A${B}C")).toEqual(["A", "B"]);
  });

  it("honorsEscapes", () => {
    expect(envVarNames("$$NOT_A_VAR")).toEqual([]);
    expect(envVarNames("$!$REAL")).toEqual(["REAL"]);
  });

  it("returnsEmptyForLiterals", () => {
    expect(envVarNames("sk-abc123")).toEqual([]);
    expect(envVarNames("")).toEqual([]);
  });
});

describe("core/keyref resolveEnvKey", () => {
  it("substitutesPresentVars", () => {
    expect(resolveEnvKey("pre-$NAME", { NAME: "X" })).toEqual({ ok: true, key: "pre-X" });
  });

  it("substitutesBraceAndMultipleVars", () => {
    expect(resolveEnvKey("sk-$KEY$OTHER", { KEY: "a", OTHER: "b" })).toEqual({ ok: true, key: "sk-ab" });
    expect(resolveEnvKey("${A}-${B}", { A: "1", B: "2" })).toEqual({ ok: true, key: "1-2" });
  });

  it("unescapesDollarDollarAndDollarBang", () => {
    expect(resolveEnvKey("$$literal$!", {})).toEqual({ ok: true, key: "$literal!" });
  });

  it("reportsMissingVars", () => {
    expect(resolveEnvKey("pre-$NAME", { NAME: undefined })).toEqual({ ok: false, missing: ["NAME"] });
    expect(resolveEnvKey("$A$B", { A: "x" })).toEqual({ ok: false, missing: ["B"] });
  });

  it("passesLiteralsThrough", () => {
    expect(resolveEnvKey("sk-plain", {})).toEqual({ ok: true, key: "sk-plain" });
  });
});
