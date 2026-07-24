import { useState } from "react";
import { resolveInteraction } from "../agent/controller.js";

function summaryText(approved, feedback, autoApprove) {
  if (approved) {
    let text = feedback ? `Plan Approved with feedback: "${feedback}"` : "Plan Approved";
    if (autoApprove) text += " (auto-approving actions)";
    return text;
  }
  return feedback ? `Plan Rejected with feedback: "${feedback}"` : "Plan Rejected";
}

export default function PlanCard({ item }) {
  const args = item.args || {};
  const steps = Array.isArray(args.steps) ? args.steps : [];
  const [feedback, setFeedback] = useState("");

  if (!item.pending) {
    const response = item.response || {};
    return (
      <div className="plan-card restored-ui-card">
        <h4>{args.title || "Plan Overview"}</h4>
        <ol className="plan-steps-list">
          {steps.map((step, index) => <li key={index}>{step}</li>)}
        </ol>
        <div
          className="interactive-response-summary"
          style={{ background: response.approved ? "var(--green)" : "var(--danger)" }}
        >
          {summaryText(response.approved, response.feedback, response.autoApprove)}
        </div>
      </div>
    );
  }

  const finish = (approved, shouldAutoApprove) => {
    const response = { approved, feedback: feedback.trim() };
    if (shouldAutoApprove) response.autoApprove = true;
    resolveInteraction(item.id, response);
  };

  return (
    <div className="plan-card">
      <h4>{args.title || "Plan Overview"}</h4>
      <ol className="plan-steps-list">
        {steps.map((step, index) => <li key={index}>{step}</li>)}
      </ol>
      {args.notes && <div className="plan-notes">{args.notes}</div>}
      <input
        type="text"
        className="question-free-text"
        style={{ flex: 1 }}
        placeholder="Feedback or modifications..."
        value={feedback}
        onChange={(event) => setFeedback(event.target.value)}
      />
      <div style={{ display: "flex", gap: 4, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
        <button className="btn primary small" type="button" onClick={() => finish(true, false)}>Approve Plan</button>
        <button className="btn primary small" type="button" style={{ backgroundColor: "var(--blue-accent)" }} onClick={() => finish(true, true)}>Approve & Auto-approve Actions</button>
        <button className="btn danger small" type="button" onClick={() => finish(false, false)}>Reject</button>
      </div>
    </div>
  );
}
