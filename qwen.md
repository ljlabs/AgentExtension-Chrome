Below is a complete, production-oriented Chrome Extension (Manifest V3) that adds a neobrutalist pastel chat side panel to Chrome. It connects to your local LLM at `localhost:8000`, fetches models from `/models`, sends page HTML when enabled, validates tool calls against schemas, returns validation errors to the LLM, asks permission before sending images to the LLM, supports network fetch tools, and stays bound to the tab you opened it on even if you switch tabs.

> Assumption: your local LLM server exposes an OpenAI-compatible `/chat/completions` endpoint. If yours is `/v1/chat/completions` or `/v1/models`, change it in the extension Settings panel.

---

## File structure

Create a folder, for example:

```text
local-llm-browser-agent/
  manifest.json
  background.js
  content.js
  network.js
  validator.js
  tools-schema.js
  sidepanel.html
  sidepanel.js
  styles.css
  README.md
```

---

## 1. `manifest.json`

```json
{
  "manifest_version": 3,
  "name": "Local LLM Browser Agent",
  "version": "1.0.0",
  "description": "Neobrutalist side-panel agent for local LLMs with tool validation and bound-tab control.",
  "minimum_chrome_version": "116",
  "permissions": [
    "sidePanel",
    "storage",
    "scripting",
    "tabs",
    "debugger"
  ],
  "host_permissions": [
    "<all_urls>"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "action": {
    "default_title": "Open Local LLM Agent"
  },
  "side_panel": {
    "default_path": "sidepanel.html"
  },
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'"
  }
}
```

---

## 2. `validator.js`

This is a small JSON Schema validator with light coercion. It is used to validate LLM tool calls before execution.

```js
(function (global) {
  "use strict";

  function safeClone(value) {
    if (value === undefined) return undefined;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  }

  function isType(value, type) {
    switch (type) {
      case "string":
        return typeof value === "string";
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "integer":
        return Number.isInteger(value);
      case "boolean":
        return typeof value === "boolean";
      case "object":
        return value !== null && typeof value === "object" && !Array.isArray(value);
      case "array":
        return Array.isArray(value);
      case "null":
        return value === null;
      default:
        return true;
    }
  }

  function attemptCoercion(value, types) {
    if (value === undefined) return value;

    if (types.includes("integer") && typeof value === "string" && /^-?\d+$/.test(value.trim())) {
      return parseInt(value, 10);
    }

    if (types.includes("number") && typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
      return Number(value);
    }

    if (types.includes("boolean") && (value === "true" || value === "false")) {
      return value === "true";
    }

    if (types.includes("null") && (value === "" || value === "null")) {
      return null;
    }

    if (types.includes("string") && value !== null && typeof value !== "object") {
      return String(value);
    }

    if (types.includes("string") && value !== null && typeof value === "object") {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }

    if (types.includes("object") && typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      } catch {
        // ignore
      }
    }

    if (types.includes("array") && typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        return [value];
      }
    }

    return value;
  }

  function normalizeValue(value, schema, path, errors) {
    if (!schema || typeof schema !== "object") return value;

    if (value === undefined && schema.default !== undefined) {
      value = safeClone(schema.default);
    }

    if (Array.isArray(schema.anyOf) && schema.anyOf.length) {
      const passed = schema.anyOf.some((subSchema) => {
        const tempErrors = [];
        normalizeValue(safeClone(value), subSchema, path, tempErrors);
        return tempErrors.length === 0;
      });

      if (!passed) {
        errors.push({
          path,
          message: "Did not match any allowed alternative.",
          schemaKeyword: "anyOf"
        });
      }
    }

    let types = null;
    if (schema.type) {
      types = Array.isArray(schema.type) ? schema.type : [schema.type];
    }

    if (types && types.length) {
      const alreadyValid = types.some((type) => isType(value, type));
      if (!alreadyValid) {
        value = attemptCoercion(value, types);
      }

      const nowValid = types.some((type) => isType(value, type));
      if (!nowValid) {
        errors.push({
          path,
          message: `Expected ${types.join(" or ")}, received ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}.`
        });
        return value;
      }
    }

    if (Array.isArray(schema.required) && schema.required.length) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        errors.push({
          path,
          message: `Expected an object with required fields: ${schema.required.join(", ")}.`
        });
      }
    }

    if (schema.enum && Array.isArray(schema.enum)) {
      if (!schema.enum.includes(value)) {
        errors.push({
          path,
          message: `Value must be one of: ${JSON.stringify(schema.enum)}.`
        });
      }
    }

    if (typeof value === "string") {
      if (Number.isFinite(schema.minLength) && value.length < schema.minLength) {
        errors.push({ path, message: `String must be at least ${schema.minLength} characters.` });
      }

      if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) {
        errors.push({ path, message: `String must be at most ${schema.maxLength} characters.` });
      }

      if (schema.pattern) {
        try {
          const re = new RegExp(schema.pattern);
          if (!re.test(value)) {
            errors.push({ path, message: `String must match pattern ${schema.pattern}.` });
          }
        } catch {
          errors.push({ path, message: `Invalid pattern in schema: ${schema.pattern}.` });
        }
      }
    }

    if (typeof value === "number") {
      if (Number.isFinite(schema.minimum) && value < schema.minimum) {
        errors.push({ path, message: `Number must be >= ${schema.minimum}.` });
      }

      if (Number.isFinite(schema.maximum) && value > schema.maximum) {
        errors.push({ path, message: `Number must be <= ${schema.maximum}.` });
      }

      if (Number.isFinite(schema.exclusiveMinimum) && value <= schema.exclusiveMinimum) {
        errors.push({ path, message: `Number must be > ${schema.exclusiveMinimum}.` });
      }

      if (Number.isFinite(schema.exclusiveMaximum) && value >= schema.exclusiveMaximum) {
        errors.push({ path, message: `Number must be < ${schema.exclusiveMaximum}.` });
      }
    }

    if (Array.isArray(value)) {
      if (Number.isFinite(schema.minItems) && value.length < schema.minItems) {
        errors.push({ path, message: `Array must have at least ${schema.minItems} items.` });
      }

      if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) {
        errors.push({ path, message: `Array must have at most ${schema.maxItems} items.` });
      }

      if (schema.items && typeof schema.items === "object") {
        value = value.map((item, index) => normalizeValue(item, schema.items, `${path}[${index}]`, errors));
      }
    }

    if (value && typeof value === "object" && !Array.isArray(value)) {
      const properties = schema.properties || {};

      for (const [key, propSchema] of Object.entries(properties)) {
        if (value[key] === undefined && propSchema && propSchema.default !== undefined) {
          value[key] = safeClone(propSchema.default);
        }

        if (value[key] !== undefined) {
          value[key] = normalizeValue(value[key], propSchema, `${path}.${key}`, errors);
        }
      }

      if (Array.isArray(schema.required)) {
        for (const key of schema.required) {
          if (value[key] === undefined || value[key] === null) {
            errors.push({ path: `${path}.${key}`, message: `Required field "${key}" is missing.` });
          }
        }
      }

      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in properties)) {
            errors.push({ path: `${path}.${key}`, message: `Unexpected field "${key}" is not allowed.` });
          }
        }
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        for (const [key, val] of Object.entries(value)) {
          if (!(key in properties)) {
            value[key] = normalizeValue(val, schema.additionalProperties, `${path}.${key}`, errors);
          }
        }
      }
    }

    return value;
  }

  function normalizeAndValidate(data, schema) {
    const errors = [];
    const value = normalizeValue(safeClone(data), schema || {}, "$", errors);
    return {
      valid: errors.length === 0,
      errors,
      value
    };
  }

  global.normalizeAndValidate = normalizeAndValidate;
})(globalThis);
```

---

## 3. `tools-schema.js`

This defines the agent tools, OpenAI-compatible tool definitions, and tool-call validation.

```js
(function (global) {
  "use strict";

  const TARGET_PROPERTIES = {
    ref: {
      type: "string",
      description: "Element ref from get_interactive_snapshot, for example e12."
    },
    selector: {
      type: "string",
      description: "CSS selector."
    },
    xpath: {
      type: "string",
      description: "XPath expression."
    }
  };

  const TARGET_ANY_OF = [
    { required: ["ref"] },
    { required: ["selector"] },
    { required: ["xpath"] }
  ];

  const AGENT_TOOLS = [
    {
      name: "get_page_info",
      description: "Get metadata about the bound page: URL, title, ready state, viewport, meta description, and current selection.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    },
    {
      name: "get_html",
      description: "Get HTML from the bound page. By default scripts and styles are removed. Use selector/ref/xpath to target a subtree. Use maxLength to control size.",
      parameters: {
        type: "object",
        properties: {
          ...TARGET_PROPERTIES,
          maxLength: {
            type: "integer",
            minimum: 1,
            maximum: 1000000,
            default: 120000
          },
          includeScripts: {
            type: "boolean",
            default: false
          },
          includeStyles: {
            type: "boolean",
            default: false
          },
          includeComments: {
            type: "boolean",
            default: false
          }
        },
        additionalProperties: false
      }
    },
    {
      name: "get_text",
      description: "Get visible text from the bound page or a targeted element.",
      parameters: {
        type: "object",
        properties: {
          ...TARGET_PROPERTIES,
          maxLength: {
            type: "integer",
            minimum: 1,
            maximum: 1000000,
            default: 50000
          }
        },
        additionalProperties: false
      }
    },
    {
      name: "get_interactive_snapshot",
      description: "List interactive elements on the page and assign refs. Use these refs with click, type_text, set_value, press_key, and scroll_to.",
      parameters: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "Optional CSS selector to narrow the snapshot."
          },
          maxElements: {
            type: "integer",
            minimum: 1,
            maximum: 500,
            default: 200
          },
          includeHidden: {
            type: "boolean",
            default: false
          }
        },
        additionalProperties: false
      }
    },
    {
      name: "click",
      description: "Click an element in the bound tab. Prefer using ref from get_interactive_snapshot.",
      parameters: {
        type: "object",
        properties: {
          ...TARGET_PROPERTIES,
          waitAfterMs: {
            type: "integer",
            minimum: 0,
            maximum: 15000,
            default: 350
          },
          force: {
            type: "boolean",
            default: false,
            description: "Click even if the element appears disabled."
          }
        },
        anyOf: TARGET_ANY_OF,
        additionalProperties: false
      }
    },
    {
      name: "type_text",
      description: "Type text into an input, textarea, or contenteditable element.",
      parameters: {
        type: "object",
        properties: {
          ...TARGET_PROPERTIES,
          text: {
            type: "string"
          },
          clear: {
            type: "boolean",
            default: false,
            description: "Clear existing value before typing."
          },
          pressEnter: {
            type: "boolean",
            default: false
          },
          force: {
            type: "boolean",
            default: false
          }
        },
        required: ["text"],
        anyOf: TARGET_ANY_OF,
        additionalProperties: false
      }
    },
    {
      name: "set_value",
      description: "Set the value of an input, textarea, select, checkbox, or radio.",
      parameters: {
        type: "object",
        properties: {
          ...TARGET_PROPERTIES,
          value: {
            type: ["string", "number", "boolean"],
            description: "Value to set. For checkbox/radio, true/false-like values are interpreted as checked state."
          }
        },
        required: ["value"],
        anyOf: TARGET_ANY_OF,
        additionalProperties: false
      }
    },
    {
      name: "press_key",
      description: "Press a keyboard key on the active element or a targeted element. Examples: Enter, Tab, Escape, ArrowDown, a, b, c.",
      parameters: {
        type: "object",
        properties: {
          ...TARGET_PROPERTIES,
          key: {
            type: "string"
          }
        },
        required: ["key"],
        additionalProperties: false
      }
    },
    {
      name: "scroll_to",
      description: "Scroll to an element, or scroll the window to x/y coordinates.",
      parameters: {
        type: "object",
        properties: {
          ...TARGET_PROPERTIES,
          x: {
            type: "integer",
            minimum: 0
          },
          y: {
            type: "integer",
            minimum: 0
          },
          behavior: {
            type: "string",
            enum: ["auto", "smooth"],
            default: "auto"
          }
        },
        additionalProperties: false
      }
    },
    {
      name: "wait",
      description: "Wait for a number of milliseconds before continuing.",
      parameters: {
        type: "object",
        properties: {
          ms: {
            type: "integer",
            minimum: 1,
            maximum: 30000
          }
        },
        required: ["ms"],
        additionalProperties: false
      }
    },
    {
      name: "http_request",
      description: "Make an HTTP request. Use for APIs or fetching other web pages. Only http/https allowed. Network permission may be requested.",
      requiresNetworkPermission: true,
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string"
          },
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
            default: "GET"
          },
          headers: {
            type: "object",
            additionalProperties: {
              type: "string"
            }
          },
          body: {
            type: ["string", "object", "array", "number", "boolean", "null"]
          },
          timeoutMs: {
            type: "integer",
            minimum: 1000,
            maximum: 120000,
            default: 30000
          },
          parseJson: {
            type: "boolean",
            default: true
          },
          maxChars: {
            type: "integer",
            minimum: 1000,
            maximum: 2000000,
            default: 200000
          },
          credentials: {
            type: "string",
            enum: ["omit", "same-origin", "include"],
            default: "omit"
          },
          redirect: {
            type: "string",
            enum: ["follow", "error", "manual"],
            default: "follow"
          }
        },
        required: ["url"],
        additionalProperties: false
      }
    },
    {
      name: "screenshot",
      description: "Capture a screenshot of the bound tab. Requires explicit user permission before image data is sent to the LLM.",
      requiresImagePermission: true,
      parameters: {
        type: "object",
        properties: {
          format: {
            type: "string",
            enum: ["jpeg", "png", "webp"],
            default: "jpeg"
          },
          quality: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 70
          }
        },
        additionalProperties: false
      }
    },
    {
      name: "get_images",
      description: "List images on the page. If includeBase64 is true, image pixels are fetched and require explicit user permission.",
      parameters: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            default: "img"
          },
          maxImages: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            default: 20
          },
          includeBase64: {
            type: "boolean",
            default: false
          },
          maxImageBytes: {
            type: "integer",
            minimum: 10000,
            maximum: 10000000,
            default: 1500000
          }
        },
        additionalProperties: false
      }
    }
  ];

  const AGENT_TOOL_MAP = Object.fromEntries(AGENT_TOOLS.map((tool) => [tool.name, tool]));

  function getOpenAiTools() {
    return AGENT_TOOLS.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }));
  }

  function makeCallId(index) {
    return `call_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function truncateString(value, max = 500) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (!text) return "";
    return text.length > max ? `${text.slice(0, max)}...` : text;
  }

  function validateToolCall(rawToolCall, index = 0) {
    const errors = [];

    const id = rawToolCall && rawToolCall.id ? String(rawToolCall.id) : makeCallId(index);
    const fn = (rawToolCall && rawToolCall.function) || rawToolCall || {};
    const name = fn.name || rawToolCall?.name;

    if (!name) {
      return {
        ok: false,
        includeInAssistant: false,
        name: "unknown_tool",
        normalized: {
          id,
          type: "function",
          function: {
            name: "unknown_tool",
            arguments: "{}"
          }
        },
        args: {},
        errors: [{ path: "function.name", message: "Missing tool name." }],
        requiresImagePermission: false,
        requiresNetworkPermission: false
      };
    }

    const tool = AGENT_TOOL_MAP[name];
    let argsInput = fn.arguments ?? rawToolCall?.arguments ?? {};
    let args = argsInput;

    if (typeof argsInput === "string") {
      const trimmed = argsInput.trim();
      if (!trimmed) {
        args = {};
      } else {
        try {
          args = JSON.parse(trimmed);
        } catch (err) {
          return {
            ok: false,
            includeInAssistant: Boolean(tool),
            name: String(name),
            normalized: {
              id,
              type: "function",
              function: {
                name: String(name),
                arguments: "{}"
              }
            },
            args: {},
            errors: [
              {
                path: "function.arguments",
                message: `Arguments are not valid JSON: ${err.message}`,
                rawArguments: truncateString(argsInput, 500)
              }
            ],
            requiresImagePermission: Boolean(tool && tool.requiresImagePermission),
            requiresNetworkPermission: Boolean(tool && tool.requiresNetworkPermission)
          };
        }
      }
    }

    if (!tool) {
      return {
        ok: false,
        includeInAssistant: false,
        name: String(name),
        normalized: {
          id,
          type: "function",
          function: {
            name: String(name),
            arguments: "{}"
          }
        },
        args: args && typeof args === "object" ? args : {},
        errors: [
          {
            path: "function.name",
            message: `Unknown tool "${name}". Available tools: ${AGENT_TOOLS.map((t) => t.name).join(", ")}.`
          }
        ],
        requiresImagePermission: false,
        requiresNetworkPermission: false
      };
    }

    let result;
    try {
      result = global.normalizeAndValidate(args, tool.parameters || {});
    } catch (err) {
      result = {
        valid: false,
        errors: [{ path: "arguments", message: err.message }],
        value: {}
      };
    }

    let normalizedArgs = result.value;
    if (normalizedArgs === undefined || normalizedArgs === null || typeof normalizedArgs !== "object" || Array.isArray(normalizedArgs)) {
      normalizedArgs = {};
    }

    const requiresImagePermission =
      Boolean(tool.requiresImagePermission) ||
      (tool.name === "get_images" && normalizedArgs.includeBase64 === true);

    return {
      ok: result.valid,
      includeInAssistant: true,
      name: tool.name,
      normalized: {
        id,
        type: "function",
        function: {
          name: tool.name,
          arguments: JSON.stringify(normalizedArgs)
        }
      },
      args: normalizedArgs,
      errors: result.errors,
      requiresImagePermission,
      requiresNetworkPermission: Boolean(tool.requiresNetworkPermission)
    };
  }

  global.AGENT_TOOLS = AGENT_TOOLS;
  global.AGENT_TOOL_MAP = AGENT_TOOL_MAP;
  global.getOpenAiTools = getOpenAiTools;
  global.validateToolCall = validateToolCall;
})(globalThis);
```

---

## 4. `network.js`

Shared HTTP request helper used by the side panel and background service worker.

```js
(function (global) {
  "use strict";

  function clampInt(value, min, max, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  function isBlockedHostname(hostname) {
    const blocked = new Set([
      "169.254.169.254",
      "metadata.google.internal",
      "metadata",
      "0.0.0.0"
    ]);
    return blocked.has(hostname.toLowerCase());
  }

  async function performHttpRequest(args) {
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

  function isLocalOrigin(origin) {
    try {
      const url = new URL(origin);
      return ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(url.hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  function originMatchesPattern(origin, pattern) {
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

  global.performHttpRequest = performHttpRequest;
  global.isLocalOrigin = isLocalOrigin;
  global.originMatchesPattern = originMatchesPattern;
})(globalThis);
```

---

## 5. `background.js`

The background service worker handles privileged tab operations, content-script injection, screenshots, and image fetching.

```js
try {
  importScripts("network.js");
} catch (err) {
  console.error("Failed to import network.js", err);
}

const RESTRICTED_URL_RE =
  /^(chrome|edge|about|chrome-extension|devtools|view-source|file):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

async function configureSidePanel() {
  try {
    await chrome.sidePanel.setOptions({
      enabled: true,
      path: "sidepanel.html"
    });

    await chrome.sidePanel.setPanelBehavior({
      openPanelOnActionClick: false
    });
  } catch (err) {
    console.error("Side panel configuration failed", err);
  }
}

chrome.runtime.onInstalled.addListener(configureSidePanel);
chrome.runtime.onStartup.addListener(configureSidePanel);

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;

  try {
    await chrome.storage.session.set({
      pendingBindTabId: tab.id,
      pendingBindWindowId: tab.windowId
    });

    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (err) {
    console.error("Failed opening side panel", err);
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    } catch (err2) {
      console.error("Fallback side panel open failed", err2);
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (!message || typeof message !== "object") {
        sendResponse({ ok: false, error: "Invalid message." });
        return;
      }

      if (message.type === "executeTool") {
        const result = await handleExecuteTool(message);
        sendResponse(result);
        return;
      }

      if (message.type === "ensureContentScript") {
        const result = await ensureContentScript(message.tabId);
        sendResponse(result);
        return;
      }

      if (message.type === "getTabInfo") {
        const tab = await chrome.tabs.get(message.tabId);
        sendResponse({
          ok: true,
          data: {
            id: tab.id,
            url: tab.url,
            title: tab.title,
            status: tab.status
          }
        });
        return;
      }

      sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();

  return true;
});

async function handleExecuteTool(message) {
  const tool = message.tool;
  const args = message.args || {};
  const tabId = message.tabId;

  if (!tool) {
    return { ok: false, error: "Missing tool name." };
  }

  if (tool === "http_request") {
    return await performHttpRequest(args);
  }

  if (tool === "screenshot") {
    return await screenshotTool(tabId, args);
  }

  if (tool === "wait") {
    const ms = clampInt(args.ms, 1, 30000, 1000);
    await sleep(ms);
    return { ok: true, data: { waitedMs: ms } };
  }

  if (!tabId) {
    return { ok: false, error: "No bound tab. Rebind the agent to a tab." };
  }

  if (tool === "get_images") {
    const metadata = await sendPageTool(tabId, "get_images", {
      selector: args.selector,
      maxImages: args.maxImages
    }, true);

    if (!metadata.ok) return metadata;

    if (args.includeBase64) {
      const fetched = await fetchImagesBase64(metadata.data?.images || [], args);
      return {
        ok: true,
        data: {
          ...metadata.data,
          images: fetched.images,
          _images: fetched._images,
          notes: fetched.notes
        }
      };
    }

    return metadata;
  }

  if (tool === "click") {
    return await clickTool(tabId, args);
  }

  return await sendPageTool(tabId, tool, args, true);
}

function tabsSendMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

function waitForTabComplete(tabId, timeout = 10000) {
  return new Promise(async (resolve) => {
    let done = false;

    const finish = () => {
      if (!done) {
        done = true;
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      }
    };

    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === "complete") {
        finish();
      }
    };

    const timer = setTimeout(finish, timeout);
    chrome.tabs.onUpdated.addListener(listener);

    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") {
        finish();
      }
    } catch {
      finish();
    }
  });
}

async function ensureContentScript(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);

    if (!tab) {
      return { ok: false, error: "Bound tab no longer exists." };
    }

    if (!tab.url || RESTRICTED_URL_RE.test(tab.url)) {
      return {
        ok: false,
        error: `Cannot control this page: ${tab.url || "unknown URL"}. Chrome system pages and extension pages are blocked.`
      };
    }

    if (tab.status !== "complete") {
      await waitForTabComplete(tabId, 10000);
    }

    await chrome.scripting.executeScript({
      target: {
        tabId,
        frameIds: [0]
      },
      files: ["content.js"]
    });

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `Content script injection failed: ${err.message}`
    };
  }
}

async function sendPageTool(tabId, tool, args, retry = true) {
  const ensure = await ensureContentScript(tabId);
  if (!ensure.ok) return ensure;

  const message = {
    type: "PAGE_TOOL",
    tool,
    args
  };

  const attempts = retry ? 2 : 1;
  let lastError = "Unknown error.";

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await tabsSendMessage(tabId, message);

      if (response === undefined) {
        return { ok: false, error: "Content script returned no response." };
      }

      return response;
    } catch (err) {
      lastError = err.message || String(err);

      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) {
        return { ok: false, error: "Bound tab closed." };
      }

      if (tab.status !== "complete") {
        await waitForTabComplete(tabId, 8000);
        await ensureContentScript(tabId);
        continue;
      }

      if (
        /Could not establish connection|Receiving tab does not exist|message port|context invalidated|Extension context invalidated/i.test(
          lastError
        )
      ) {
        await sleep(200);
        await ensureContentScript(tabId);
        continue;
      }

      break;
    }
  }

  return {
    ok: false,
    error: `Page tool failed: ${lastError}`
  };
}

async function clickTool(tabId, args) {
  const ensure = await ensureContentScript(tabId);
  if (!ensure.ok) return ensure;

  const before = await chrome.tabs.get(tabId).catch(() => null);
  const beforeUrl = before?.url;

  try {
    const response = await tabsSendMessage(tabId, {
      type: "PAGE_TOOL",
      tool: "click",
      args
    });

    if (response === undefined) {
      return { ok: false, error: "Content script returned no response." };
    }

    return response;
  } catch (err) {
    const waitAfter = clampInt(args.waitAfterMs, 0, 15000, 350);
    await waitForTabComplete(tabId, Math.min(waitAfter + 8000, 15000));

    const after = await chrome.tabs.get(tabId).catch(() => null);
    if (!after) {
      return { ok: false, error: "Bound tab closed during click." };
    }

    if (after.status === "loading" || after.url !== beforeUrl) {
      return {
        ok: true,
        data: {
          clicked: true,
          navigated: true,
          url: after.url,
          title: after.title,
          status: after.status,
          note: "Click likely caused navigation. The content-script response was lost, but the bound tab updated."
        }
      };
    }

    return {
      ok: false,
      error: `Click failed: ${err.message}`
    };
  }
}

async function screenshotTool(tabId, args) {
  if (!tabId) {
    return { ok: false, error: "No bound tab." };
  }

  const format = ["png", "jpeg", "webp"].includes(args.format) ? args.format : "jpeg";
  const quality = clampInt(args.quality, 1, 100, 70);

  try {
    const base64 = await captureScreenshotWithDebugger(tabId, format, quality);
    const mime = format === "png" ? "image/png" : format === "webp" ? "image/webp" : "image/jpeg";

    return {
      ok: true,
      data: {
        format,
        mime,
        note: "Screenshot captured from bound tab.",
        _images: [`data:${mime};base64,${base64}`]
      }
    };
  } catch (err) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.active) {
        const fallbackFormat = format === "png" ? "png" : "jpeg";
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: fallbackFormat,
          quality: fallbackFormat === "png" ? undefined : quality
        });

        return {
          ok: true,
          data: {
            format: fallbackFormat,
            mime: fallbackFormat === "png" ? "image/png" : "image/jpeg",
            note: "Screenshot captured via visible-tab fallback.",
            _images: [dataUrl]
          }
        };
      }
    } catch {
      // ignore fallback failure
    }

    return {
      ok: false,
      error: `Screenshot failed: ${err.message}. The debugger permission may be denied, or the tab cannot be captured.`
    };
  }
}

function debuggerAttach(target, version) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, version, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

function debuggerSendCommand(target, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params || {}, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

function debuggerDetach(target) {
  return new Promise((resolve) => {
    chrome.debugger.detach(target, () => resolve());
  });
}

async function captureScreenshotWithDebugger(tabId, format, quality) {
  const target = { tabId };
  let attachedByUs = false;

  try {
    await debuggerAttach(target, "1.3");
    attachedByUs = true;
  } catch (err) {
    if (!/Another debugger is already attached/i.test(err.message)) {
      throw err;
    }
  }

  try {
    await debuggerSendCommand(target, "Page.enable", {});

    const params = {
      format,
      captureBeyondViewport: true
    };

    if (format !== "png") {
      params.quality = quality;
    }

    const result = await debuggerSendCommand(target, "Page.captureScreenshot", params);
    return result.data;
  } finally {
    if (attachedByUs) {
      await debuggerDetach(target).catch(() => {});
    }
  }
}

async function fetchImagesBase64(images, args) {
  const maxImages = clampInt(args.maxImages, 1, 10, 3);
  const maxBytes = clampInt(args.maxImageBytes, 10000, 10000000, 1500000);

  const out = [];
  const dataUrls = [];
  const notes = [];

  for (const image of images.slice(0, maxImages)) {
    if (!image.src) {
      out.push({ ...image, error: "No src." });
      continue;
    }

    if (image.src.startsWith("data:")) {
      const match = image.src.match(/^data:(image\/[a-zA-Z0-9+.]+);base64,(.*)$/);
      if (match && match[2].length <= Math.ceil((maxBytes * 4) / 3)) {
        dataUrls.push(image.src);
        out.push({ ...image, mime: match[1], included: true });
      } else {
        out.push({ ...image, error: "Data URL too large or unsupported." });
      }
      continue;
    }

    try {
      const response = await fetch(image.src, {
        credentials: "omit"
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const blob = await response.blob();

      if (!blob.type.startsWith("image/")) {
        throw new Error("Response is not an image.");
      }

      if (blob.size > maxBytes) {
        throw new Error(`Image too large: ${blob.size} bytes.`);
      }

      const dataUrl = await blobToDataUrl(blob);
      dataUrls.push(dataUrl);

      out.push({
        ...image,
        mime: blob.type,
        bytes: blob.size,
        included: true
      });
    } catch (err) {
      out.push({ ...image, error: err.message });
      notes.push(`Failed to fetch ${image.src}: ${err.message}`);
    }
  }

  return {
    images: out,
    _images: dataUrls,
    notes
  };
}

async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }

  return `data:${blob.type};base64,${btoa(binary)}`;
}
```

---

## 6. `content.js`

This runs in the bound tab and performs DOM inspection and interaction.

```js
if (!window.__LOCAL_LLM_AGENT_CONTENT__) {
  window.__LOCAL_LLM_AGENT_CONTENT__ = true;

  const DEFAULT_INTERACTIVE_SELECTOR = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="combobox"]',
    '[role="option"]',
    "[onclick]",
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]',
    "label[for]"
  ].join(", ");

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "PAGE_TOOL") return;

    (async () => {
      try {
        const data = await executeContentTool(message.tool, message.args || {});
        sendResponse({ ok: true, data });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();

    return true;
  });

  async function executeContentTool(tool, args) {
    switch (tool) {
      case "get_page_info":
        return getPageInfo();

      case "get_html":
        return getHtml(args);

      case "get_text":
        return getText(args);

      case "get_interactive_snapshot":
        return getInteractiveSnapshot(args);

      case "click":
        return await clickTool(args);

      case "type_text":
        return typeText(args);

      case "set_value":
        return setValueTool(args);

      case "press_key":
        return pressKeyTool(args);

      case "scroll_to":
        return scrollToTool(args);

      case "get_images":
        return getImages(args);

      default:
        throw new Error(`Unknown content tool: ${tool}`);
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function truncate(value, max) {
    const text = typeof value === "string" ? value : value == null ? "" : String(value);
    const limit = Number.isFinite(max) && max > 0 ? max : 0;

    if (!limit) {
      return {
        text,
        truncated: false,
        originalLength: text.length,
        returnedLength: text.length
      };
    }

    const truncated = text.length > limit;
    const returned = truncated ? text.slice(0, limit) : text;

    return {
      text: returned,
      truncated,
      originalLength: text.length,
      returnedLength: returned.length
    };
  }

  function hasTargetArgs(args) {
    return Boolean(args && (args.ref || args.selector || args.xpath));
  }

  function resolveTarget(args) {
    if (args.ref) {
      const el = document.querySelector(`[data-llm-agent-ref="${CSS.escape(args.ref)}"]`);
      if (el) return el;
    }

    if (args.selector) {
      try {
        const el = document.querySelector(args.selector);
        if (el) return el;
      } catch (err) {
        throw new Error(`Invalid CSS selector: ${err.message}`);
      }
    }

    if (args.xpath) {
      try {
        const result = document.evaluate(args.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        if (result.singleNodeValue) return result.singleNodeValue;
      } catch (err) {
        throw new Error(`Invalid XPath: ${err.message}`);
      }
    }

    if (args.ref) {
      throw new Error(`Ref "${args.ref}" not found. Call get_interactive_snapshot again to refresh refs.`);
    }

    if (args.selector) {
      throw new Error(`Selector "${args.selector}" not found.`);
    }

    if (args.xpath) {
      throw new Error("XPath did not match any element.");
    }

    throw new Error("Provide ref, selector, or xpath.");
  }

  function resolveTargetOptional(args) {
    if (hasTargetArgs(args)) return resolveTarget(args);
    return null;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;

    const style = getComputedStyle(el);
    if (!style) return false;

    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function getAccessibleText(el) {
    if (!el) return "";

    const ariaLabel = el.getAttribute && el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel;

    if (el.tagName === "IMG" && el.alt) return el.alt;

    if (el.id) {
      try {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label && label.textContent) return label.textContent.trim();
      } catch {
        // ignore
      }
    }

    const closestLabel = el.closest && el.closest("label");
    if (closestLabel && closestLabel.textContent) return closestLabel.textContent.trim();

    if (el.placeholder) return el.placeholder;

    if (typeof el.value === "string" && el.value) return el.value;

    const text = (el.innerText || el.textContent || "").trim();
    return text;
  }

  function getPageInfo() {
    const metaDescription =
      document.querySelector('meta[name="description"]')?.content ||
      document.querySelector('meta[property="og:description"]')?.content ||
      "";

    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      metaDescription,
      viewport: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY
      },
      selection: truncate(window.getSelection ? window.getSelection().toString() : "", 5000).text,
      timestamp: new Date().toISOString()
    };
  }

  function removeComments(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
    const nodes = [];

    while (walker.nextNode()) {
      nodes.push(walker.currentNode);
    }

    nodes.forEach((node) => node.remove());
  }

  function getHtml(args) {
    const el = resolveTargetOptional(args) || document.documentElement;
    const clone = el.cloneNode(true);

    if (!args.includeScripts) {
      clone.querySelectorAll("script, noscript").forEach((node) => node.remove());
    }

    if (!args.includeStyles) {
      clone.querySelectorAll("style, link[rel='stylesheet']").forEach((node) => node.remove());
    }

    if (!args.includeComments) {
      removeComments(clone);
    }

    let html = clone.outerHTML;

    if (el === document.documentElement) {
      html = `<!DOCTYPE html>\n${html}`;
    }

    const result = truncate(html, args.maxLength ?? 120000);

    return {
      url: location.href,
      title: document.title,
      selector: args.selector || args.ref || args.xpath || "html",
      html: result.text,
      truncated: result.truncated,
      originalLength: result.originalLength,
      returnedLength: result.returnedLength
    };
  }

  function getText(args) {
    const el = resolveTargetOptional(args) || document.body;
    const text = el.innerText || el.textContent || "";
    const result = truncate(text, args.maxLength ?? 50000);

    return {
      url: location.href,
      title: document.title,
      text: result.text,
      truncated: result.truncated,
      originalLength: result.originalLength,
      returnedLength: result.returnedLength
    };
  }

  function clearRefs() {
    document.querySelectorAll("[data-llm-agent-ref]").forEach((el) => {
      el.removeAttribute("data-llm-agent-ref");
    });
  }

  function getInteractiveSnapshot(args) {
    clearRefs();

    const selector = args.selector || DEFAULT_INTERACTIVE_SELECTOR;
    const includeHidden = Boolean(args.includeHidden);
    const maxElements = Math.min(Math.max(Number.parseInt(args.maxElements, 10) || 200, 1), 500);

    let candidates;
    try {
      candidates = Array.from(document.querySelectorAll(selector));
    } catch (err) {
      throw new Error(`Invalid snapshot selector: ${err.message}`);
    }

    const elements = [];
    let counter = 1;

    for (const el of candidates) {
      if (elements.length >= maxElements) break;
      if (!includeHidden && !isVisible(el)) continue;

      const ref = `e${counter++}`;
      el.setAttribute("data-llm-agent-ref", ref);

      const rect = el.getBoundingClientRect();
      const tag = el.tagName ? el.tagName.toLowerCase() : "";

      const value =
        tag === "input" && el.type === "password"
          ? "••••••"
          : typeof el.value === "string"
            ? el.value
            : undefined;

      elements.push({
        ref,
        tag,
        role: el.getAttribute ? el.getAttribute("role") || undefined : undefined,
        type: el.getAttribute ? el.getAttribute("type") || undefined : undefined,
        id: el.id || undefined,
        name: el.getAttribute ? el.getAttribute("name") || undefined : undefined,
        testId: el.getAttribute ? el.getAttribute("data-testid") || undefined : undefined,
        text: truncate(getAccessibleText(el), 200).text,
        ariaLabel: el.getAttribute ? el.getAttribute("aria-label") || undefined : undefined,
        placeholder: el.placeholder || undefined,
        value,
        href: el.href || undefined,
        disabled: Boolean(el.disabled),
        checked: Boolean(el.checked),
        selected: Boolean(el.selected),
        readOnly: Boolean(el.readOnly),
        contentEditable: Boolean(el.isContentEditable),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      });
    }

    return {
      url: location.href,
      title: document.title,
      count: elements.length,
      elements,
      hint: "Use refs with click, type_text, set_value, press_key, and scroll_to. Call get_interactive_snapshot again after page changes."
    };
  }

  async function clickTool(args) {
    const el = resolveTarget(args);

    if (el.disabled && !args.force) {
      throw new Error("Element is disabled. Use force:true to click anyway.");
    }

    el.scrollIntoView({ block: "center", inline: "center" });
    await sleep(50);

    const beforeUrl = location.href;
    const beforeTitle = document.title;

    if (typeof el.focus === "function") {
      try {
        el.focus({ preventScroll: true });
      } catch {
        // ignore
      }
    }

    simulateClick(el);

    const waitAfterMs = Math.min(Math.max(Number.parseInt(args.waitAfterMs, 10) || 350, 0), 15000);
    await sleep(waitAfterMs);

    return {
      tag: el.tagName ? el.tagName.toLowerCase() : "",
      text: truncate(getAccessibleText(el), 120).text,
      beforeUrl,
      beforeTitle,
      afterUrl: location.href,
      afterTitle: document.title,
      navigated: beforeUrl !== location.href
    };
  }

  function simulateClick(el) {
    const tag = el.tagName ? el.tagName.toUpperCase() : "";
    const type = (el.getAttribute && el.getAttribute("type") || "").toLowerCase();

    if (
      tag === "A" ||
      tag === "BUTTON" ||
      (tag === "INPUT" && ["button", "submit", "reset", "checkbox", "radio"].includes(type))
    ) {
      try {
        el.click();
        return;
      } catch {
        // fall through to synthetic events
      }
    }

    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    const options = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0
    };

    const Pointer = window.PointerEvent || window.MouseEvent;

    try {
      el.dispatchEvent(new Pointer("pointerover", options));
      el.dispatchEvent(new Pointer("pointerenter", options));
      el.dispatchEvent(new Pointer("pointerdown", options));
      el.dispatchEvent(new MouseEvent("mousedown", options));
      el.dispatchEvent(new Pointer("pointerup", options));
      el.dispatchEvent(new MouseEvent("mouseup", options));
      el.dispatchEvent(new MouseEvent("click", options));
    } catch {
      try {
        el.dispatchEvent(new MouseEvent("click", options));
      } catch {
        // ignore
      }
    }
  }

  function dispatchInputEvents(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setNativeValue(el, value) {
    const prototype = Object.getPrototypeOf(el);
    const descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, "value") : undefined;

    if (descriptor && typeof descriptor.set === "function") {
      descriptor.set.call(el, value);
    } else {
      el.value = value;
    }

    dispatchInputEvents(el);
  }

  function clearElement(el) {
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      setNativeValue(el, "");
      return;
    }

    if (el.isContentEditable) {
      el.textContent = "";
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return;
    }

    el.textContent = "";
  }

  function typeText(args) {
    const el = resolveTarget(args);
    const text = args.text == null ? "" : String(args.text);

    const editable =
      el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.isContentEditable;

    if (!editable && !args.force) {
      throw new Error("Target is not an input, textarea, or contenteditable element. Use force:true to force textContent.");
    }

    if ((el.disabled || el.readOnly) && !args.force) {
      throw new Error("Target is disabled or readonly. Use force:true to force typing.");
    }

    el.scrollIntoView({ block: "center", inline: "center" });

    try {
      el.focus({ preventScroll: true });
    } catch {
      // ignore
    }

    if (args.clear) {
      clearElement(el);
    }

    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const nextValue = args.clear ? text : `${el.value || ""}${text}`;
      setNativeValue(el, nextValue);
    } else if (el.isContentEditable) {
      let inserted = false;

      try {
        inserted = document.execCommand("insertText", false, text);
      } catch {
        inserted = false;
      }

      if (!inserted) {
        el.textContent = args.clear ? text : `${el.textContent || ""}${text}`;
        el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      }
    } else {
      el.textContent = args.clear ? text : `${el.textContent || ""}${text}`;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }

    if (args.pressEnter) {
      dispatchKeyEvent(el, "keydown", "Enter", "Enter", 13);
      dispatchKeyEvent(el, "keyup", "Enter", "Enter", 13);
    }

    return {
      typed: text,
      clear: Boolean(args.clear),
      pressEnter: Boolean(args.pressEnter),
      tag: el.tagName ? el.tagName.toLowerCase() : "",
      url: location.href
    };
  }

  function setValueTool(args) {
    const el = resolveTarget(args);
    const rawValue = args.value;

    if (el.type === "checkbox" || el.type === "radio") {
      let checked;

      if (typeof rawValue === "boolean") {
        checked = rawValue;
      } else {
        const normalized = String(rawValue).trim().toLowerCase();
        checked = ["true", "1", "on", "yes", "checked"].includes(normalized);
      }

      el.checked = checked;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));

      return {
        set: true,
        checked,
        tag: el.tagName.toLowerCase(),
        type: el.type
      };
    }

    if (el.tagName === "SELECT") {
      const stringValue = String(rawValue);
      setNativeValue(el, stringValue);

      if (el.value !== stringValue) {
        const option = Array.from(el.options).find((opt) => opt.text.trim() === stringValue.trim());
        if (option) {
          el.value = option.value;
          dispatchInputEvents(el);
        }
      }

      return {
        set: true,
        value: el.value,
        tag: "select"
      };
    }

    setNativeValue(el, rawValue == null ? "" : String(rawValue));

    return {
      set: true,
      value: el.value,
      tag: el.tagName ? el.tagName.toLowerCase() : ""
    };
  }

  function getKeyCode(key) {
    const map = {
      Enter: 13,
      Escape: 27,
      Tab: 9,
      Backspace: 8,
      Delete: 46,
      ArrowLeft: 37,
      ArrowUp: 38,
      ArrowRight: 39,
      ArrowDown: 40,
      " ": 32,
      Spacebar: 32
    };

    if (map[key] !== undefined) return map[key];

    if (key.length === 1) {
      return key.toUpperCase().charCodeAt(0);
    }

    return 0;
  }

  function dispatchKeyEvent(el, type, key, code, keyCode) {
    const event = new KeyboardEvent(type, {
      key,
      code,
      bubbles: true,
      cancelable: true
    });

    try {
      Object.defineProperty(event, "keyCode", { get: () => keyCode });
      Object.defineProperty(event, "which", { get: () => keyCode });
    } catch {
      // ignore
    }

    el.dispatchEvent(event);
  }

  function pressKeyTool(args) {
    const el = hasTargetArgs(args) ? resolveTarget(args) : document.activeElement || document.body;
    const key = String(args.key);
    const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
    const keyCode = getKeyCode(key);

    if (typeof el.focus === "function") {
      try {
        el.focus({ preventScroll: true });
      } catch {
        // ignore
      }
    }

    dispatchKeyEvent(el, "keydown", key, code, keyCode);

    if (key.length === 1) {
      dispatchKeyEvent(el, "keypress", key, code, keyCode);
    }

    dispatchKeyEvent(el, "keyup", key, code, keyCode);

    return {
      key,
      code,
      tag: el.tagName ? el.tagName.toLowerCase() : ""
    };
  }

  function scrollToTool(args) {
    const behavior = args.behavior === "smooth" ? "smooth" : "auto";

    if (hasTargetArgs(args)) {
      const el = resolveTarget(args);
      el.scrollIntoView({ behavior, block: "center", inline: "center" });

      return {
        scrolledToElement: true,
        tag: el.tagName ? el.tagName.toLowerCase() : ""
      };
    }

    const x = Number.parseInt(args.x, 10) || 0;
    const y = Number.parseInt(args.y, 10) || 0;

    window.scrollTo({ left: x, top: y, behavior });

    return {
      scrolledToCoordinates: true,
      x,
      y
    };
  }

  function getImages(args) {
    const selector = args.selector || "img";
    const maxImages = Math.min(Math.max(Number.parseInt(args.maxImages, 10) || 20, 1), 50);

    let nodes;
    try {
      nodes = Array.from(document.querySelectorAll(selector));
    } catch (err) {
      throw new Error(`Invalid image selector: ${err.message}`);
    }

    const images = nodes.slice(0, maxImages).map((img, index) => ({
      index,
      src: img.currentSrc || img.src || undefined,
      alt: img.alt || undefined,
      title: img.title || undefined,
      width: img.naturalWidth || img.width || undefined,
      height: img.naturalHeight || img.height || undefined,
      visible: isVisible(img)
    }));

    return {
      url: location.href,
      title: document.title,
      count: images.length,
      images
    };
  }
}
```

---

## 7. `sidepanel.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Local LLM Browser Agent</title>
  <link rel="stylesheet" href="styles.css" />
  <script src="validator.js" defer></script>
  <script src="tools-schema.js" defer></script>
  <script src="network.js" defer></script>
  <script src="sidepanel.js" defer></script>
</head>
<body>
  <header class="app-header">
    <div class="brand">🤖 Local Agent</div>

    <div class="tab-info" id="tabInfo" title="Bound tab">
      No bound tab
    </div>

    <div class="header-actions">
      <button id="rebindBtn" class="btn small" type="button">Rebind</button>
      <button id="settingsBtn" class="btn small" type="button">Settings</button>
      <button id="clearBtn" class="btn small danger" type="button">Clear</button>
    </div>
  </header>

  <section id="settingsDrawer" class="settings hidden">
    <h2>Settings</h2>

    <label>
      Base URL
      <input id="baseUrlInput" type="text" placeholder="http://localhost:8000" />
    </label>

    <label>
      Models path
      <input id="modelsPathInput" type="text" placeholder="/models" />
    </label>

    <label>
      Chat path
      <input id="chatPathInput" type="text" placeholder="/chat/completions" />
    </label>

    <label>
      API key, optional
      <input id="apiKeyInput" type="password" placeholder="Bearer token if required" />
    </label>

    <label>
      Model
      <select id="modelSelect"></select>
    </label>

    <div class="row">
      <button id="refreshModelsBtn" class="btn" type="button">Refresh models</button>
    </div>

    <div class="grid">
      <label>
        Temperature
        <input id="temperatureInput" type="number" step="0.1" min="0" max="2" />
      </label>

      <label>
        Max tokens
        <input id="maxTokensInput" type="number" min="1" max="32768" />
      </label>

      <label>
        Max tool steps
        <input id="maxToolStepsInput" type="number" min="1" max="50" />
      </label>

      <label>
        Max HTML chars
        <input id="maxHtmlCharsInput" type="number" min="1000" max="1000000" />
      </label>

      <label>
        Max tool result chars
        <input id="maxToolResultCharsInput" type="number" min="1000" max="1000000" />
      </label>

      <label>
        LLM timeout ms
        <input id="requestTimeoutInput" type="number" min="5000" max="600000" />
      </label>

      <label>
        Tool timeout ms
        <input id="toolTimeoutInput" type="number" min="5000" max="300000" />
      </label>
    </div>

    <div class="toggles">
      <label class="toggle">
        <input id="modelVisionToggle" type="checkbox" />
        Model supports vision/images
      </label>

      <label class="toggle">
        <input id="autoLocalhostToggle" type="checkbox" />
        Auto-allow localhost network requests
      </label>
    </div>

    <label>
      Network allowlist, one origin pattern per line
      <textarea id="networkAllowlistInput" rows="4" placeholder="https://api.example.com
https://*.example.com
*"></textarea>
    </label>

    <label>
      Extra system prompt
      <textarea id="systemPromptInput" rows="6" placeholder="Optional instructions for the agent"></textarea>
    </label>

    <div class="row">
      <button id="saveSettingsBtn" class="btn primary" type="button">Save settings</button>
    </div>
  </section>

  <main id="chatLog" class="chat-log" aria-live="polite"></main>

  <div id="statusBar" class="status hidden"></div>

  <footer class="composer">
    <textarea
      id="userInput"
      rows="3"
      placeholder="Ask about this page or tell the agent what to do. Ctrl/Cmd+Enter sends."
    ></textarea>

    <div class="composer-row">
      <label class="toggle">
        <input id="attachHtmlToggle" type="checkbox" />
        Attach page HTML
      </label>

      <div class="spacer"></div>

      <button id="sendBtn" class="btn primary" type="button">Send</button>
      <button id="stopBtn" class="btn danger hidden" type="button">Stop</button>
    </div>
  </footer>

  <div id="modalBackdrop" class="modal-backdrop hidden">
    <div class="modal">
      <h3 id="modalTitle">Permission</h3>
      <p id="modalBody"></p>

      <div class="modal-actions">
        <button id="modalAllowOnce" class="btn primary" type="button">Allow once</button>
        <button id="modalAllowSession" class="btn" type="button">Allow for session</button>
        <button id="modalDeny" class="btn danger" type="button">Deny</button>
      </div>
    </div>
  </div>
</body>
</html>
```

---

## 8. `sidepanel.js`

```js
(() => {
  "use strict";

  const DEFAULT_SYSTEM_PROMPT = `You are a careful browser automation agent running inside a Chrome extension side panel.

Rules:
- You control only the bound browser tab described in the context.
- Do not ask to switch tabs. The extension keeps you bound to the original tab.
- Use tools to inspect the page before answering questions.
- Prefer get_interactive_snapshot, then use refs for click, type_text, set_value, press_key, and scroll_to.
- If a tool call is invalid, you will receive validation errors. Fix the tool call and try again.
- Do not invent refs, selectors, or page facts.
- When finished, answer in plain text without tool calls unless another tool call is needed.`;

  const DEFAULT_SETTINGS = {
    baseUrl: "http://localhost:8000",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    apiKey: "",
    model: "",
    temperature: 0.2,
    maxTokens: 2048,
    maxToolSteps: 12,
    maxHtmlChars: 120000,
    maxToolResultChars: 20000,
    requestTimeoutMs: 120000,
    toolTimeoutMs: 60000,
    autoAttachHtml: true,
    modelSupportsVision: true,
    autoAllowLocalhostNetwork: true,
    networkAllowlist: [],
    systemPrompt: ""
  };

  const TOOL_MAP = globalThis.AGENT_TOOL_MAP || {};

  const state = {
    boundTabId: null,
    boundTab: null,
    messages: [],
    models: [],
    isRunning: false,
    stopped: false,
    abortController: null,
    imagePermission: "prompt",
    sessionAllowedNetworkOrigins: new Set(),
    sessionDeniedNetworkOrigins: new Set(),
    visionFailed: false,
    activePermission: null
  };

  let settings = { ...DEFAULT_SETTINGS };

  const dom = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    cacheDom();
    attachListeners();

    await loadSettings();
    applySettingsToForm();

    await bindInitialTab();
    await refreshBoundTabInfo();

    await loadModels();

    addSystem("Ready. Click the extension icon on a tab to bind the agent, or use Rebind for the current tab.");
  }

  function cacheDom() {
    dom.tabInfo = document.getElementById("tabInfo");
    dom.rebindBtn = document.getElementById("rebindBtn");
    dom.settingsBtn = document.getElementById("settingsBtn");
    dom.clearBtn = document.getElementById("clearBtn");
    dom.settingsDrawer = document.getElementById("settingsDrawer");
    dom.chatLog = document.getElementById("chatLog");
    dom.statusBar = document.getElementById("statusBar");
    dom.userInput = document.getElementById("userInput");
    dom.attachHtmlToggle = document.getElementById("attachHtmlToggle");
    dom.sendBtn = document.getElementById("sendBtn");
    dom.stopBtn = document.getElementById("stopBtn");

    dom.baseUrlInput = document.getElementById("baseUrlInput");
    dom.modelsPathInput = document.getElementById("modelsPathInput");
    dom.chatPathInput = document.getElementById("chatPathInput");
    dom.apiKeyInput = document.getElementById("apiKeyInput");
    dom.modelSelect = document.getElementById("modelSelect");
    dom.refreshModelsBtn = document.getElementById("refreshModelsBtn");
    dom.temperatureInput = document.getElementById("temperatureInput");
    dom.maxTokensInput = document.getElementById("maxTokensInput");
    dom.maxToolStepsInput = document.getElementById("maxToolStepsInput");
    dom.maxHtmlCharsInput = document.getElementById("maxHtmlCharsInput");
    dom.maxToolResultCharsInput = document.getElementById("maxToolResultCharsInput");
    dom.requestTimeoutInput = document.getElementById("requestTimeoutInput");
    dom.toolTimeoutInput = document.getElementById("toolTimeoutInput");
    dom.modelVisionToggle = document.getElementById("modelVisionToggle");
    dom.autoLocalhostToggle = document.getElementById("autoLocalhostToggle");
    dom.networkAllowlistInput = document.getElementById("networkAllowlistInput");
    dom.systemPromptInput = document.getElementById("systemPromptInput");
    dom.saveSettingsBtn = document.getElementById("saveSettingsBtn");

    dom.modalBackdrop = document.getElementById("modalBackdrop");
    dom.modalTitle = document.getElementById("modalTitle");
    dom.modalBody = document.getElementById("modalBody");
    dom.modalAllowOnce = document.getElementById("modalAllowOnce");
    dom.modalAllowSession = document.getElementById("modalAllowSession");
    dom.modalDeny = document.getElementById("modalDeny");
  }

  function attachListeners() {
    dom.sendBtn.addEventListener("click", onSend);
    dom.stopBtn.addEventListener("click", onStop);
    dom.clearBtn.addEventListener("click", onClear);
    dom.settingsBtn.addEventListener("click", () => dom.settingsDrawer.classList.toggle("hidden"));
    dom.rebindBtn.addEventListener("click", onRebind);
    dom.refreshModelsBtn.addEventListener("click", loadModels);
    dom.saveSettingsBtn.addEventListener("click", saveSettings);

    dom.userInput.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        onSend();
      }
    });

    dom.attachHtmlToggle.addEventListener("change", async () => {
      settings.autoAttachHtml = dom.attachHtmlToggle.checked;
      await chrome.storage.local.set({ settings });
    });

    dom.modelSelect.addEventListener("change", async () => {
      settings.model = dom.modelSelect.value;
      await chrome.storage.local.set({ settings });
    });

    dom.modalAllowOnce.addEventListener("click", () => closePermission({ allow: true, scope: "once" }));
    dom.modalAllowSession.addEventListener("click", () => closePermission({ allow: true, scope: "session" }));
    dom.modalDeny.addEventListener("click", () => closePermission({ allow: false, scope: "session" }));

    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (tabId !== state.boundTabId) return;

      if (changeInfo.title || changeInfo.url || changeInfo.status) {
        refreshBoundTabInfo().catch(() => {});
      }

      if (changeInfo.status === "complete") {
        ensureBoundContentScript().catch(() => {});
      }
    });

    chrome.tabs.onRemoved.addListener((tabId) => {
      if (tabId === state.boundTabId) {
        state.boundTabId = null;
        state.boundTab = null;
        refreshBoundTabInfo().catch(() => {});
        addSystem("Bound tab closed. Click Rebind to attach to another tab.");
      }
    });
  }

  async function loadSettings() {
    const stored = await chrome.storage.local.get("settings");
    settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...(stored.settings || {}) });
  }

  function normalizeSettings(input) {
    const networkAllowlist = Array.isArray(input.networkAllowlist)
      ? input.networkAllowlist
      : String(input.networkAllowlist || "")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);

    return {
      ...DEFAULT_SETTINGS,
      ...input,
      baseUrl: String(input.baseUrl || DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ""),
      modelsPath: ensureLeadingSlash(input.modelsPath || DEFAULT_SETTINGS.modelsPath),
      chatPath: ensureLeadingSlash(input.chatPath || DEFAULT_SETTINGS.chatPath),
      apiKey: String(input.apiKey || ""),
      model: String(input.model || ""),
      temperature: Number(input.temperature),
      maxTokens: Number.parseInt(input.maxTokens, 10),
      maxToolSteps: Number.parseInt(input.maxToolSteps, 10),
      maxHtmlChars: Number.parseInt(input.maxHtmlChars, 10),
      maxToolResultChars: Number.parseInt(input.maxToolResultChars, 10),
      requestTimeoutMs: Number.parseInt(input.requestTimeoutMs, 10),
      toolTimeoutMs: Number.parseInt(input.toolTimeoutMs, 10),
      autoAttachHtml: Boolean(input.autoAttachHtml),
      modelSupportsVision: Boolean(input.modelSupportsVision),
      autoAllowLocalhostNetwork: Boolean(input.autoAllowLocalhostNetwork),
      networkAllowlist,
      systemPrompt: String(input.systemPrompt || "")
    };
  }

  function applySettingsToForm() {
    dom.baseUrlInput.value = settings.baseUrl;
    dom.modelsPathInput.value = settings.modelsPath;
    dom.chatPathInput.value = settings.chatPath;
    dom.apiKeyInput.value = settings.apiKey;
    dom.temperatureInput.value = settings.temperature;
    dom.maxTokensInput.value = settings.maxTokens;
    dom.maxToolStepsInput.value = settings.maxToolSteps;
    dom.maxHtmlCharsInput.value = settings.maxHtmlChars;
    dom.maxToolResultCharsInput.value = settings.maxToolResultChars;
    dom.requestTimeoutInput.value = settings.requestTimeoutMs;
    dom.toolTimeoutInput.value = settings.toolTimeoutMs;
    dom.modelVisionToggle.checked = settings.modelSupportsVision;
    dom.autoLocalhostToggle.checked = settings.autoAllowLocalhostNetwork;
    dom.networkAllowlistInput.value = (settings.networkAllowlist || []).join("\n");
    dom.systemPromptInput.value = settings.systemPrompt;
    dom.attachHtmlToggle.checked = settings.autoAttachHtml;

    populateModelSelect(state.models);
  }

  async function saveSettings() {
    const formSettings = {
      baseUrl: dom.baseUrlInput.value.trim(),
      modelsPath: dom.modelsPathInput.value.trim(),
      chatPath: dom.chatPathInput.value.trim(),
      apiKey: dom.apiKeyInput.value.trim(),
      model: dom.modelSelect.value,
      temperature: dom.temperatureInput.value,
      maxTokens: dom.maxTokensInput.value,
      maxToolSteps: dom.maxToolStepsInput.value,
      maxHtmlChars: dom.maxHtmlCharsInput.value,
      maxToolResultChars: dom.maxToolResultCharsInput.value,
      requestTimeoutMs: dom.requestTimeoutInput.value,
      toolTimeoutMs: dom.toolTimeoutInput.value,
      autoAttachHtml: dom.attachHtmlToggle.checked,
      modelSupportsVision: dom.modelVisionToggle.checked,
      autoAllowLocalhostNetwork: dom.autoLocalhostToggle.checked,
      networkAllowlist: dom.networkAllowlistInput.value,
      systemPrompt: dom.systemPromptInput.value
    };

    settings = normalizeSettings(formSettings);
    await chrome.storage.local.set({ settings });

    addSystem("Settings saved.");
    await loadModels();
  }

  async function bindInitialTab() {
    try {
      const pending = await chrome.storage.session.get("pendingBindTabId");

      if (pending && pending.pendingBindTabId) {
        state.boundTabId = pending.pendingBindTabId;
        await chrome.storage.session.remove("pendingBindTabId");
        return;
      }
    } catch {
      // ignore
    }

    state.boundTabId = await getActiveTabIdInLastNormalWindow();
  }

  async function getActiveTabIdInLastNormalWindow() {
    try {
      const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
      const tabs = await chrome.tabs.query({ active: true, windowId: win.id });
      return tabs[0]?.id || null;
    } catch {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs[0]?.id || null;
    }
  }

  async function onRebind() {
    state.boundTabId = await getActiveTabIdInLastNormalWindow();
    await refreshBoundTabInfo();
    await ensureBoundContentScript();

    if (state.boundTabId) {
      addSystem(`Rebound agent to tab #${state.boundTabId}.`);
    } else {
      addError("Could not find an active tab to bind.");
    }
  }

  async function refreshBoundTabInfo() {
    if (!state.boundTabId) {
      state.boundTab = null;
      dom.tabInfo.textContent = "No bound tab";
      return;
    }

    try {
      const tab = await chrome.tabs.get(state.boundTabId);
      state.boundTab = tab;

      const label = tab.title || tab.url || `Tab ${tab.id}`;
      dom.tabInfo.textContent = `${truncate(label, 60)} (#${tab.id})`;
      dom.tabInfo.title = `${tab.url || ""}\nTab ID: ${tab.id}`;
    } catch {
      state.boundTabId = null;
      state.boundTab = null;
      dom.tabInfo.textContent = "Bound tab closed";
    }
  }

  async function ensureBoundContentScript() {
    if (!state.boundTabId) return;

    await sendMessageWithTimeout(
      {
        type: "ensureContentScript",
        tabId: state.boundTabId
      },
      10000
    );
  }

  async function loadModels() {
    dom.refreshModelsBtn.disabled = true;
    setStatus("Loading models...");

    try {
      const models = await fetchModels();
      state.models = models;
      populateModelSelect(models);

      if (!settings.model && models.length) {
        settings.model = models[0];
        await chrome.storage.local.set({ settings });
        populateModelSelect(models);
      }

      setStatus("");
    } catch (err) {
      setStatus("");
      addError(`Could not load models: ${err.message}`);
      populateModelSelect([]);
    } finally {
      dom.refreshModelsBtn.disabled = false;
    }
  }

  function populateModelSelect(models) {
    const current = settings.model || "";
    const options = new Set(models || []);

    if (current) {
      options.add(current);
    }

    dom.modelSelect.innerHTML = "";

    if (!options.size) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No models found";
      dom.modelSelect.appendChild(option);
      return;
    }

    for (const model of options) {
      const option = document.createElement("option");
      option.value = model;
      option.textContent = model;
      dom.modelSelect.appendChild(option);
    }

    dom.modelSelect.value = current;
  }

  async function fetchModels() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    try {
      const headers = {};
      if (settings.apiKey) {
        headers.Authorization = `Bearer ${settings.apiKey}`;
      }

      const response = await fetch(joinUrl(settings.baseUrl, settings.modelsPath), {
        headers,
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Models endpoint returned HTTP ${response.status}.`);
      }

      const text = await response.text();

      try {
        const json = JSON.parse(text);
        return parseModelsJson(json);
      } catch {
        return text
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  function parseModelsJson(json) {
    const out = [];

    const addItem = (item) => {
      if (!item) return;

      if (typeof item === "string") {
        out.push(item);
        return;
      }

      if (typeof item === "object") {
        const id = item.id || item.name || item.model || item.slug || item.title;
        if (id) out.push(String(id));
      }
    };

    if (Array.isArray(json)) {
      json.forEach(addItem);
    } else if (json && typeof json === "object") {
      if (Array.isArray(json.data)) {
        json.data.forEach(addItem);
      } else if (Array.isArray(json.models)) {
        json.models.forEach(addItem);
      } else if (Array.isArray(json.results)) {
        json.results.forEach(addItem);
      } else {
        for (const value of Object.values(json)) {
          if (Array.isArray(value)) {
            value.forEach(addItem);
          } else {
            addItem(value);
          }
        }
      }
    }

    return [...new Set(out)];
  }

  async function onSend() {
    const text = dom.userInput.value.trim();

    if (!text || state.isRunning) return;

    if (!state.boundTabId) {
      addError("No bound tab. Click Rebind to attach the agent to the current tab.");
      return;
    }

    dom.userInput.value = "";
    addUserMessage(text);

    state.messages.push({
      role: "user",
      content: text
    });

    await runAgent({ attachHtml: dom.attachHtmlToggle.checked });
  }

  function onStop() {
    state.stopped = true;

    if (state.abortController) {
      state.abortController.abort();
    }

    if (state.activePermission) {
      closePermission({ allow: false, scope: "once" });
    }

    setStatus("Stopping...");
  }

  function onClear() {
    if (!confirm("Clear chat history and permissions for this session?")) return;

    state.messages = [];
    state.imagePermission = "prompt";
    state.sessionAllowedNetworkOrigins.clear();
    state.sessionDeniedNetworkOrigins.clear();
    state.visionFailed = false;
    dom.chatLog.innerHTML = "";

    addSystem("Chat cleared.");
  }

  async function runAgent({ attachHtml = false } = {}) {
    if (state.isRunning) return;

    setRunning(true);
    state.stopped = false;
    state.visionFailed = false;

    let finalAnswer = null;
    let step = 0;
    let apiMessages;

    try {
      apiMessages = await buildInitialApiMessages(attachHtml);

      while (step < settings.maxToolSteps) {
        if (state.stopped) break;

        step += 1;
        setStatus(`Step ${step}: calling model...`);

        let response;

        try {
          response = await llmChat(apiMessages);
        } catch (err) {
          if (!state.stopped && looksLikeImageError(err) && containsImages(apiMessages) && !state.visionFailed) {
            state.visionFailed = true;

            const stripped = stripImages(apiMessages);
            apiMessages.splice(0, apiMessages.length, ...stripped);

            addSystem("Model appears not to support image content. Retrying without images.");
            continue;
          }

          throw err;
        }

        const parsed = parseAssistantResponse(response);

        const assistantMessage = {
          role: "assistant",
          content: parsed.content || ""
        };

        const stepMessages = [];

        if (parsed.tool_calls && parsed.tool_calls.length) {
          const validations = parsed.tool_calls.map((toolCall, index) => validateToolCall(toolCall, index));
          const included = validations.filter((validation) => validation.includeInAssistant);

          if (included.length) {
            assistantMessage.tool_calls = included.map((validation) => validation.normalized);
          }

          addAssistantMessage(parsed.content || "", validations);

          apiMessages.push(assistantMessage);
          stepMessages.push(assistantMessage);

          for (const validation of included) {
            if (state.stopped) break;

            setStatus(`Step ${step}: running ${validation.name}...`);

            let result;

            if (!validation.ok) {
              result = {
                ok: false,
                error: {
                  code: "invalid_tool_call",
                  tool: validation.name,
                  validation_errors: validation.errors,
                  instruction: "Fix the tool call arguments and try again."
                }
              };
            } else {
              result = await executeToolWithPermissions(validation.name, validation.args || {});
            }

            const imagePayloads = extractImages(result);

            if (imagePayloads.length && (!settings.modelSupportsVision || state.visionFailed)) {
              if (result && result.data && typeof result.data === "object") {
                result.data.imagePixelsOmitted = true;
                result.data.note =
                  result.data.note ||
                  "Image pixels were captured but not sent to the model because vision is disabled or failed.";
              }
            }

            const toolMessage = {
              role: "tool",
              tool_call_id: validation.normalized.id,
              content: stringifyToolResult(result)
            };

            apiMessages.push(toolMessage);
            stepMessages.push(toolMessage);

            addToolResult(validation, result);

            if (imagePayloads.length && settings.modelSupportsVision && !state.visionFailed) {
              const imageMessage = {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `Images for tool call ${validation.normalized.id}:`
                  },
                  ...imagePayloads.map((url) => ({
                    type: "image_url",
                    image_url: { url }
                  }))
                ]
              };

              apiMessages.push(imageMessage);
            }
          }

          const notIncluded = validations.filter((validation) => !validation.includeInAssistant);

          if (notIncluded.length && !state.stopped) {
            const errorMessage = {
              role: "user",
              content:
                `Your previous response contained invalid or unknown tool calls:\n` +
                `${JSON.stringify(notIncluded.map((v) => ({ tool: v.name, errors: v.errors })), null, 2)}\n` +
                `Respond with valid tool calls from the available tools or a final answer.`
            };

            apiMessages.push(errorMessage);
            stepMessages.push(errorMessage);

            addSystem("Sent tool validation errors back to the model.");
          }

          if (!state.stopped) {
            state.messages.push(...stepMessages);
            continue;
          }

          break;
        }

        if (parsed.invalidToolJsonErrors && parsed.invalidToolJsonErrors.length && !parsed.content) {
          assistantMessage.content = parsed.rawContent || "";

          addAssistantMessage(assistantMessage.content || "(invalid response)", []);

          apiMessages.push(assistantMessage);
          stepMessages.push(assistantMessage);

          const errorMessage = {
            role: "user",
            content:
              `Your previous response could not be parsed as a valid tool call or final answer. ` +
              `Errors: ${parsed.invalidToolJsonErrors.join("; ")}. ` +
              `Use a valid tool_calls array or a plain final answer.`
          };

          apiMessages.push(errorMessage);
          stepMessages.push(errorMessage);

          state.messages.push(...stepMessages);

          addSystem("Sent parse errors back to the model.");
          continue;
        }

        finalAnswer = parsed.content || "(empty response)";
        assistantMessage.content = finalAnswer;

        addAssistantMessage(finalAnswer, []);
        state.messages.push(assistantMessage);

        break;
      }

      if (!finalAnswer && step >= settings.maxToolSteps) {
        addSystem(`Stopped after ${settings.maxToolSteps} tool steps.`);
      }

      if (state.stopped) {
        addSystem("Agent stopped.");
      }
    } catch (err) {
      addError(err.message || String(err));
    } finally {
      setRunning(false);
      setStatus("");
    }
  }

  async function buildInitialApiMessages(attachHtml) {
    const messages = [buildSystemMessage()];

    if (attachHtml) {
      messages.push(await buildHtmlContextMessage());
    }

    return messages.concat(state.messages);
  }

  function buildSystemMessage() {
    const customPrompt = settings.systemPrompt && settings.systemPrompt.trim() ? settings.systemPrompt.trim() : DEFAULT_SYSTEM_PROMPT;

    const tab = state.boundTab || {};

    return {
      role: "system",
      content:
        `${customPrompt}\n\n` +
        `Bound tab title: ${tab.title || "unknown"}\n` +
        `Bound tab URL: ${tab.url || "unknown"}\n` +
        `Bound tab ID: ${state.boundTabId || "unknown"}\n` +
        `Current time: ${new Date().toISOString()}\n\n` +
        `Important: stay attached to this bound tab. Do not request tab switches.`
    };
  }

  async function buildHtmlContextMessage() {
    const result = await executePrivilegedTool("get_html", {
      maxLength: settings.maxHtmlChars,
      includeScripts: false,
      includeStyles: false,
      includeComments: false
    });

    if (!result.ok) {
      return {
        role: "system",
        content: `Failed to read bound page HTML: ${result.error}`
      };
    }

    const html = result.data?.html || "";

    return {
      role: "system",
      content:
        `Current bound page HTML, truncated to ${settings.maxHtmlChars} characters:\n\n` +
        truncate(html, settings.maxHtmlChars)
    };
  }

  async function llmChat(messages) {
    if (!settings.model) {
      throw new Error("No model selected. Open Settings and choose a model.");
    }

    const controller = new AbortController();
    state.abortController = controller;

    const timer = setTimeout(() => controller.abort(), settings.requestTimeoutMs);

    try {
      const headers = {
        "Content-Type": "application/json"
      };

      if (settings.apiKey) {
        headers.Authorization = `Bearer ${settings.apiKey}`;
      }

      const body = {
        model: settings.model,
        messages,
        tools: getOpenAiTools(),
        tool_choice: "auto",
        stream: false
      };

      if (Number.isFinite(settings.temperature)) {
        body.temperature = settings.temperature;
      }

      if (Number.isFinite(settings.maxTokens) && settings.maxTokens > 0) {
        body.max_tokens = settings.maxTokens;
      }

      const response = await fetch(joinUrl(settings.baseUrl, settings.chatPath), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`LLM HTTP ${response.status}: ${truncate(errorText, 800)}`);
      }

      return await response.json();
    } catch (err) {
      if (err.name === "AbortError") {
        throw new Error("LLM request timed out or was stopped.");
      }

      throw err;
    } finally {
      clearTimeout(timer);
      state.abortController = null;
    }
  }

  function parseAssistantResponse(response) {
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

  function messageContentToText(content) {
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

  function extractJson(text) {
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

  function convertParsedToToolCalls(parsed) {
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

  function convertParsedToolCall(obj, index) {
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

  async function executeToolWithPermissions(name, args) {
    try {
      if (name === "screenshot" || (name === "get_images" && args.includeBase64)) {
        const permission = await requestPermission(
          "image",
          `The model wants to use "${name}" to read image data from the page.`
        );

        if (!permission.allow) {
          return {
            ok: false,
            error: "Permission denied: image reading is blocked by the user."
          };
        }

        if (permission.scope === "session") {
          state.imagePermission = "allow-session";
        }
      }

      if (name === "http_request") {
        let url;

        try {
          url = new URL(args.url);
        } catch {
          return { ok: false, error: "Invalid URL in http_request tool." };
        }

        if (!["http:", "https:"].includes(url.protocol)) {
          return { ok: false, error: "Only http and https URLs are allowed." };
        }

        const origin = url.origin;

        if (state.sessionDeniedNetworkOrigins.has(origin)) {
          return {
            ok: false,
            error: `Permission denied: network requests to ${origin} are blocked for this session.`
          };
        }

        if (!isNetworkAllowed(origin)) {
          const permission = await requestPermission(
            "network",
            `The model wants to make an HTTP request to ${origin}.`,
            { origin }
          );

          if (!permission.allow) {
            state.sessionDeniedNetworkOrigins.add(origin);
            return {
              ok: false,
              error: `Permission denied: network request to ${origin} blocked by user.`
            };
          }

          if (permission.scope === "session") {
            state.sessionAllowedNetworkOrigins.add(origin);
          }
        }

        return await performHttpRequest(args);
      }

      return await executePrivilegedTool(name, args);
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  function isNetworkAllowed(origin) {
    if (state.sessionAllowedNetworkOrigins.has(origin)) return true;
    if (state.sessionDeniedNetworkOrigins.has(origin)) return false;

    if (settings.autoAllowLocalhostNetwork && isLocalOrigin(origin)) return true;

    return (settings.networkAllowlist || []).some((pattern) => originMatchesPattern(origin, pattern));
  }

  function executePrivilegedTool(name, args) {
    return sendMessageWithTimeout(
      {
        type: "executeTool",
        tool: name,
        args,
        tabId: state.boundTabId
      },
      settings.toolTimeoutMs || 60000
    );
  }

  function sendMessageWithTimeout(message, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;

      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          resolve({ ok: false, error: "Extension message timed out." });
        }
      }, timeoutMs);

      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (done) return;

          done = true;
          clearTimeout(timer);

          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }

          resolve(response || { ok: false, error: "No response from background." });
        });
      } catch (err) {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve({ ok: false, error: err.message || String(err) });
        }
      }
    });
  }

  function requestPermission(kind, message, meta = {}) {
    if (kind === "image") {
      if (state.imagePermission === "allow-session") {
        return Promise.resolve({ allow: true, scope: "session" });
      }

      if (state.imagePermission === "deny-session") {
        return Promise.resolve({ allow: false, scope: "session" });
      }
    }

    return new Promise((resolve) => {
      state.activePermission = {
        kind,
        message,
        meta,
        resolve
      };

      dom.modalTitle.textContent = kind === "image" ? "Image permission" : "Network permission";
      dom.modalBody.textContent = `${message} Allow?`;
      dom.modalBackdrop.classList.remove("hidden");
    });
  }

  function closePermission(response) {
    if (!state.activePermission) return;

    const active = state.activePermission;

    if (active.kind === "image") {
      if (response.allow && response.scope === "session") {
        state.imagePermission = "allow-session";
      }

      if (!response.allow && response.scope === "session") {
        state.imagePermission = "deny-session";
      }
    }

    if (active.kind === "network") {
      const origin = active.meta && active.meta.origin;

      if (origin) {
        if (response.allow && response.scope === "session") {
          state.sessionAllowedNetworkOrigins.add(origin);
        }

        if (!response.allow && response.scope === "session") {
          state.sessionDeniedNetworkOrigins.add(origin);
        }
      }
    }

    state.activePermission = null;
    dom.modalBackdrop.classList.add("hidden");
    active.resolve(response);
  }

  function extractImages(result) {
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

  function stringifyToolResult(result) {
    try {
      const clean = JSON.parse(JSON.stringify(result));
      const text = JSON.stringify(clean);

      if (text.length > settings.maxToolResultChars) {
        return `${text.slice(0, settings.maxToolResultChars)}\n...[truncated]`;
      }

      return text;
    } catch {
      return String(result);
    }
  }

  function containsImages(messages) {
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

  function stripImages(messages) {
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

  function looksLikeImageError(err) {
    const message = String(err.message || err);
    return /image|vision|multimodal|image_url|content part/i.test(message);
  }

  function addUserMessage(text) {
    const body = createMessage("user", "You");
    addParagraph(body, text);
  }

  function addAssistantMessage(text, validations = []) {
    const body = createMessage("assistant", "Agent");

    if (text) {
      addParagraph(body, text);
    }

    if (validations.length) {
      const chips = document.createElement("div");
      chips.className = "tool-chips";

      validations.forEach((validation) => {
        const chip = document.createElement("span");
        chip.className = `chip ${validation.ok ? "ok" : "invalid"}`;
        chip.textContent = `${validation.name || "unknown"}${validation.ok ? "" : " invalid"}`;
        chips.appendChild(chip);
      });

      body.appendChild(chips);
    }

    if (!text && validations.length) {
      addParagraph(body, "Calling tools...");
    }
  }

  function addToolResult(validation, result) {
    const ok = Boolean(result && result.ok);
    const body = createMessage(ok ? "tool" : "error", `Tool: ${validation.name}`);

    const pre = document.createElement("pre");

    const payload = {
      arguments: validation.args ?? validation.normalized?.function?.arguments,
      result
    };

    pre.textContent = truncate(JSON.stringify(payload, null, 2), 8000);
    body.appendChild(pre);
  }

  function addSystem(text) {
    const body = createMessage("system", "System");
    addParagraph(body, text);
  }

  function addError(text) {
    const body = createMessage("error", "Error");
    addParagraph(body, text);
  }

  function createMessage(className, title) {
    const article = document.createElement("article");
    article.className = `message ${className}`;

    const header = document.createElement("header");
    header.className = "message-title";
    header.textContent = title;

    const body = document.createElement("div");
    body.className = "message-body";

    article.appendChild(header);
    article.appendChild(body);
    dom.chatLog.appendChild(article);

    scrollToBottom();

    return body;
  }

  function addParagraph(container, text) {
    const p = document.createElement("p");
    p.textContent = text;
    container.appendChild(p);
    scrollToBottom();
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
    });
  }

  function setStatus(text) {
    if (text) {
      dom.statusBar.textContent = text;
      dom.statusBar.classList.remove("hidden");
    } else {
      dom.statusBar.textContent = "";
      dom.statusBar.classList.add("hidden");
    }
  }

  function setRunning(running) {
    state.isRunning = running;

    dom.sendBtn.disabled = running;
    dom.userInput.disabled = running;
    dom.stopBtn.classList.toggle("hidden", !running);

    if (running) {
      state.stopped = false;
    }
  }

  function joinUrl(base, path) {
    return `${String(base).replace(/\/+$/, "")}${ensureLeadingSlash(path)}`;
  }

  function ensureLeadingSlash(path) {
    const value = String(path || "");
    return value.startsWith("/") ? value : `/${value}`;
  }

  function truncate(value, max = 500) {
    const text = typeof value === "string" ? value : value == null ? "" : String(value);
    if (!Number.isFinite(max) || max <= 0) return text;
    return text.length > max ? `${text.slice(0, max)}...` : text;
  }
})();
```

---

## 9. `styles.css`

Neobrutalist, happy pastel UI.

```css
:root {
  --ink: #111111;
  --bg: #fff7fb;
  --card: #ffffff;
  --pink: #ffd6e8;
  --green: #c7f9cc;
  --blue: #bde0fe;
  --yellow: #fff3b0;
  --purple: #e4c1f9;
  --orange: #ffd8a8;
  --danger: #ff9999;
  --shadow: 5px 5px 0 0 var(--ink);
  --shadow-lg: 8px 8px 0 0 var(--ink);
}

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  padding: 0;
  height: 100%;
}

body {
  width: 100%;
  min-width: 320px;
  height: 100vh;
  display: flex;
  flex-direction: column;
  background:
    linear-gradient(135deg, var(--pink) 0%, var(--blue) 45%, var(--green) 100%);
  color: var(--ink);
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
}

.hidden {
  display: none !important;
}

.app-header {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 10px;
  align-items: center;
  padding: 12px;
  background: var(--yellow);
  border-bottom: 4px solid var(--ink);
}

.brand {
  font-size: 18px;
  font-weight: 900;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  background: var(--purple);
  border: 3px solid var(--ink);
  box-shadow: var(--shadow);
  padding: 8px 10px;
}

.tab-info {
  min-width: 0;
  padding: 8px 10px;
  background: var(--card);
  border: 3px solid var(--ink);
  box-shadow: var(--shadow);
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-actions {
  display: flex;
  gap: 8px;
}

.btn {
  appearance: none;
  cursor: pointer;
  border: 3px solid var(--ink);
  box-shadow: var(--shadow);
  background: var(--orange);
  color: var(--ink);
  font-weight: 900;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 10px 12px;
  transition:
    transform 80ms ease,
    box-shadow 80ms ease;
}

.btn:hover {
  transform: translate(-1px, -1px);
  box-shadow: 6px 6px 0 0 var(--ink);
}

.btn:active {
  transform: translate(5px, 5px);
  box-shadow: none;
}

.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
  transform: none;
  box-shadow: var(--shadow);
}

.btn.small {
  padding: 7px 9px;
  font-size: 12px;
}

.btn.primary {
  background: var(--green);
}

.btn.danger {
  background: var(--danger);
}

.settings {
  margin: 12px;
  padding: 12px;
  background: var(--card);
  border: 4px solid var(--ink);
  box-shadow: var(--shadow-lg);
  max-height: 45vh;
  overflow: auto;
}

.settings h2 {
  margin: 0 0 12px;
  font-size: 20px;
  text-transform: uppercase;
}

.settings label,
.composer label {
  display: block;
  font-weight: 800;
  margin-bottom: 10px;
}

.settings input[type="text"],
.settings input[type="password"],
.settings input[type="number"],
.settings select,
.settings textarea,
.composer textarea {
  width: 100%;
  margin-top: 6px;
  padding: 10px;
  border: 3px solid var(--ink);
  box-shadow: inset 3px 3px 0 rgba(17, 17, 17, 0.08);
  background: #fff;
  font: inherit;
  font-weight: 600;
}

.settings textarea,
.composer textarea {
  resize: vertical;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
}

.row {
  margin: 12px 0;
}

.toggles {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 12px 0;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: var(--blue);
  border: 3px solid var(--ink);
  box-shadow: var(--shadow);
  font-weight: 800;
  margin: 0;
}

.toggle input {
  width: 18px;
  height: 18px;
  accent-color: #111;
}

.chat-log {
  flex: 1;
  overflow: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.message {
  border: 4px solid var(--ink);
  box-shadow: var(--shadow-lg);
  background: var(--card);
  padding: 10px;
}

.message-title {
  font-weight: 900;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 3px solid var(--ink);
}

.message-body p {
  margin: 0 0 8px;
  white-space: pre-wrap;
  word-break: break-word;
  font-weight: 600;
}

.message-body p:last-child {
  margin-bottom: 0;
}

.message.user {
  background: var(--blue);
}

.message.assistant {
  background: var(--green);
}

.message.tool {
  background: var(--purple);
}

.message.system {
  background: var(--yellow);
}

.message.error {
  background: var(--danger);
}

.tool-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.chip {
  display: inline-block;
  padding: 4px 8px;
  border: 3px solid var(--ink);
  background: var(--card);
  font-size: 12px;
  font-weight: 900;
  text-transform: uppercase;
}

.chip.ok {
  background: var(--green);
}

.chip.invalid {
  background: var(--danger);
}

pre {
  margin: 8px 0 0;
  padding: 8px;
  background: #fff;
  border: 3px solid var(--ink);
  box-shadow: inset 3px 3px 0 rgba(17, 17, 17, 0.08);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow: auto;
  font-family:
    ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    monospace;
  font-size: 12px;
}

.status {
  margin: 0 12px 10px;
  padding: 10px;
  border: 3px solid var(--ink);
  box-shadow: var(--shadow);
  background: var(--orange);
  font-weight: 900;
}

.composer {
  padding: 12px;
  background: var(--pink);
  border-top: 4px solid var(--ink);
}

.composer textarea {
  min-height: 72px;
}

.composer-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}

.spacer {
  flex: 1;
}

.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(17, 17, 17, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.modal {
  width: 100%;
  max-width: 420px;
  background: var(--yellow);
  border: 4px solid var(--ink);
  box-shadow: 10px 10px 0 0 var(--ink);
  padding: 16px;
}

.modal h3 {
  margin: 0 0 10px;
  text-transform: uppercase;
}

.modal p {
  margin: 0 0 16px;
  font-weight: 700;
  word-break: break-word;
}

.modal-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
```

---

## 10. `README.md`

```md
# Local LLM Browser Agent

Chrome Manifest V3 extension that adds a neobrutalist pastel chat side panel. It connects to a local OpenAI-compatible LLM server, sends page HTML when enabled, validates tool calls, returns validation errors to the model, asks permission before sending images, and can interact with the bound tab.

## Load the extension

1. Create a folder and add all files.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Click Load unpacked.
5. Select the folder.

## Use

1. Open the tab you want the agent to control.
2. Click the extension icon.
3. The side panel opens and binds to that tab.
4. If you switch tabs, the agent remains bound to the original tab.
5. Use Rebind if you want to attach to the currently active tab.

## Local LLM settings

Default:

- Base URL: `http://localhost:8000`
- Models path: `/models`
- Chat path: `/chat/completions`

If your server uses `/v1/models` and `/v1/chat/completions`, change those in Settings.

## Permissions and safety

- The extension uses broad host permissions because it must inject into arbitrary pages and make network requests on behalf of the agent.
- Image tools require explicit user permission before image pixels are sent to the LLM.
- Network requests to non-localhost origins prompt for permission unless allowlisted.
- Chrome system pages, extension pages, and the Chrome Web Store are blocked.
- File URLs are blocked by default.

## Tools

- `get_page_info`
- `get_html`
- `get_text`
- `get_interactive_snapshot`
- `click`
- `type_text`
- `set_value`
- `press_key`
- `scroll_to`
- `wait`
- `http_request`
- `screenshot`
- `get_images`

## Notes

- Screenshots use the Chrome Debugger API. Chrome may show a debugging banner.
- If the bound tab is not visible, screenshots still attempt to capture that bound tab via debugger.
- Some sites use trusted-event-only handlers. The extension uses synthetic DOM events and `element.click()`, which works for many but not all sites.
- Full-page HTML can be very large. The Attach page HTML toggle truncates HTML to the configured max character limit.
```

---

## Important production notes

1. **Local LLM compatibility**  
   The extension sends OpenAI-compatible chat completion requests with `tools` and `tool_choice: "auto"`. Your local server must support function/tool calling. If it does not, the model will need a JSON fallback prompt, but this extension already includes a limited fallback parser for JSON tool calls in content.

2. **Chrome Debugger permission**  
   Screenshots use `chrome.debugger` so the extension can capture the bound tab even if it is not currently focused. Chrome may show a debugging notification. This is expected.

3. **Tab binding behavior**  
   The agent binds to the tab that was active when you opened the panel. It intentionally does **not** follow you when you switch tabs.

4. **HTML size**  
   “Full HTML” can easily exceed local LLM context windows. The extension truncates HTML to `Max HTML chars` in Settings. Increase it if your local model can handle it.

5. **Security**  
   This extension gives an LLM the ability to read pages, click elements, type text, and make network requests. Only use it with trusted models and trusted pages. The network and image permission prompts are deliberate safeguards.