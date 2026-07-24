import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import "katex/dist/katex.min.css";

const CALLOUT_RE = /^\[!([\w-]+)\]([+-])?(?:\s+(.*))?$/i;
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

function safeUrl(value) {
  if (!value || /[\u0000-\u0020]/.test(value) && /^\s*(?:javascript|vbscript|data):/i.test(value)) {
    return null;
  }

  if (/^(?:#|\/|\.\.?\/)/.test(value)) return value;

  try {
    const url = new URL(value, "https://markdown.invalid/");
    return SAFE_PROTOCOLS.has(url.protocol) ? value : null;
  } catch {
    return null;
  }
}

function addNodeData(node, name, value) {
  node.data ||= {};
  node.data[name] = value;
}

function splitTextNode(node, pattern, createNode) {
  const match = pattern.exec(node.value);
  if (!match) return [node];

  const result = [];
  let offset = 0;
  do {
    if (match.index > offset) result.push({ type: "text", value: node.value.slice(offset, match.index) });
    result.push(createNode(match));
    offset = match.index + match[0].length;
  } while ((pattern.lastIndex = offset, pattern.exec(node.value)));
  if (offset < node.value.length) result.push({ type: "text", value: node.value.slice(offset) });
  pattern.lastIndex = 0;
  return result;
}

function transformObsidianSyntax(tree) {
  const visit = (node, parent) => {
    if (node.type === "html") {
      node.type = "text";
    }

    if (node.type === "blockquote" && node.children?.[0]?.type === "paragraph") {
      const firstText = node.children[0].children?.[0];
      const match = firstText?.type === "text" && firstText.value.match(CALLOUT_RE);
      if (match) {
        addNodeData(node, "hName", "aside");
        addNodeData(node, "hProperties", {
          className: [`markdown-callout`, `markdown-callout-${match[1].toLowerCase()}`],
          "data-callout": match[1].toLowerCase()
        });
        firstText.value = match[3] || "";
        if (!firstText.value) node.children[0].children.shift();
      }
    }

    if (node.type === "text" && parent?.type !== "code" && parent?.type !== "inlineCode") {
      let nodes = [node];
      nodes = nodes.flatMap((item) => splitTextNode(item, /%%[\s\S]*?%%/g, () => ({ type: "text", value: "" })));
      nodes = nodes.flatMap((item) => splitTextNode(item, /==([^=]+)==/g, (match) => ({
        type: "highlight", value: match[1], data: { hName: "mark" }
      })));
      nodes = nodes.flatMap((item) => splitTextNode(item, /!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (match) => ({
        type: "embed", value: match[2] || match[1], data: { hName: "span", hProperties: { className: ["markdown-embed"], title: match[1] } }
      })));
      nodes = nodes.flatMap((item) => splitTextNode(item, /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (match) => ({
        type: "link", title: null, url: `#${encodeURIComponent(match[1])}`, children: [{ type: "text", value: match[2] || match[1] }], data: { hProperties: { className: ["markdown-wikilink"] } }
      })));
      nodes = nodes.flatMap((item) => splitTextNode(item, /(^|[^\w])#([\w-]+(?:\/[-\w]+)*)/g, (match) => ({
        type: "tag", value: match[0], data: { hName: "span", hProperties: { className: ["markdown-tag"] } }
      })));
      if (nodes.length !== 1 || nodes[0] !== node) {
        const index = parent.children.indexOf(node);
        parent.children.splice(index, 1, ...nodes);
        return;
      }
    }

    node.children?.forEach((child) => visit(child, node));
  };
  tree.children?.forEach((child) => visit(child, tree));
}

function remarkObsidian() {
  return transformObsidianSyntax;
}

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes["*"] || []), "className", "title"],
    aside: ["className", "data-callout"],
    span: ["className", "title"]
  }
};

function Link({ href, children, ...props }) {
  const url = safeUrl(href);
  if (!url) return <span className="markdown-unsafe-link">{children}</span>;
  const external = /^(?:https?|mailto|tel):/i.test(url);
  return <a {...props} href={url} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined}>{children}</a>;
}

function Image({ src, alt, ...props }) {
  const url = safeUrl(src);
  return url ? <img {...props} src={url} alt={alt || ""} loading="lazy" /> : <span className="markdown-embed">{alt || src}</span>;
}

const components = {
  a: Link,
  img: Image,
  input: ({ type, checked, ...props }) => <input {...props} type={type} checked={checked} readOnly />,
  pre: ({ children, ...props }) => <pre {...props}>{children}</pre>
};

export default function Markdown({ text }) {
  const source = typeof text === "string" ? text : text == null ? "" : String(text);
  if (!source) return null;

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkBreaks, remarkObsidian]}
        rehypePlugins={[rehypeKatex, [rehypeSanitize, sanitizeSchema]]}
        components={components}
        skipHtml
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
