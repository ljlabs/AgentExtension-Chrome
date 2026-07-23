import { useState } from "react";
import { resolveInteraction } from "../agent/controller.js";

export default function QuestionCard({ item }) {
  const args = item.args || {};
  const options = Array.isArray(args.options) ? args.options : [];
  const allowFreeText = args.allowFreeText !== false;
  const [selected, setSelected] = useState([]);
  const [freeText, setFreeText] = useState("");

  if (!item.pending) {
    const response = item.response || {};
    return (
      <div className="question-card restored-ui-card">
        <h4>{args.question || "Question"}</h4>
        <div className="interactive-response-summary">
          Answered: {response.answer || "No answer provided"}
        </div>
      </div>
    );
  }

  const toggleOption = (option) => {
    if (args.multiSelect) {
      setSelected((prev) =>
        prev.includes(option) ? prev.filter((entry) => entry !== option) : [...prev, option]
      );
    } else {
      setSelected([option]);
    }
  };

  const onSubmit = () => {
    const trimmedFreeText = freeText.trim();

    let answer = "";
    if (selected.length > 0) {
      answer = selected.join(", ");
      if (trimmedFreeText) answer += ` (${trimmedFreeText})`;
    } else {
      answer = trimmedFreeText || "No answer provided";
    }

    resolveInteraction(item.id, { answer, selectedOptions: selected, freeText: trimmedFreeText });
  };

  return (
    <div className="question-card">
      <h4>{args.question || "Question"}</h4>
      <div className="question-options">
        {options.map((option) => (
          <label key={option} className="question-option-label">
            <input
              type={args.multiSelect ? "checkbox" : "radio"}
              name={`q_${item.id}`}
              value={option}
              checked={selected.includes(option)}
              onChange={() => toggleOption(option)}
            />
            <span>{option}</span>
          </label>
        ))}
      </div>
      {allowFreeText && (
        <input
          type="text"
          className="question-free-text"
          placeholder="Other / additional details..."
          value={freeText}
          onChange={(event) => setFreeText(event.target.value)}
        />
      )}
      <button className="btn primary small" style={{ marginTop: 10 }} type="button" onClick={onSubmit}>
        Submit Answer
      </button>
    </div>
  );
}
