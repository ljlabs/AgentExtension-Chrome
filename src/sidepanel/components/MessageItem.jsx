import Markdown from "./Markdown.jsx";
import QuestionCard from "./QuestionCard.jsx";
import ApprovalCard from "./ApprovalCard.jsx";
import PlanCard from "./PlanCard.jsx";

const INTERACTIVE_TITLES = {
  ask_user_question: "Clarifying Question",
  request_approval: "Approval Required",
  submit_plan: "Proposed Plan"
};

function Message({ className, title, children }) {
  return (
    <article className={`message ${className}`}>
      <header className="message-title">{title}</header>
      <div className="message-body">{children}</div>
    </article>
  );
}

export default function MessageItem({ item }) {
  switch (item.kind) {
    case "user":
      return (
        <Message className="user" title="You">
          <p>{item.text}</p>
        </Message>
      );

    case "assistant": {
      const chips = item.chips || [];
      return (
        <Message className="assistant" title="Agent">
          {item.text && <Markdown text={item.text} />}
          {chips.length > 0 && (
            <div className="tool-chips">
              {chips.map((chip, index) => (
                <span key={index} className={`chip ${chip.ok ? "ok" : "invalid"}`}>
                  {chip.name}{chip.ok ? "" : " invalid"}
                </span>
              ))}
            </div>
          )}
          {!item.text && chips.length > 0 && <p>Calling tools...</p>}
        </Message>
      );
    }

    case "system":
      return (
        <Message className="system" title="System">
          <p>{item.text}</p>
        </Message>
      );

    case "error":
      return (
        <Message className="error" title="Error">
          <p>{item.text}</p>
        </Message>
      );

    case "tool-result":
      return (
        <Message className={item.ok ? "tool" : "error"} title={item.title}>
          <pre>{item.payloadText}</pre>
        </Message>
      );

    case "interactive": {
      const title = INTERACTIVE_TITLES[item.uiType] || "Interaction";
      let card = null;
      if (item.uiType === "ask_user_question") card = <QuestionCard item={item} />;
      else if (item.uiType === "request_approval") card = <ApprovalCard item={item} />;
      else if (item.uiType === "submit_plan") card = <PlanCard item={item} />;

      return (
        <Message className="assistant" title={title}>
          {card}
        </Message>
      );
    }

    default:
      return null;
  }
}
