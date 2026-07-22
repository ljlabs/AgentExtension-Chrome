export function parseFrontMatter(text) {
  // Handle empty frontmatter: ---\n---\nBody
  if (text.startsWith("---\n---")) {
    const body = text.slice(7).replace(/^\n/, "");
    return { meta: {}, body };
  }

  const match = text.match(/^---\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: text };

  const meta = {};
  const lines = match[1].split("\n");

  for (const line of lines) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) {
      let val = kv[2].trim();
      if (val.startsWith("[") && val.endsWith("]")) {
        val = val
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""));
      } else {
        val = val.replace(/^["']|["']$/g, "");
      }
      meta[kv[1]] = val;
    }
  }

  return { meta, body: match[2] };
}

export function buildFrontMatter(meta, body) {
  let fm = "---\n";
  for (const [key, val] of Object.entries(meta)) {
    if (Array.isArray(val)) {
      fm += `${key}: [${val.join(", ")}]\n`;
    } else {
      fm += `${key}: ${val}\n`;
    }
  }
  fm += `---\n${body}`;
  return fm;
}
