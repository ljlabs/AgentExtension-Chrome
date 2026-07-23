import { useEffect, useRef } from "react";
import MessageItem from "./MessageItem.jsx";

export default function ChatLog({ items }) {
  const logRef = useRef(null);

  // Auto-scroll to the newest message.
  useEffect(() => {
    const node = logRef.current;
    if (!node) return;
    requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
    });
  }, [items]);

  return (
    <main id="chatLog" className="chat-log" aria-live="polite" ref={logRef}>
      {items.map((item) => (
        <MessageItem key={item.id} item={item} />
      ))}
    </main>
  );
}
