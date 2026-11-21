import { parseJsonc } from "./jsonc.js";
import type { Issue, JsonValue } from "./types.js";

/**
 * Hand-rolled, deliberately permissive validator for pi's `auth.json` (no
 * ajv: pi publishes no auth.json schema, and future pi versions keep adding
 * auth shapes — OAuth variants, device flows — that this GUI must render
 * read-only rather than flag; see Review Focus 5). The rules it enforces,
 * and the ONLY problems it reports:
 *
 * - the top level is a JSON object keyed by provider id (parse errors from
 *   the shared JSONC parser short-circuit to their Issues);
 * - every top-level value is an object with a string `type`;
 * - `type === "api_key"` additionally requires a string `key` (a literal
 *   key and a `"!command"` string are the same JSON type here — resolution
 *   and any execution belong to pi, never to this validator) and, when
 *   present, an `env` object whose every value is a string.
 *
 * Unknown `type` values and unknown fields produce no issues.
 */
export function validateAuthText(text: string): Issue[] {
  const { value, errors } = parseJsonc(text);
  if (errors.length > 0) return errors;

  if (!isJsonObject(value)) {
    return [{ path: "", message: "auth.json must contain a JSON object keyed by provider id" }];
  }

  const issues: Issue[] = [];
  for (const [id, entry] of Object.entries(value)) {
    if (!isJsonObject(entry)) {
      issues.push({ path: id, message: `${id} must be a JSON object describing one auth entry` });
      continue;
    }
    const type = entry["type"];
    if (typeof type !== "string") {
      issues.push({ path: `${id}.type`, message: `${id}.type must be a string naming the auth type` });
      continue;
    }
    if (type === "api_key") {
      const key = entry["key"];
      if (typeof key !== "string") {
        issues.push({
          path: `${id}.key`,
          message: key === undefined
            ? `${id}.key is required for api_key entries (a literal key or a "!command" string)`
            : `${id}.key must be a string (a literal key or a "!command" string)`,
        });
      }
      const env = entry["env"];
      if (env !== undefined && (!isJsonObject(env) || Object.values(env).some((v) => typeof v !== "string"))) {
        issues.push({ path: `${id}.env`, message: `${id}.env must be an object of string values` });
      }
    }
    // Unknown types and unknown fields: intentionally silent (permissive by design).
  }
  return issues;
}

function isJsonObject(value: JsonValue | undefined): value is { [k: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
