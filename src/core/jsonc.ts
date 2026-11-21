import {
  applyEdits,
  getLocation,
  modify,
  parse,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";

import type { Issue, JsonValue, PathEdit } from "./types.js";

const BOM = "\uFEFF";

/** The one tolerance setting; `parseJsonc` and `applyPathEdits` must never diverge. */
const TOLERANT_PARSE_OPTIONS = { allowTrailingComma: true, disallowComments: false } as const;

const EDIT_OPTIONS = {
  formattingOptions: { insertSpaces: true, tabSize: 2 },
} as const;

function splitBom(text: string): { bom: string; body: string } {
  return text.startsWith(BOM) ? { bom: BOM, body: text.slice(BOM.length) } : { bom: "", body: text };
}

function formatPath(path: (string | number)[]): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else {
      out += out === "" ? segment : `.${segment}`;
    }
  }
  return out;
}

interface LocatedIssue {
  path: string;
  line: number;
  col: number;
  code: string;
}

/**
 * Single parse path shared by `parseJsonc` and `applyPathEdits`: hides the
 * BOM from jsonc-parser (its scanner rejects it) and reports every error as a
 * located issue with positions shifted back onto the original text.
 */
function tolerantParse(text: string): {
  bom: string;
  body: string;
  value: JsonValue | undefined;
  issues: LocatedIssue[];
} {
  const { bom, body } = splitBom(text);
  const parseErrors: ParseError[] = [];
  const value = parse(body, parseErrors, TOLERANT_PARSE_OPTIONS) as JsonValue | undefined;

  const issues = parseErrors.map((error) => {
    const offset = error.offset + bom.length;
    const before = text.slice(0, offset);
    const line = before.split(/\r\n|\r|\n/).length;
    const lineStart = Math.max(before.lastIndexOf("\n"), before.lastIndexOf("\r")) + 1;
    return {
      path: formatPath(getLocation(body, error.offset).path),
      line,
      col: offset - lineStart + 1,
      code: printParseErrorCode(error.error),
    };
  });

  return { bom, body, value, issues };
}

/**
 * Parse JSONC text, collecting problems as `Issue`s. Trailing commas are
 * accepted (they are legal in pi configs) and produce no issues.
 */
export function parseJsonc(text: string): { value: JsonValue | undefined; errors: Issue[] } {
  const { value, issues } = tolerantParse(text);
  return {
    value,
    errors: issues.map(({ path, line, col, code }) => ({
      path,
      message: `Line ${line}, col ${col}: ${code}`,
    })),
  };
}

/**
 * Apply surgical path edits, leaving every byte outside the edited paths
 * untouched: comments, BOM, CRLF line endings and trailing commas survive.
 * Each edit is resolved against the running text, so earlier edits never
 * invalidate later offsets.
 *
 * Contract: refuses to touch documents it cannot fully parse. Throws an
 * `Error` listing up to three parse issues as `line:col code` if the input
 * has hard errors under the same tolerance settings as `parseJsonc`
 * (trailing commas are tolerated, so this only fires on genuinely malformed
 * JSONC) — a mangled rewrite is never returned silently.
 */
export function applyPathEdits(text: string, edits: PathEdit[]): string {
  const { bom, body, issues } = tolerantParse(text);
  if (issues.length > 0) {
    const listed = issues.slice(0, 3).map((issue) => `${issue.line}:${issue.col} ${issue.code}`);
    const more = issues.length > listed.length ? ` (+${issues.length - listed.length} more)` : "";
    throw new Error(
      `applyPathEdits (core/jsonc): refusing to edit malformed JSONC — ` +
        `${issues.length} parse error(s): ${listed.join("; ")}${more}`,
    );
  }

  let result = body;
  for (const edit of edits) {
    result = applyEdits(result, modify(result, edit.path, edit.value, EDIT_OPTIONS));
  }
  return bom + result;
}
