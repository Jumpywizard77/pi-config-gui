import { describe, expect, it } from "vitest";

import { parseJsonc } from "../../src/core/jsonc";
import { LOCAL_PRESETS } from "../../src/core/presets";
import { classifyKey } from "../../src/core/keyref";
import {
  addProviderEdits,
  envRefName,
  escapeLiteralDollar,
  isLocalhostUrl,
  parseProviders,
} from "../../src/ui/provider-logic";

/**
 * Pure-logic pins for the Providers tab (Task 10). Components are compile-only
 * here (no DOM testing lib in the fork — same depth as the sister test/ui).
 */

const ollamaPreset = LOCAL_PRESETS.find((preset) => preset.id === "ollama")!;
const genericPreset = LOCAL_PRESETS.find((preset) => preset.id === "generic")!;

describe("parseProviders", () => {
  // A realistic commented models.json: // comments, a trailing comma, a
  // builtin reroute (anthropic with ONLY baseUrl), a non-object entry, and a
  // custom provider carrying models (ARRAY per pi's schema) + overrides.
  const commented = `{
  // pi models config
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": {
    // reroutes a built-in endpoint
    "anthropic": { "baseUrl": "https://proxy.example.com" },
    "myllm": {
      "name": "My LLM",
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "\$MY_KEY",
      "models": [{ "id": "a" }, { "id": "b" }],
      "modelOverrides": { "a": { "contextWindow": 10 }, "b": {} },
    }, // trailing comma on purpose
    "broken": "not-an-object",
  }
}`;

  it("parses a commented document and surfaces fields + counts + flags", () => {
    const { value, errors } = parseJsonc(commented);
    expect(errors).toEqual([]);
    const views = parseProviders(value!);
    expect(views.map((view) => view.id)).toEqual(["anthropic", "myllm", "broken"]);

    const anthropic = views[0]!;
    expect(anthropic.builtinReroute).toBe(true);
    expect(anthropic.baseUrl).toBe("https://proxy.example.com");
    expect(anthropic.modelCount).toBe(0);
    expect(anthropic.overrideCount).toBe(0);
    expect(anthropic.shapeError).toBeUndefined();

    const myllm = views[1]!;
    expect(myllm.name).toBe("My LLM");
    expect(myllm.baseUrl).toBe("http://localhost:11434/v1");
    expect(myllm.api).toBe("openai-completions");
    expect(myllm.apiKey).toBe("$MY_KEY");
    expect(myllm.builtinReroute).toBe(false);
    expect(myllm.modelCount).toBe(2);
    expect(myllm.overrideCount).toBe(2);

    // Non-object entries are flagged for read-only rendering, never dropped.
    const broken = views[2]!;
    expect(broken.shapeError).toBe(true);
    expect(broken.modelCount).toBe(0);
    expect(broken.overrideCount).toBe(0);
  });

  it("returns [] for non-object documents and missing providers blocks", () => {
    expect(parseProviders(null)).toEqual([]);
    expect(parseProviders([])).toEqual([]);
    expect(parseProviders({})).toEqual([]);
    expect(parseProviders({ providers: "nope" })).toEqual([]);
  });

  it("tolerates non-string scalar fields (surfaced as undefined, not garbage)", () => {
    const views = parseProviders({ providers: { x: { name: 7, baseUrl: null } } });
    expect(views[0]!.name).toBeUndefined();
    expect(views[0]!.baseUrl).toBeUndefined();
  });
});

describe("addProviderEdits", () => {
  it("preset create writes path [providers, id] with baseUrl/api/apiKey", () => {
    expect(addProviderEdits("ollama", ollamaPreset)).toEqual([
      {
        path: ["providers", "ollama"],
        value: {
          baseUrl: "http://localhost:11434/v1",
          api: "openai-completions",
          apiKey: "ollama",
        },
      },
    ]);
  });

  it("free id with no preset yields an empty {} entry", () => {
    expect(addProviderEdits("my-endpoint", null)).toEqual([
      { path: ["providers", "my-endpoint"], value: {} },
    ]);
  });

  it("preset fields that are empty strings are omitted (generic preset)", () => {
    expect(addProviderEdits("custom-1", genericPreset)).toEqual([
      { path: ["providers", "custom-1"], value: { api: "openai-completions" } },
    ]);
  });
});

describe("apiKey $NAME helpers", () => {
  it("envRefName extracts the name of a whole-value $NAME / ${NAME} key", () => {
    expect(envRefName("$MY_KEY")).toBe("MY_KEY");
    expect(envRefName("${MY_KEY}")).toBe("MY_KEY");
    expect(envRefName("literal")).toBeNull();
    expect(envRefName("$$FOO")).toBeNull(); // escaped: a literal, not a ref
    expect(envRefName("prefix $FOO")).toBeNull(); // not the WHOLE value
    expect(envRefName("$FOO suffix")).toBeNull();
  });

  it("escapeLiteralDollar turns any value into a classifyKey-literal", () => {
    expect(escapeLiteralDollar("$FOO")).toBe("$$FOO");
    expect(classifyKey(escapeLiteralDollar("$FOO"))).toBe("literal");
    expect(escapeLiteralDollar("plain")).toBe("plain");
  });
});

describe("isLocalhostUrl", () => {
  it("recognizes loopback http(s) URLs (the auto-probe gate)", () => {
    expect(isLocalhostUrl("http://localhost:11434/v1")).toBe(true);
    expect(isLocalhostUrl("http://127.0.0.1:9931/v1")).toBe(true);
    expect(isLocalhostUrl("http://[::1]:8000/v1")).toBe(true);
    expect(isLocalhostUrl("http://mybox.localhost:1234/v1")).toBe(true);
    expect(isLocalhostUrl("https://api.anthropic.com")).toBe(false);
    expect(isLocalhostUrl("not a url")).toBe(false);
    expect(isLocalhostUrl("")).toBe(false);
  });
});
