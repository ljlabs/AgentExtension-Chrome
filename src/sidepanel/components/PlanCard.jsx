import { useState } from "react";
import { resolveInteraction } from "../agent/controller.js";

function summaryText(approved, feedback) {
  if (approved) {
    return feedback ? `Plan Approved with feedback: "${feedback}"` : "Plan Approved";
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
          {summaryText(response.approved, response.feedback)}
        </div>
      </div>
    );
  }

  const finish = (approved) => {
    resolveInteraction(item.id, { approved, feedback: feedback.trim() });
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
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button className="btn primary small" type="button" onClick={() => finish(true)}>Approve Plan</button>
        <button className="btn danger small" type="button" onClick={() => finish(false)}>Reject</button>
      </div>
    </div>
  );
}
