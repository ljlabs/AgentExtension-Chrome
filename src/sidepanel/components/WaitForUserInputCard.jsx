import { resolveInteraction } from "../agent/controller.js";

export default function WaitForUserInputCard({ item }) {
  const args = item.args || {};

  if (!item.pending) {
    const response = item.response || {};
    const changeType = response.changes?.type;
    const pageSummary = changeType === "full_snapshot"
      ? "Page context refreshed"
      : changeType === "diff"
        ? "Page changes captured"
        : "Page context unavailable";

    return (
      <div className="question-card restored-ui-card">
        <h4>{args.message || "Waiting for your input"}</h4>
        <div className="interactive-response-summary">
          Continued · {pageSummary}
        </div>
      </div>
    );
  }

  return (
    <div className="question-card">
      <h4>{args.message || "Waiting for your input"}</h4>
      <button
        className="btn primary small"
        style={{ marginTop: 10 }}
        type="button"
        onClick={() => resolveInteraction(item.id, { continued: true })}
      >
        {args.continueLabel || "Continue"}
      </button>
    </div>
  );
}
