export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

/**
 * A problem found while parsing a config file.
 * `path` is a dot/bracket path (e.g. `provider.Maya.settings.baseURL`);
 * empty when the problem could not be attributed to a location.
 */
export interface Issue {
  path: string;
  message: string;
}

/** One surgical edit to a JSON document; `value: undefined` deletes the path. */
export interface PathEdit {
  path: (string | number)[];
  value: JsonValue | undefined;
}
