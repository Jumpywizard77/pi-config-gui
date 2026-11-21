import { useEffect, useRef, useState } from "react";

import { parseJsonc } from "../../core/jsonc";
import type { JsonValue } from "../../core/types";

interface JsonFieldProps {
  label: string;
  /** Stored value (`undefined` = path absent). */
  value: JsonValue | undefined;
  onChange: (next: JsonValue | undefined) => void;
  /** With this flag, an empty textarea commits `undefined` (deletes the path). */
  deleteWhenUndefined?: true;
}

const seedText = (value: JsonValue | undefined): string =>
  value === undefined ? "" : JSON.stringify(value, null, 2);

/**
 * Free-form JSON editor for one provider key (`compat` today). A textarea of
 * JSON parsed locally on BLUR: invalid text shows a red border + message and
 * keeps the last good value (no onChange); valid text commits the parsed
 * value. Empty text deletes the path when `deleteWhenUndefined` is set
 * (without it, clearing is refused with a hint).
 *
 * External changes (a reload or discard re-seeding the document) re-seed the
 * textarea; commits do NOT (the emitted value is remembered and matched), so
 * the text never reflows under the cursor mid-typing.
 */
export function JsonField({ label, value, onChange, deleteWhenUndefined }: JsonFieldProps) {
  const [text, setText] = useState(seedText(value));
  const [error, setError] = useState<string | null>(null);
  // What WE last committed, as JSON text — the re-seed guard's baseline.
  const lastEmitted = useRef(JSON.stringify(value ?? null));

  const incoming = JSON.stringify(value ?? null);
  useEffect(() => {
    if (incoming !== lastEmitted.current) {
      lastEmitted.current = incoming;
      setText(seedText(value));
      setError(null);
    }
    // `value` rides `incoming` (it is what incoming stringifies).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming]);

  const commit = (): void => {
    const trimmed = text.trim();
    if (trimmed === "") {
      if (deleteWhenUndefined === true) {
        lastEmitted.current = "null";
        onChange(undefined);
        setError(null);
      } else {
        setError("Empty does not delete this field here — clear it in the Raw JSON tab.");
      }
      return;
    }
    const { value: parsed, errors } = parseJsonc(trimmed);
    if (errors.length > 0 || parsed === undefined) {
      setError(errors[0]?.message ?? "Not valid JSON.");
      return;
    }
    lastEmitted.current = JSON.stringify(parsed);
    setError(null);
    onChange(parsed);
  };

  return (
    <div className={`json-field${error === null ? "" : " json-field-invalid"}`}>
      <span className="field-label">{label}</span>
      <textarea
        className="json-field-text"
        spellCheck={false}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
      />
      {error !== null && <div className="field-error">{error}</div>}
    </div>
  );
}
