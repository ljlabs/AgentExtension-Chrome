export function parseAssistantResponse(response) {
  const choice = response && response.choices && response.choices[0];
  const message = (choice && choice.message) || {};
  const content = messageContentToText(message.content);
  const invalidToolJsonErrors = [];

  if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) {
    invalidToolJsonErrors.push("message.tool_calls was present but was not an array.");
  }

  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

  if (rawCalls.length) {
    return {
      content,
      tool_calls: rawCalls,
      invalidToolJsonErrors,
      rawContent: content
    };
  }

  if (content && /```|{[\s\S]*"?tool"?[\s\S]*}|{[\s\S]*"?name"?[\s\S]*}|{[\s\S]*"?function"?[\s\S]*}/i.test(content)) {
    const parsed = extractJson(content);

    if (parsed === undefined) {
      invalidToolJsonErrors.push("Found JSON-like tool call text but could not parse it.");
    } else {
      const calls = convertParsedToToolCalls(parsed);

      if (calls.length) {
        return {
          content: "",
          tool_calls: calls,
          invalidToolJsonErrors,
          rawContent: content
        };
      }

      if (parsed && typeof parsed === "object") {
        const answer = parsed.answer || parsed.message || parsed.final_answer;
        if (answer) {
          return {
            content: String(answer),
            tool_calls: [],
            invalidToolJsonErrors,
            rawContent: content
          };
        }
      }
    }
  }

  return {
    content,
    tool_calls: [],
    invalidToolJsonErrors,
    rawContent: content
  };
}

export function messageContentToText(content) {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === "text")
      .map((part) => part.text || "")
      .join("\n");
  }

  if (content) {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }

  return "";
}

export function extractJson(text) {
  if (!text) return undefined;

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // continue
    }
  }

  const objectStart = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);

  if (!starts.length) return undefined;

  const start = Math.min(...starts);
  const openChar = text[start];
  const closeChar = openChar === "{" ? "}" : "]";

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === openChar) {
      depth += 1;
    } else if (char === closeChar) {
      depth -= 1;

      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          break;
        }
      }
    }
  }

  return undefined;
}

export function convertParsedToToolCalls(parsed) {
  if (!parsed) return [];

  if (Array.isArray(parsed)) {
    return parsed.map((item, index) => convertParsedToolCall(item, index)).filter(Boolean);
  }

  if (Array.isArray(parsed.tool_calls)) {
    return parsed.tool_calls;
  }

  const single = convertParsedToolCall(parsed, 0);
  return single ? [single] : [];
}

export function convertParsedToolCall(obj, index) {
  if (!obj || typeof obj !== "object") return null;

  const name = obj.tool || obj.name || obj.function?.name;
  if (!name) return null;

  const args =
    obj.args ||
    obj.arguments ||
    obj.parameters ||
    obj.function?.arguments ||
    {};

  return {
    id: obj.id || `call_parsed_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`,
    type: "function",
    function: {
      name: String(name),
      arguments: typeof args === "string" ? args : JSON.stringify(args)
    }
  };
}
