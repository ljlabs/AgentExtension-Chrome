export function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function isBlockedHostname(hostname) {
  const blocked = new Set([
    "169.254.169.254",
    "metadata.google.internal",
    "metadata",
    "0.0.0.0"
  ]);
  return blocked.has(hostname.toLowerCase());
}

export async function performHttpRequest(args) {
  try {
    const url = new URL(args.url);

    if (!["http:", "https:"].includes(url.protocol)) {
      return { ok: false, error: "Only http and https URLs are allowed." };
    }

    if (isBlockedHostname(url.hostname)) {
      return { ok: false, error: `Blocked hostname: ${url.hostname}` };
    }

    const method = String(args.method || "GET").toUpperCase();
    const headers = {};

    if (args.headers && typeof args.headers === "object" && !Array.isArray(args.headers)) {
      for (const [key, value] of Object.entries(args.headers)) {
        headers[key] = String(value);
      }
    }

    const controller = new AbortController();
    const timeoutMs = clampInt(args.timeoutMs, 1000, 120000, 30000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const init = {
      method,
      headers,
      redirect: args.redirect || "follow",
      credentials: args.credentials || "omit",
      signal: controller.signal
    };

    if (!["GET", "HEAD"].includes(method) && args.body !== undefined) {
      if (typeof args.body === "string") {
        init.body = args.body;
      } else {
        init.body = JSON.stringify(args.body);
        if (!headers["Content-Type"] && !headers["content-type"]) {
          headers["Content-Type"] = "application/json";
        }
      }
    }

    const response = await fetch(url.toString(), init);
    clearTimeout(timer);

    const maxChars = clampInt(args.maxChars, 1000, 2000000, 200000);
    const text = await response.text();
    const truncated = text.length > maxChars;
    const bodyText = truncated ? text.slice(0, maxChars) : text;
    const contentType = response.headers.get("content-type") || "";

    let body = bodyText;
    if (args.parseJson !== false && contentType.includes("application/json")) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = bodyText;
      }
    }

    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return {
      ok: true,
      data: {
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        contentType,
        headers: responseHeaders,
        body,
        truncated
      }
    };
  } catch (err) {
    return {
      ok: false,
      error: err.name === "AbortError" ? "HTTP request timed out." : err.message
    };
  }
}

export function isLocalOrigin(origin) {
  try {
    const url = new URL(origin);
    return ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function originMatchesPattern(origin, pattern) {
  if (!pattern) return false;
  if (pattern === "*") return true;
  if (pattern === origin) return true;

  if (pattern.includes("*")) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    try {
      return new RegExp(`^${escaped}$`).test(origin);
    } catch {
      return false;
    }
  }

  return false;
}