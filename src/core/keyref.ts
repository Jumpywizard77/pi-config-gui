/**
 * Classification and resolution of pi `auth.json` / `models.json` api-key
 * strings, per pi's documented key forms — see the "Value Resolution" /
 * "Key Resolution" sections of pi's docs (`models.md` / `providers.md` on
 * pi.dev), the source for the three forms below:
 *
 * - `"!command"`  — the string is executed by pi to obtain the key. This GUI
 *   never executes such strings (global constraint); it only classifies them.
 * - `"$NAME"` / `"${NAME}"` — environment interpolation. An unescaped `$`
 *   anywhere makes the value an env-interpolated key.
 * - anything else — a literal key.
 *
 * The escape details — `"$"` is written `"$$"`, and `"$!"` yields a literal
 * `"!"` (so a literal leading `!` never turns into a command) — are
 * INFERRED FROM THOSE DOCS and pending verification against pi's source;
 * the docs state the forms, not the escape grammar.
 *
 * Pure module: resolution takes the environment as an injected record, so
 * callers (probe, auth UI, tests) control which environment is consulted.
 */

export type KeyForm = "literal" | "env" | "command";

/** Which of the three pi key forms a stored value uses. */
export function classifyKey(value: string): KeyForm {
  if (value.startsWith("!")) return "command";
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== "$") continue;
    const next = value[i + 1];
    if (next === "$" || next === "!") {
      i += 1; // escape: consumes "$$" / "$!"
      continue;
    }
    return "env";
  }
  return "literal";
}

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;

/** Identifier characters following the `$` of a valid `$NAME` at `index`. */
function nameAt(value: string, index: number): string | undefined {
  const next = value[index + 1];
  if (next === "{") {
    const end = value.indexOf("}", index + 2);
    if (end === -1) return undefined;
    const name = value.slice(index + 2, end);
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : undefined;
  }
  if (next !== undefined && NAME_START.test(next)) {
    let j = index + 1;
    while (j < value.length && NAME_CHAR.test(value[j]!)) j += 1;
    return value.slice(index + 1, j);
  }
  return undefined;
}

/**
 * The `$NAME` / `${NAME}` variables a value interpolates, in order of
 * appearance; escaped `$$` / `$!` are not variables. A `$` that starts no
 * valid name contributes nothing (and classifies as env, matching the
 * unescaped-`$` rule above; resolution keeps it literal).
 */
export function envVarNames(value: string): string[] {
  const names: string[] = [];
  let i = 0;
  while (i < value.length) {
    if (value[i] !== "$") {
      i += 1;
      continue;
    }
    const next = value[i + 1];
    if (next === "$" || next === "!") {
      i += 2; // escape
      continue;
    }
    const name = nameAt(value, i);
    if (name !== undefined) {
      names.push(name);
      i += value[i + 1] === "{" ? name.length + 3 : name.length + 1;
      continue;
    }
    i += 1;
  }
  return names;
}

/**
 * Substitute `$NAME` / `${NAME}` from `env` (pi's own interpolation rules,
 * escapes honored). If any variable is absent from `env`, nothing is sent
 * anywhere: the result reports every distinct missing name instead.
 */
export function resolveEnvKey(
  value: string,
  env: Record<string, string | undefined>,
): { ok: true; key: string } | { ok: false; missing: string[] } {
  let out = "";
  const missing: string[] = [];
  let i = 0;
  while (i < value.length) {
    const ch = value[i]!;
    if (ch !== "$") {
      out += ch;
      i += 1;
      continue;
    }
    const next = value[i + 1];
    if (next === "$" || next === "!") {
      out += next; // "$$" -> "$", "$!" -> "!"
      i += 2;
      continue;
    }
    const name = nameAt(value, i);
    if (name === undefined) {
      out += "$"; // no valid name follows; keep the dollar literal
      i += 1;
      continue;
    }
    const resolved = env[name];
    if (resolved === undefined) {
      if (!missing.includes(name)) missing.push(name);
    } else {
      out += resolved;
    }
    i += value[i + 1] === "{" ? name.length + 3 : name.length + 1;
  }
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, key: out };
}
