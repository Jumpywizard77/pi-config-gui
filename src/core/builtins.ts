/**
 * Provider ids pi ships as built-ins, for autocomplete when naming a new
 * `models.json` provider. Sourced from pi's `docs/providers.md`
 * (docs.pi.dev/latest/providers) as of 2026-11-21. Staleness is tolerated:
 * this list only suggests names, it never gates or validates them — a newer
 * pi may know providers missing here, and custom providers are always legal.
 *
 * The qwen/xiaomi token-plan ids are derived from the provider names and
 * env-var names in that doc's table (QWEN_TOKEN_PLAN_*_API_KEY,
 * XIAOMI[_TOKEN_PLAN_*]_API_KEY); verify against pi if autocomplete drifts.
 */
export const BUILTIN_PROVIDER_IDS: readonly string[] = [
  "anthropic",
  "openai",
  "gemini",
  "azure",
  "amazon-bedrock",
  "google-vertex",
  "mistral",
  "groq",
  "cerebras",
  "xai",
  "openrouter",
  "vercel-ai-gateway",
  "github-copilot",
  "deepseek",
  "nvidia-nim",
  "hugging-face",
  "fireworks",
  "together",
  "baseten",
  "kimi",
  "meta",
  "minimax",
  "moonshot",
  "typesafe",
  "radius",
  "zai",
  "opencode",
  // Qwen Token Plan variants (Team / Individual, global + CN)
  "qwen-token-plan-team",
  "qwen-token-plan-team-cn",
  "qwen-token-plan-individual",
  "qwen-token-plan-individual-cn",
  // Xiaomi MiMo variants (direct + CN / Amsterdam / Singapore token plans)
  "xiaomi",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-sgp",
];
