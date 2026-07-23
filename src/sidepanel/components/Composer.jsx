import { useState } from "react";
import { onSend, onStop } from "../agent/controller.js";

export default function Composer({ isRunning }) {
  const [text, setText] = useState("");

  const send = () => {
    if (!text.trim() || isRunning) return;
    const value = text;
    setText("");
    onSend(value);
  };

  const onKeyDown = (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      send();
    }
  };

  return (
    <footer className="composer">
      <textarea
        id="userInput"
        rows={3}
        placeholder="Ask about this page or tell the agent what to do. Ctrl/Cmd+Enter sends."
        value={text}
        disabled={isRunning}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />

      <div className="composer-row">
        <div className="spacer" />

        <button id="sendBtn" className="btn primary" type="button" disabled={isRunning} onClick={send}>
          Send
        </button>
        {isRunning && (
          <button id="stopBtn" className="btn danger" type="button" onClick={onStop}>
            Stop
          </button>
        )}
      </div>
    </footer>
  );
}
