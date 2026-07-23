import { useEffect, useRef } from "react";
import { renderMarkdown } from "../../lib/markdown.js";

/**
 * Renders markdown via the existing sanitizer-safe DocumentFragment renderer
 * (textContent only — no innerHTML), appended through a ref.
 */
export default function Markdown({ text }) {
  const ref = useRef(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    node.textContent = "";
    try {
      node.appendChild(renderMarkdown(text));
    } catch {
      node.textContent = text || "";
    }
  }, [text]);

  return <div ref={ref} />;
}
