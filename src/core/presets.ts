/**
 * Presets for the "add a local endpoint" hero flow: one-click starting points
 * for the common self-hosted OpenAI-compatible servers. The `apiKey` values
 * are placeholders — these servers accept (or ignore) any key unless started
 * with an explicit `--api-key`; the auth UI lets the user replace them.
 */

export interface LocalPreset {
  id: string;
  label: string;
  baseUrl: string;
  api: string;
  apiKey: string;
}

export const LOCAL_PRESETS: readonly LocalPreset[] = [
  {
    id: "ollama",
    label: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    api: "openai-completions",
    apiKey: "ollama",
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    api: "openai-completions",
    apiKey: "lmstudio",
  },
  {
    id: "vllm",
    label: "vLLM",
    baseUrl: "http://localhost:8000/v1",
    api: "openai-completions",
    apiKey: "vllm",
  },
  {
    // pi's llama.cpp docs (docs.pi.dev/latest/llama-cpp, checked 2026-11-21)
    // state the `llama serve` router's "default URL is http://127.0.0.1:9931"
    // (env override LLAMA_BASE_URL; API key optional via LLAMA_API_KEY), so
    // this uses port 9931 rather than the plan's 8080 fallback. Models are
    // managed through pi's /llama command; the placeholder key stands in for
    // the optional --api-key.
    id: "llamacpp",
    label: "llama.cpp router",
    baseUrl: "http://127.0.0.1:9931/v1",
    api: "openai-completions",
    apiKey: "llamacpp",
  },
  {
    id: "generic",
    label: "Custom endpoint",
    baseUrl: "",
    api: "openai-completions",
    apiKey: "",
  },
];
