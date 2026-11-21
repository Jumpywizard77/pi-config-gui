import type { Issue } from "../../core/types";
import type { StatePayload } from "../api";

interface ValidationPanelProps {
  issues: Issue[];
  state: StatePayload | null;
  /** False until a config file has been opened — nothing is validated yet. */
  hasConfig: boolean;
}

/**
 * Validation surface. Today the server only reports issues that do NOT block
 * saves ("pre-existing" relative to the current text — blocking ones are
 * refused at save time and listed inside the editor); blocking errors get
 * their own treatment in later tasks. A `"bundled-missing"` schema provenance
 * means validation ran against an empty schema: everything may pass falsely,
 * so the panel says so loudly.
 */
export function ValidationPanel({ issues, state, hasConfig }: ValidationPanelProps) {
  const degraded = state?.schemaFetchedAt === "bundled-missing";
  if (!degraded && issues.length === 0) {
    return (
      <section className="validation-panel">
        <span className="validation-ok">
          {hasConfig ? "No validation issues." : "No config open — nothing validated yet."}
        </span>
      </section>
    );
  }
  return (
    <section className="validation-panel">
      {degraded && (
        <div className="warning-banner degraded">
          Validation schema unavailable — the bundled copy is missing and no schema has been
          fetched yet. Validation is DEGRADED: problems may go unnoticed. Save (or start the
          server with network access) to refresh the schema.
        </div>
      )}
      {issues.map((issue, index) => (
        <div key={`${issue.path}|${issue.message}|${index}`} className="warning-banner">
          <code>{issue.path || "(document)"}</code>: {issue.message}{" "}
          <em className="hint">— pre-existing — not blocking your saves</em>
        </div>
      ))}
    </section>
  );
}
