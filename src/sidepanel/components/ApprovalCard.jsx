import { resolveInteraction } from "../agent/controller.js";

export default function ApprovalCard({ item }) {
  const args = item.args || {};

  if (!item.pending) {
    const response = item.response || {};
    return (
      <div className="approval-card restored-ui-card">
        <span className="risk-badge">{args.actionType || "HIGH RISK"}</span>
        <span style={{ fontWeight: 700 }}>{args.description || "Action approval requested."}</span>
        <div
          className="interactive-response-summary"
          style={{ background: response.approved ? "var(--green)" : "var(--danger)" }}
        >
          {response.approved ? "Approved" : "Rejected"}
        </div>
      </div>
    );
  }

  const finalize = (approved) => {
    resolveInteraction(item.id, { approved, decision: approved ? "approved" : "rejected" });
  };

  return (
    <div className="approval-card">
      <span className="risk-badge">{args.actionType || "HIGH RISK"}</span>
      <span style={{ fontWeight: 700 }}>{args.description || "Action approval requested."}</span>
      {args.details && typeof args.details === "object" && (
        <pre style={{ fontSize: 11, marginTop: 6 }}>{JSON.stringify(args.details, null, 2)}</pre>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button className="btn primary small" type="button" onClick={() => finalize(true)}>Approve</button>
        <button className="btn danger small" type="button" onClick={() => finalize(false)}>Reject</button>
      </div>
    </div>
  );
}
