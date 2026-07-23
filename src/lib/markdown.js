/**
 * Lightweight markdown renderer for chat bubbles.
 * Uses textContent for safety — no innerHTML injection.
 */
/**
 * Render markdown text to DOM elements.
 * Returns a DocumentFragment.
 */
export function renderMarkdown(text) {
  const source = typeof text === "string" ? text : text == null ? "" : String(text);
  if (!source) return document.createDocumentFragment();

  const fragment = document.createDocumentFragment();
  const lines = source.split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Code block (```)
    if (line.trimStart().startsWith("```")) {
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```

      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = codeLines.join("\n");
      pre.appendChild(code);
      fragment.appendChild(pre);
      continue;
    }

    // Horizontal rule
    if (/^(\s*[-*_]\s*){3,}$/.test(line)) {
      fragment.appendChild(document.createElement("hr"));
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const h = document.createElement(`h${level}`);
      h.appendChild(parseInline(headingMatch[2]));
      fragment.appendChild(h);
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      const quoteLines = [];
      while (i < lines.length && lines[i].startsWith("> ")) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      const blockquote = document.createElement("blockquote");
      blockquote.appendChild(renderMarkdown(quoteLines.join("\n")));
      fragment.appendChild(blockquote);
      continue;
    }

    // Unordered list
    const ulMatch = line.match(/^(\s*)([-*+])\s+(.+)/);
    if (ulMatch) {
      const list = document.createElement("ul");
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+])\s+(.+)/);
        if (!m) break;
        const li = document.createElement("li");
        li.appendChild(parseInline(m[3]));
        list.appendChild(li);
        i++;
      }
      fragment.appendChild(list);
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.+)/);
    if (olMatch) {
      const list = document.createElement("ol");
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)(\d+)\.\s+(.+)/);
        if (!m) break;
        const li = document.createElement("li");
        li.appendChild(parseInline(m[3]));
        list.appendChild(li);
        i++;
      }
      fragment.appendChild(list);
      continue;
    }

    // Empty line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph
    const paraLines = [];
    while (i < lines.length && lines[i].trim() !== "" && !lines[i].trimStart().startsWith("```") && !lines[i].startsWith("> ") && !/^#{1,6}\s/.test(lines[i]) && !/^(\s*)([-*+])\s+/.test(lines[i]) && !/^(\s*)(\d+)\.\s+/.test(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length) {
      const p = document.createElement("p");
      p.appendChild(parseInline(paraLines.join("\n")));
      fragment.appendChild(p);
    }
  }

  return fragment;
}

/**
 * Parse inline markdown (bold, italic, code, links).
 */
function parseInline(text) {
  const fragment = document.createDocumentFragment();

  // Regex for inline elements
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    // Add text before match
    if (match.index > lastIndex) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }

    const token = match[0];

    // Inline code
    if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      fragment.appendChild(code);
    }
    // Bold
    else if (token.startsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      fragment.appendChild(strong);
    }
    // Italic
    else if (token.startsWith("*")) {
      const em = document.createElement("em");
      em.textContent = token.slice(1, -1);
      fragment.appendChild(em);
    }
    // Link
    else if (token.startsWith("[")) {
      const linkMatch = token.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (linkMatch) {
        const a = document.createElement("a");
        a.textContent = linkMatch[1];
        a.href = linkMatch[2];
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        fragment.appendChild(a);
      }
    }

    lastIndex = match.index + token.length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
  }

  return fragment;
}
