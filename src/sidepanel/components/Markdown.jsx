/**
 * Declarative markdown renderer for chat bubbles. Returns React elements —
 * no innerHTML, no refs, no effects — so it renders identically for live
 * messages and transcripts restored on tab switch.
 *
 * Supports: headings, code fences, inline code, bold, italic, links,
 * ordered/unordered lists, blockquotes, horizontal rules, paragraphs.
 */

const INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;

function renderInline(text) {
  const parts = [];
  let lastIndex = 0;
  let match;
  let key = 0;

  INLINE_RE.lastIndex = 0;
  while ((match = INLINE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];

    if (token.startsWith("`")) {
      parts.push(<code key={key++}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      parts.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      parts.push(<em key={key++}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith("[")) {
      const linkMatch = token.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (linkMatch) {
        parts.push(
          <a key={key++} href={linkMatch[2]} target="_blank" rel="noopener noreferrer">
            {linkMatch[1]}
          </a>
        );
      } else {
        parts.push(token);
      }
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

function renderBlocks(source, keyPrefix = "") {
  const blocks = [];
  const lines = source.split("\n");
  let i = 0;
  let key = 0;

  const nextKey = () => `${keyPrefix}${key++}`;

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
      blocks.push(
        <pre key={nextKey()}>
          <code>{codeLines.join("\n")}</code>
        </pre>
      );
      continue;
    }

    // Horizontal rule
    if (/^(\s*[-*_]\s*){3,}$/.test(line)) {
      blocks.push(<hr key={nextKey()} />);
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      const H = `h${headingMatch[1].length}`;
      blocks.push(<H key={nextKey()}>{renderInline(headingMatch[2])}</H>);
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
      blocks.push(
        <blockquote key={nextKey()}>
          {renderBlocks(quoteLines.join("\n"), `${keyPrefix}q${key}-`)}
        </blockquote>
      );
      continue;
    }

    // Unordered list
    if (/^(\s*)([-*+])\s+(.+)/.test(line)) {
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+])\s+(.+)/);
        if (!m) break;
        items.push(<li key={items.length}>{renderInline(m[3])}</li>);
        i++;
      }
      blocks.push(<ul key={nextKey()}>{items}</ul>);
      continue;
    }

    // Ordered list
    if (/^(\s*)(\d+)\.\s+(.+)/.test(line)) {
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)(\d+)\.\s+(.+)/);
        if (!m) break;
        items.push(<li key={items.length}>{renderInline(m[3])}</li>);
        i++;
      }
      blocks.push(<ol key={nextKey()}>{items}</ol>);
      continue;
    }

    // Empty line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph — consume consecutive non-special lines
    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].trimStart().startsWith("```") &&
      !lines[i].startsWith("> ") &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^(\s*)([-*+])\s+/.test(lines[i]) &&
      !/^(\s*)(\d+)\.\s+/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length) {
      blocks.push(<p key={nextKey()}>{renderInline(paraLines.join("\n"))}</p>);
    }
  }

  return blocks;
}

export default function Markdown({ text }) {
  const source = typeof text === "string" ? text : text == null ? "" : String(text);
  if (!source) return null;

  return <div className="markdown-body">{renderBlocks(source)}</div>;
}
