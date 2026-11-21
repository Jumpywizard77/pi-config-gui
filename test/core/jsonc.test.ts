import { describe, expect, it } from "vitest";

import { applyPathEdits, parseJsonc } from "../../src/core/jsonc";

describe("core/jsonc", () => {
  const SAMPLE = `{
  // local provider registry, do not reorder
  "provider": {
    // Maya runs on the office GPU box
    "Maya": {
      "npm": "@ai-sdk/openai-compatible",
      "settings": {
        "baseURL": "http://127.0.0.1:8080/v1", // inline note
        "apiKey": "sk-test-maya"
      }
    },
    "Strata": {
      "npm": "@ai-sdk/openai-compatible",
      "settings": {
        "baseURL": "http://127.0.0.1:9090/v1"
      }
    }
  },
  "mcp": {}
}
`;

  it("applyPathEdits_setsNestedValue_shouldPreserveCommentsAndUntouchedRegionsByteIdentical", () => {
    const result = applyPathEdits(SAMPLE, [
      { path: ["provider", "Strata", "settings", "baseURL"], value: "http://127.0.0.1:9999/v1" },
    ]);

    expect(result).toContain("// local provider registry, do not reorder");
    expect(result).toContain("// Maya runs on the office GPU box");
    expect(result).toContain("// inline note");

    const beforeLines = SAMPLE.split("\n");
    const afterLines = result.split("\n");
    expect(afterLines).toHaveLength(beforeLines.length);
    const changed = beforeLines.flatMap((line, i) => (line === afterLines[i] ? [] : [i]));
    expect(changed).toHaveLength(1);
    expect(beforeLines[changed[0]]).toContain('"baseURL": "http://127.0.0.1:9090/v1"');
    expect(afterLines[changed[0]]).toContain('"baseURL": "http://127.0.0.1:9999/v1"');

    expect(parseJsonc(result).errors).toEqual([]);
  });

  it("applyPathEdits_withAwkwardBytes_shouldPreserveBomCrlfAndTrailingCommasOutsideEdits", () => {
    const body = [
      "{",
      '  "provider": {',
      '    "Maya": {',
      '      "settings": {',
      '        "baseURL": "http://127.0.0.1:8080/v1",',
      '        "apiKey": "sk-test-maya",',
      "      },",
      "    },",
      "  },",
      '  "mcp": {}',
      "}",
      "",
    ].join("\r\n");
    const input = "\uFEFF" + body;

    const result = applyPathEdits(input, [
      { path: ["provider", "Maya", "settings", "baseURL"], value: "http://127.0.0.1:8081/v1" },
    ]);

    expect(result.charCodeAt(0)).toBe(0xfeff);
    // Every LF still belongs to a CRLF pair, and the count is unchanged.
    expect((result.match(/\r\n/g) ?? []).length).toBe((input.match(/\r\n/g) ?? []).length);
    expect((result.match(/\n/g) ?? []).length).toBe((result.match(/\r\n/g) ?? []).length);
    // Trailing commas outside the edited line survive byte-identically.
    expect(result).toContain('"apiKey": "sk-test-maya",\r\n');
    expect(result).toContain("    },\r\n");

    const { value, errors } = parseJsonc(result);
    // Trailing commas may warn elsewhere, but must not produce hard errors here.
    expect(errors).toEqual([]);
    expect(value).toEqual({
      provider: {
        Maya: {
          settings: {
            baseURL: "http://127.0.0.1:8081/v1",
            apiKey: "sk-test-maya",
          },
        },
      },
      mcp: {},
    });
  });

  it("applyPathEdits_deletesPath_shouldRemoveKeyOnly", () => {
    const input = `{
  "$schema": "https://opencode.ai/config.json",
  "telemetry": false,
  "provider": {
    // this comment must survive
    "Maya": {
      "settings": {
        "baseURL": "http://127.0.0.1:8080/v1"
      }
    }
  }
}
`;

    const result = applyPathEdits(input, [{ path: ["telemetry"], value: undefined }]);

    expect(result).not.toContain("telemetry");
    expect(result).toContain("// this comment must survive");
    const remaining = input.split("\n").filter((line) => !line.includes('"telemetry"'));
    expect(result.split("\n")).toEqual(remaining);

    const { value, errors } = parseJsonc(result);
    expect(errors).toEqual([]);
    expect(value).toEqual({
      $schema: "https://opencode.ai/config.json",
      provider: { Maya: { settings: { baseURL: "http://127.0.0.1:8080/v1" } } },
    });
  });

  it("applyPathEdits_withMalformedDocument_shouldThrowWithParseIssuesAndNotReturnMangledText", () => {
    const malformed = "this is not json at all";

    let error: unknown;
    try {
      applyPathEdits(malformed, [{ path: ["provider"], value: { x: 1 } }]);
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message.length).toBeGreaterThan(0);
    expect(message).toContain("applyPathEdits");
    // Names at least one issue as line:col message (first InvalidSymbol is at 1:1).
    expect(message).toMatch(/\b1:1 \w/);
    // Diagnostics only — the document body must not be echoed back.
    expect(message).not.toContain(malformed);
  });

  it("parseJsonc_withTrailingComma_returnsValueAndNoHardErrors", () => {
    const { value, errors } = parseJsonc(`{
  "list": [1, 2, 3,],
  "nested": { "a": true, },
}`);

    expect(errors).toEqual([]);
    expect(value).toEqual({ list: [1, 2, 3], nested: { a: true } });
  });
});
