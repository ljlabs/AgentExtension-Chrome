export function extractImages(result) {
  const images = [];

  if (result && result.data && Array.isArray(result.data._images)) {
    images.push(...result.data._images);
    delete result.data._images;
  }

  if (result && Array.isArray(result._images)) {
    images.push(...result._images);
    delete result._images;
  }

  return images;
}

export function stringifyToolResult(result, maxToolResultChars) {
  try {
    const clean = JSON.parse(JSON.stringify(result, (key, value) => key === "ui" ? undefined : value));
    const text = JSON.stringify(clean);

    if (text.length > maxToolResultChars) {
      return `${text.slice(0, maxToolResultChars)}\n...[truncated]`;
    }

    return text;
  } catch {
    return String(result);
  }
}

export function containsImages(messages) {
  return messages.some((message) => {
    if (Array.isArray(message.content)) {
      return message.content.some((part) => part && part.type === "image_url");
    }

    if (typeof message.content === "string") {
      return message.content.includes("data:image");
    }

    return false;
  });
}

export function stripImages(messages) {
  return messages.map((message) => {
    if (Array.isArray(message.content)) {
      const textParts = message.content.filter((part) => part && part.type === "text");
      const hadImage = message.content.some((part) => part && part.type === "image_url");

      const text = textParts.map((part) => part.text || "").join("\n");

      return {
        ...message,
        content: text ? `${text}${hadImage ? "\n[image omitted]" : ""}` : "[image omitted]"
      };
    }

    if (typeof message.content === "string" && message.content.includes("data:image")) {
      return {
        ...message,
        content: message.content.replace(/data:image\/[a-z0-9+.]+;base64,[A-Za-z0-9+/=]+/gi, "[image omitted]")
      };
    }

    return message;
  });
}

export function looksLikeImageError(err) {
  const message = String(err.message || err);
  return /image|vision|multimodal|image_url|content part/i.test(message);
}
