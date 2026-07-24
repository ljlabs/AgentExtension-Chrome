import { useState } from "react";
import { resolveInteraction } from "../agent/controller.js";

function summaryText(approved, feedback, autoApprove, cancelled) {
  if (cancelled) return "Plan Cancelled — switch back to this tab to start a new run.";

  if (approved) {
    let text = feedback ? `Plan Approved with feedback: "${feedback}"` : "Plan Approved";
    if (autoApprove) text += " (auto-approving actions)";
    return text;
  }
  return feedback ? `Plan Rejected with feedback: "${feedback}"` : "Plan Rejected";
}

function DetailList({ label, values }) {
  if (!Array.isArray(values) || values.length === 0) return null;

  return (
    <div className="plan-detail-section">
      <strong>{label}</strong>
      <ul>
        {values.map((value, index) => <li key={index}>{value}</li>)}
      </ul>
    </div>
  );
}

function PlanDetails({ args }) {
  return (
    <div className="plan-details">
      {args.objective && <p className="plan-objective"><strong>Objective:</strong> {args.objective}</p>}
      <DetailList label="Research and inspection" values={args.researchTasks} />
      <DetailList label="Deliverables" values={args.deliverables} />
      <DetailList label="Success criteria" values={args.successCriteria} />
      <DetailList label="Verification" values={args.verification} />
      <DetailList label="Risks" values={args.risks} />
      <DetailList label="Assumptions" values={args.assumptions} />
      <DetailList label="Feedback addressed" values={args.feedbackAddressed} />
      <DetailList label="Changes from previous plan" values={args.changesFromPrevious} />
    </div>
  );
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
        <PlanDetails args={args} />
        <ol className="plan-steps-list">
          {steps.map((step, index) => <li key={index}>{step}</li>)}
        </ol>
        {args.notes && <div className="plan-notes">{args.notes}</div>}
        <div
          className="interactive-response-summary"
          style={{ background: response.approved ? "var(--green)" : "var(--danger)" }}
        >
          {summaryText(response.approved, response.feedback, response.autoApprove, response.cancelled)}
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
      <PlanDetails args={args} />
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
