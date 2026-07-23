import { useState } from "react";

/**
 * Single chat bubble for one tool call: header row with tool name, status,
 * and a one-line argument summary; the full result is collapsed by default
 * and expands on click.
 */
export default function ToolCallBubble({ item }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <article className={`message ${item.ok ? "tool" : "error"}`}>
      <div className="message-body">
        <button
          type="button"
          className="tool-bubble-header"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          title={expanded ? "Collapse result" : "Expand result"}
        >
          <span className={`tool-bubble-status ${item.ok ? "ok" : "failed"}`}>
            {item.ok ? "✓" : "✗"}
          </span>
          <span className="tool-bubble-name">{item.toolName}</span>
          {item.argsText && item.argsText !== "{}" && (
            <span className="tool-bubble-args">{item.argsText}</span>
          )}
          <span className="tool-bubble-chevron">{expanded ? "▾" : "▸"}</span>
        </button>
        {expanded && <pre className="tool-bubble-result">{item.resultText}</pre>}
      </div>
    </article>
  );
}
