import { describe, expect, it } from "vitest";

import { LOCAL_PRESETS } from "../../src/core/presets";
import { BUILTIN_PROVIDER_IDS } from "../../src/core/builtins";

describe("core/presets LOCAL_PRESETS", () => {
  it("hasNonEmptyIdLabelAndApiForEveryEntry", () => {
    expect(LOCAL_PRESETS.length).toBeGreaterThan(0);
    for (const preset of LOCAL_PRESETS) {
      expect(preset.id.length, `preset ${preset.id} id`).toBeGreaterThan(0);
      expect(preset.label.length, `preset ${preset.id} label`).toBeGreaterThan(0);
      expect(preset.api.length, `preset ${preset.id} api`).toBeGreaterThan(0);
    }
  });

  it("hasUniqueIds", () => {
    const ids = LOCAL_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("pinsTheDocumentedEndpointValues", () => {
    const byId = new Map(LOCAL_PRESETS.map((preset) => [preset.id, preset]));
    expect(byId.get("ollama")).toEqual({
      id: "ollama",
      label: "Ollama",
      baseUrl: "http://localhost:11434/v1",
      api: "openai-completions",
      apiKey: "ollama",
    });
    expect(byId.get("lmstudio")).toEqual({
      id: "lmstudio",
      label: "LM Studio",
      baseUrl: "http://localhost:1234/v1",
      api: "openai-completions",
      apiKey: "lmstudio",
    });
    expect(byId.get("vllm")).toEqual({
      id: "vllm",
      label: "vLLM",
      baseUrl: "http://localhost:8000/v1",
      api: "openai-completions",
      apiKey: "vllm",
    });
    // pi docs (docs.pi.dev/latest/llama-cpp): router default URL http://127.0.0.1:9931
    const llamacpp = byId.get("llamacpp");
    expect(llamacpp).toBeDefined();
    expect(llamacpp!.baseUrl).toBe("http://127.0.0.1:9931/v1");
    expect(llamacpp!.api).toBe("openai-completions");
    const generic = byId.get("generic");
    expect(generic).toEqual({
      id: "generic",
      label: expect.any(String),
      baseUrl: "",
      api: "openai-completions",
      apiKey: "",
    });
  });

  it("usesOpenaiCompletionsApiEverywhere", () => {
    for (const preset of LOCAL_PRESETS) {
      expect(preset.api).toBe("openai-completions");
    }
  });
});

describe("core/builtins BUILTIN_PROVIDER_IDS", () => {
  it("hasNonEmptyUniqueIds", () => {
    expect(BUILTIN_PROVIDER_IDS.length).toBeGreaterThan(0);
    for (const id of BUILTIN_PROVIDER_IDS) {
      expect(id.length).toBeGreaterThan(0);
      expect(id).toMatch(/^[a-z0-9-]+$/);
    }
    expect(new Set(BUILTIN_PROVIDER_IDS).size).toBe(BUILTIN_PROVIDER_IDS.length);
  });

  it("includesTheCoreBriefListIds", () => {
    for (const id of ["anthropic", "openai", "gemini", "azure", "amazon-bedrock", "google-vertex", "opencode", "radius"]) {
      expect(BUILTIN_PROVIDER_IDS).toContain(id);
    }
  });
});
