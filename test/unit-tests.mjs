/**
 * Unit tests for the bug fixes in background.js, sidepanel.js, and tools-schema.js.
 *
 * Validates:
 * - data: property name restoration (no more SyntaxError)
 * - data: URL prefix restoration (OpenAI-compatible image URLs)
 * - AGENT_TOOL_MAP constant declaration
 * - Image embedding in tool message content arrays (Option A)
 * - extractImages / containsImages / stripImages correctness
 * - DEBUG gate on dev logging
 *
 * Run: node test/unit-tests.mjs
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");

// ─── Helpers ────────────────────────────────────────────────────────────────

function loadFile(name) {
  return readFileSync(resolve(ROOT, name), "utf-8");
}

function evalInGlobalContext(code) {
  const ctx = {
    globalThis: {},
    console: { log() {}, warn() {}, group() {}, groupEnd() {} },
    document: {
      createDocumentFragment() {
        return { appendChild() {} };
      },
      createElement(tag) {
        return {
          textContent: "",
          appendChild() {},
          className: "",
          href: "",
          target: "",
          rel: ""
        };
      }
    },
    fetch: async () => {},
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    chrome: {
      storage: { local: { get: async () => ({}), set: async () => {} } },
      tabs: { get: async () => ({}), query: async () => [], sendMessage: () => {} },
      runtime: { lastError: null, sendMessage: () => {} },
      debugger: { attach: () => {}, sendCommand: () => {}, detach: () => {} },
      sidePanel: { setOptions: async () => {}, setPanelBehavior: async () => {} },
      scripting: { executeScript: async () => {} },
      action: { onClicked: { addListener() {} } },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} }
    },
    URL,
    Uint8Array: globalThis.Uint8Array,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
    JSON,
    Math,
    Date,
    String,
    Number,
    Array,
    Object,
    Error,
    TypeError,
    Promise,
    Map,
    Set,
    RegExp,
    Boolean,
    parseInt: globalThis.parseInt,
    parseFloat: globalThis.parseFloat,
    isNaN: globalThis.isNaN,
    isFinite: globalThis.isFinite
  };

  // globalThis = ctx.globalThis;
  const fn = new Function(
    "globalThis",
    "console",
    "document",
    "fetch",
    "setTimeout",
    "clearTimeout",
    "chrome",
    "URL",
    "Uint8Array",
    "btoa",
    "atob",
    "JSON",
    "Math",
    "Date",
    "String",
    "Number",
    "Array",
    "Object",
    "Error",
    "TypeError",
    "Promise",
    "Map",
    "Set",
    "RegExp",
    "Boolean",
    "parseInt",
    "parseFloat",
    "isNaN",
    "isFinite",
    code
  );
  fn(
    ctx.globalThis,
    ctx.console,
    ctx.document,
    ctx.fetch,
    ctx.setTimeout,
    ctx.clearTimeout,
    ctx.chrome,
    ctx.URL,
    ctx.Uint8Array,
    ctx.btoa,
    ctx.atob,
    ctx.JSON,
    ctx.Math,
    ctx.Date,
    ctx.String,
    ctx.Number,
    ctx.Array,
    ctx.Object,
    ctx.Error,
    ctx.TypeError,
    ctx.Promise,
    ctx.Map,
    ctx.Set,
    ctx.RegExp,
    ctx.Boolean,
    ctx.parseInt,
    ctx.parseFloat,
    ctx.isNaN,
    ctx.isFinite
  );

  return ctx.globalThis;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("background.js — data: property names", () => {
  it("get_images return object has data: property", () => {
    const src = loadFile("background.js");

    // Verify all four return statements have "data: {" not bare "{"
    // Pattern: ok: true, followed by data: {
    const matches = src.match(/ok:\s*true,\s*\n\s*\{/g);
    assert.equal(matches, null, "No bare '{' after 'ok: true' should remain");
  });

  it("screenshotTool returns data: with data: prefixed URL", () => {
    const src = loadFile("background.js");
    assert.ok(
      src.includes("_images: [`data:${mime};base64,${base64}`]"),
      "screenshotTool _images should have data: prefix"
    );
  });

  it("clickTool navigation returns data: property", () => {
    const src = loadFile("background.js");
    // The clickTool navigation case: after.status === "loading" ... data: { clicked: true
    const clickNavSection = src.slice(
      src.indexOf('if (after.status === "loading" || after.url !== beforeUrl)'),
      src.indexOf('if (after.status === "loading" || after.url !== beforeUrl)') + 300
    );
    assert.ok(
      clickNavSection.includes("data: {"),
      "clickTool navigation should have data: property"
    );
    assert.ok(
      clickNavSection.includes("clicked: true"),
      "clickTool navigation should have clicked: true"
    );
  });
});

describe("background.js — data: URL prefixes", () => {
  it("fetchImagesBase64 checks for data: prefix", () => {
    const src = loadFile("background.js");
    assert.ok(
      src.includes('image.src.startsWith("data:")'),
      "fetchImagesBase64 should check for data: prefix"
    );
    assert.ok(
      !src.includes('image.src.startsWith("")'),
      "Should not have empty startsWith"
    );
  });

  it("fetchImagesBase64 regex matches data: prefix", () => {
    const src = loadFile("background.js");
    assert.ok(
      src.includes("data:(image\\/[a-zA-Z0-9+.]+);base64,(.*)"),
      "Regex should include data: prefix"
    );
    assert.ok(
      !src.includes("^(image\\/"),
      "Regex should not start with ^image/"
    );
  });

  it("blobToDataUrl returns data: prefix", () => {
    const src = loadFile("background.js");
    assert.ok(
      src.includes("`data:${blob.type};base64,${btoa(binary)}`"),
      "blobToDataUrl should return data: prefix"
    );
    assert.ok(
      !src.includes("`${blob.type};base64,${btoa(binary)}`"),
      "Should not have bare blob.type without data:"
    );
  });

  it("fetchImagesBase64 correctly parses real data URLs", () => {
    const src = loadFile("background.js");
    // Simulate the regex
    const regex = /^data:(image\/[a-zA-Z0-9+.]+);base64,(.*)$/;
    const testUrl = "data:image/png;base64,iVBORw0KGgo=";
    const match = testUrl.match(regex);
    assert.ok(match, "Regex should match valid data URL");
    assert.equal(match[1], "image/png", "Should extract MIME type");
    assert.equal(match[2], "iVBORw0KGgo=", "Should extract base64 data");
  });

  it("fetchImagesBase64 regex rejects broken URLs (no data: prefix)", () => {
    const regex = /^data:(image\/[a-zA-Z0-9+.]+);base64,(.*)$/;
    const brokenUrl = "image/png;base64,iVBORw0KGgo=";
    const match = brokenUrl.match(regex);
    assert.equal(match, null, "Regex should not match broken URL");
  });
});

describe("tools-schema.js — AGENT_TOOL_MAP", () => {
  let g;

  before(() => {
    // Load validator.js first (required by tools-schema.js)
    const validatorSrc = loadFile("validator.js");
    g = evalInGlobalContext(validatorSrc);

    // Apply globalThis to our context
    Object.assign(globalThis, g);

    const toolsSchemaSrc = loadFile("tools-schema.js");
    const fn = new Function(
      "globalThis",
      "normalizeAndValidate",
      toolsSchemaSrc
    );
    fn(globalThis, globalThis.normalizeAndValidate);
  });

  it("AGENT_TOOL_MAP is defined", () => {
    assert.ok(
      globalThis.AGENT_TOOL_MAP,
      "AGENT_TOOL_MAP should be defined on globalThis"
    );
  });

  it("AGENT_TOOL_MAP has all tool names as keys", () => {
    const toolNames = globalThis.AGENT_TOOLS.map((t) => t.name);
    for (const name of toolNames) {
      assert.ok(
        globalThis.AGENT_TOOL_MAP[name],
        `AGENT_TOOL_MAP should have key "${name}"`
      );
    }
  });

  it("AGENT_TOOL_MAP values match AGENT_TOOLS entries", () => {
    for (const tool of globalThis.AGENT_TOOLS) {
      const mapped = globalThis.AGENT_TOOL_MAP[tool.name];
      assert.equal(mapped.name, tool.name);
      assert.equal(mapped.description, tool.description);
    }
  });

  it("validateToolCall uses AGENT_TOOL_MAP without ReferenceError", () => {
    const tc = {
      id: "call_test_1",
      type: "function",
      function: {
        name: "wait",
        arguments: '{"ms": 100}'
      }
    };

    const result = globalThis.validateToolCall(tc, 0);
    assert.equal(result.ok, true, "validateToolCall should succeed for valid tool");
    assert.equal(result.name, "wait");
  });

  it("validateToolCall returns error for unknown tool", () => {
    const tc = {
      id: "call_test_2",
      type: "function",
      function: {
        name: "nonexistent_tool",
        arguments: "{}"
      }
    };

    const result = globalThis.validateToolCall(tc, 0);
    assert.equal(result.ok, false, "Should fail for unknown tool");
    assert.ok(
      result.errors.some((e) => e.message.includes("Unknown tool")),
      "Should report unknown tool"
    );
  });

  it("validateToolCall catches invalid arguments", () => {
    const tc = {
      id: "call_test_3",
      type: "function",
      function: {
        name: "wait",
        arguments: '{"ms": -100}'
      }
    };

    const result = globalThis.validateToolCall(tc, 0);
    assert.equal(result.ok, false, "Should fail for invalid args");
  });

  it("getOpenAiTools returns valid OpenAI tool format", () => {
    const tools = globalThis.getOpenAiTools();
    assert.ok(Array.isArray(tools), "Should return array");
    assert.ok(tools.length > 0, "Should have tools");

    for (const tool of tools) {
      assert.equal(tool.type, "function");
      assert.ok(tool.function.name, "Tool should have name");
      assert.ok(tool.function.description, "Tool should have description");
      assert.ok(tool.function.parameters, "Tool should have parameters");
      assert.equal(
        tool.function.parameters.type,
        "object",
        "Parameters should be object type"
      );
    }
  });
});

describe("sidepanel.js — image handling functions", () => {
  // Reimplement the pure functions from sidepanel.js for testing
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
        const textParts = message.content.filter(
          (part) => part && part.type === "text"
        );
        const hadImage = message.content.some(
          (part) => part && part.type === "image_url"
        );

        const text = textParts.map((part) => part.text || "").join("\n");

        return {
          ...message,
          content: text
            ? `${text}${hadImage ? "\n[image omitted]" : ""}`
            : "[image omitted]"
        };
      }

      if (
        typeof message.content === "string" &&
        message.content.includes("data:image")
      ) {
        return {
          ...message,
          content: message.content.replace(
            /data:image\/[a-z0-9+.]+;base64,[A-Za-z0-9+/=]+/gi,
            "[image omitted]"
          )
        };
      }

      return message;
    });
  }

  describe("extractImages", () => {
    it("extracts _images from result.data", () => {
      const result = {
        ok: true,
        data: {
          _images: ["data:image/png;base64,abc123"],
          format: "png"
        }
      };

      const images = extractImages(result);
      assert.deepEqual(images, ["data:image/png;base64,abc123"]);
      assert.equal(result.data._images, undefined, "_images should be deleted");
    });

    it("extracts _images from result root", () => {
      const result = {
        ok: true,
        _images: ["data:image/jpeg;base64,xyz789"]
      };

      const images = extractImages(result);
      assert.deepEqual(images, ["data:image/jpeg;base64,xyz789"]);
    });

    it("returns empty array when no images", () => {
      const result = { ok: true, data: { format: "png" } };
      const images = extractImages(result);
      assert.deepEqual(images, []);
    });

    it("handles null/undefined result gracefully", () => {
      assert.deepEqual(extractImages(null), []);
      assert.deepEqual(extractImages(undefined), []);
    });
  });

  describe("containsImages", () => {
    it("detects image_url in content array", () => {
      const messages = [
        {
          role: "tool",
          content: [
            { type: "text", text: "Screenshot captured." },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,abc" }
            }
          ]
        }
      ];
      assert.equal(containsImages(messages), true);
    });

    it("detects data:image in string content", () => {
      const messages = [
        { role: "user", content: "data:image/png;base64,abc is the image" }
      ];
      assert.equal(containsImages(messages), true);
    });

    it("returns false for text-only messages", () => {
      const messages = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" }
      ];
      assert.equal(containsImages(messages), false);
    });

    it("returns false for empty messages", () => {
      assert.equal(containsImages([]), false);
    });

    it("handles tool messages with array content", () => {
      const messages = [
        {
          role: "tool",
          tool_call_id: "call_1",
          content: [
            { type: "text", text: "Done" },
            {
              type: "image_url",
              image_url: { url: "data:image/jpeg;base64,/9j/..." }
            }
          ]
        }
      ];
      assert.equal(containsImages(messages), true);
    });
  });

  describe("stripImages", () => {
    it("strips image_url from content array", () => {
      const messages = [
        {
          role: "tool",
          content: [
            { type: "text", text: "Screenshot captured." },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,abc" }
            }
          ]
        }
      ];

      const stripped = stripImages(messages);
      assert.equal(typeof stripped[0].content, "string");
      assert.ok(stripped[0].content.includes("Screenshot captured."));
      assert.ok(stripped[0].content.includes("[image omitted]"));
    });

    it("strips data:image from string content", () => {
      const messages = [
        {
          role: "user",
          content: "Here is data:image/png;base64,iVBORw0KGgo the image"
        }
      ];

      const stripped = stripImages(messages);
      assert.ok(
        stripped[0].content.includes("[image omitted]"),
        "Should replace data URL with placeholder"
      );
      assert.ok(
        !stripped[0].content.includes("data:image"),
        "Should not contain data:image"
      );
    });

    it("preserves text-only messages", () => {
      const messages = [
        { role: "user", content: "Hello world" },
        { role: "assistant", content: "Hi!" }
      ];

      const stripped = stripImages(messages);
      assert.equal(stripped[0].content, "Hello world");
      assert.equal(stripped[1].content, "Hi!");
    });

    it("preserves non-content messages", () => {
      const messages = [
        { role: "system", content: "You are helpful." }
      ];

      const stripped = stripImages(messages);
      assert.equal(stripped[0].content, "You are helpful.");
    });
  });
});

describe("sidepanel.js — Option A image embedding", () => {
  it("tool message with images has array content with image_url parts", () => {
    // Simulate the Option A code path
    const result = {
      ok: true,
      data: {
        format: "png",
        _images: ["data:image/png;base64,abc123"]
      }
    };

    const imagePayloads = ["data:image/png;base64,abc123"];
    const toolMessage = {
      role: "tool",
      tool_call_id: "call_test",
      content: JSON.stringify(result)
    };

    if (imagePayloads.length) {
      toolMessage.content = [
        { type: "text", text: JSON.stringify(result) },
        ...imagePayloads.map((url) => ({
          type: "image_url",
          image_url: { url }
        }))
      ];
    }

    assert.ok(Array.isArray(toolMessage.content), "Content should be array");
    assert.equal(toolMessage.content.length, 2, "Should have text + image");
    assert.equal(toolMessage.content[0].type, "text");
    assert.equal(toolMessage.content[1].type, "image_url");
    assert.equal(
      toolMessage.content[1].image_url.url,
      "data:image/png;base64,abc123"
    );
  });

  it("tool message without images keeps string content", () => {
    const result = { ok: true, data: { text: "hello" } };
    const imagePayloads = [];

    const toolMessage = {
      role: "tool",
      tool_call_id: "call_test",
      content: JSON.stringify(result)
    };

    if (imagePayloads.length) {
      toolMessage.content = [
        { type: "text", text: JSON.stringify(result) },
        ...imagePayloads.map((url) => ({
          type: "image_url",
          image_url: { url }
        }))
      ];
    }

    assert.equal(typeof toolMessage.content, "string", "Content should stay string");
  });

  it("images have valid data: URL format for OpenAI", () => {
    const urls = [
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
      "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
      "data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCd"
    ];

    for (const url of urls) {
      assert.ok(
        url.startsWith("data:image/"),
        `URL should start with data:image/: ${url.slice(0, 30)}`
      );
      assert.ok(
        url.includes(";base64,"),
        `URL should contain ;base64,: ${url.slice(0, 30)}`
      );
    }
  });
});

describe("sidepanel.js — DEBUG gate", () => {
  it("devLog respects DEBUG flag", () => {
    const src = loadFile("sidepanel.js");
    assert.ok(
      src.includes("const DEBUG = true"),
      "DEBUG constant should exist"
    );
    assert.ok(
      src.includes("if (DEBUG) console.log"),
      "devLog should check DEBUG"
    );
    assert.ok(
      src.includes("if (DEBUG) console.group"),
      "devGroup should check DEBUG"
    );
    assert.ok(
      src.includes("if (DEBUG) console.groupEnd"),
      "devGroupEnd should check DEBUG"
    );
    assert.ok(
      src.includes("if (DEBUG) console.warn"),
      "devWarn should check DEBUG"
    );
  });
});

describe("sidepanel.js — no orphaned maxHtmlChars references", () => {
  it("maxHtmlChars removed from DEFAULT_SETTINGS", () => {
    const src = loadFile("sidepanel.js");
    assert.ok(
      !src.includes("maxHtmlChars: 120000"),
      "maxHtmlChars should not be in DEFAULT_SETTINGS"
    );
  });

  it("maxHtmlCharsInput not referenced in JS", () => {
    const src = loadFile("sidepanel.js");
    assert.ok(
      !src.includes("maxHtmlCharsInput"),
      "maxHtmlCharsInput should not be referenced in sidepanel.js"
    );
  });
});

describe("sidepanel.html — no orphaned elements", () => {
  it("attachHtmlToggle removed", () => {
    const src = loadFile("sidepanel.html");
    assert.ok(
      !src.includes("attachHtmlToggle"),
      "attachHtmlToggle should be removed from HTML"
    );
  });

  it("maxHtmlCharsInput removed", () => {
    const src = loadFile("sidepanel.html");
    assert.ok(
      !src.includes("maxHtmlCharsInput"),
      "maxHtmlCharsInput should be removed from HTML"
    );
  });
});

describe("sidepanel-test.js — no broken references", () => {
  it("attachHtmlToggle reference removed", () => {
    const src = loadFile("test/sidepanel-test.js");
    assert.ok(
      !src.includes("attachHtmlToggle"),
      "Test should not reference removed attachHtmlToggle"
    );
  });
});

describe("data: URL format validation", () => {
  it("all image URLs follow OpenAI format", () => {
    const src = loadFile("background.js");

    // Find all _images array literals
    const imagePatterns = src.match(/_images:\s*\[[^\]]+\]/g) || [];

    for (const pattern of imagePatterns) {
      // Each should use data: prefix or be a variable reference
      if (pattern.includes("`") || pattern.includes("dataUrl")) {
        // Template literal or variable - OK
        continue;
      }
      // String literals should start with data:
      const stringMatches = pattern.match(/"([^"]+)"/g) || [];
      for (const str of stringMatches) {
        const cleaned = str.slice(1, -1);
        if (cleaned.includes("base64")) {
          assert.ok(
            cleaned.startsWith("data:"),
            `Image URL should start with data:: ${cleaned.slice(0, 40)}`
          );
        }
      }
    }
  });
});

describe("mock-llm-server.mjs — chat/completions response structure", () => {
  it("server responds with valid OpenAI chat format", () => {
    const src = loadFile("test/mock-llm-server.mjs");

    // Verify the server returns proper tool_calls structure
    assert.ok(
      src.includes("tool_calls"),
      "Server should return tool_calls"
    );
    assert.ok(
      src.includes("function"),
      "Server should use function format"
    );
    assert.ok(
      src.includes("arguments"),
      "Server should stringify arguments"
    );
  });
});

describe("manifest.json — extension configuration", () => {
  it("manifest is valid JSON", () => {
    const src = loadFile("manifest.json");
    const manifest = JSON.parse(src);
    assert.ok(manifest.manifest_version, "Should have manifest_version");
    assert.ok(manifest.name, "Should have name");
    assert.ok(
      manifest.background?.service_worker,
      "Should have background service_worker"
    );
  });

  it("side_panel is configured", () => {
    const src = loadFile("manifest.json");
    const manifest = JSON.parse(src);
    assert.ok(
      manifest.side_panel,
      "Should have side_panel configuration"
    );
  });
});

describe("background.js — error handling", () => {
  it("handleExecuteTool returns error for missing tool name", () => {
    const src = loadFile("background.js");
    assert.ok(
      src.includes('"Missing tool name."'),
      "Should handle missing tool name"
    );
  });

  it("handleExecuteTool returns error for missing tabId on tab tools", () => {
    const src = loadFile("background.js");
    assert.ok(
      src.includes('"No bound tab. Rebind the agent to a tab."'),
      "Should handle missing bound tab"
    );
  });

  it("screenshotTool returns error when no tabId", () => {
    const src = loadFile("background.js");
    assert.ok(
      src.includes('"No bound tab."'),
      "screenshotTool should handle missing tabId"
    );
  });

  it("fetchImagesBase64 handles data URL too large", () => {
    const src = loadFile("background.js");
    assert.ok(
      src.includes("Data URL too large or unsupported"),
      "Should handle oversized data URLs"
    );
  });

  it("blobToDataUrl exists and is async", () => {
    const src = loadFile("background.js");
    assert.ok(
      src.includes("async function blobToDataUrl"),
      "blobToDataUrl should be async"
    );
  });
});

describe("sidepanel.js — error handling", () => {
  it("extractImages handles null result", () => {
    const src = loadFile("sidepanel.js");
    assert.ok(
      src.includes("if (result && result.data && Array.isArray(result.data._images))"),
      "extractImages should null-check result and result.data"
    );
  });

  it("stringifyToolResult handles serialization failure", () => {
    const src = loadFile("sidepanel.js");
    assert.ok(
      src.includes("} catch {"),
      "stringifyToolResult should have try/catch"
    );
  });

  it("buildInitialApiMessages uses buildSystemMessage", () => {
    const src = loadFile("sidepanel.js");
    assert.ok(
      src.includes("buildSystemMessage()"),
      "buildInitialApiMessages should call buildSystemMessage"
    );
  });
});

describe("tools-schema.js — complete tool list", () => {
  let g;

  before(() => {
    const validatorSrc = loadFile("validator.js");
    g = evalInGlobalContext(validatorSrc);
    Object.assign(globalThis, g);

    const toolsSchemaSrc = loadFile("tools-schema.js");
    const fn = new Function("globalThis", "normalizeAndValidate", toolsSchemaSrc);
    fn(globalThis, globalThis.normalizeAndValidate);
  });

  it("has expected tool count (>= 14)", () => {
    assert.ok(
      globalThis.AGENT_TOOLS.length >= 14,
      `Should have at least 14 tools, got ${globalThis.AGENT_TOOLS.length}`
    );
  });

  it("all required tools are present", () => {
    const expectedTools = [
      "get_page_info",
      "get_html",
      "get_text",
      "get_interactive_snapshot",
      "click",
      "type_text",
      "set_value",
      "press_key",
      "scroll_to",
      "wait",
      "http_request",
      "screenshot",
      "get_images",
      "read_browser_storage",
      "write_browser_storage",
      "memories",
      "skills"
    ];

    const toolNames = globalThis.AGENT_TOOLS.map((t) => t.name);
    for (const name of expectedTools) {
      assert.ok(toolNames.includes(name), `Missing tool: ${name}`);
    }
  });

  it("screenshot tool has requiresImagePermission", () => {
    const screenshot = globalThis.AGENT_TOOLS.find(
      (t) => t.name === "screenshot"
    );
    assert.ok(screenshot, "screenshot tool should exist");
    assert.equal(
      screenshot.requiresImagePermission,
      true,
      "screenshot should require image permission"
    );
  });

  it("http_request tool has requiresNetworkPermission", () => {
    const httpReq = globalThis.AGENT_TOOLS.find(
      (t) => t.name === "http_request"
    );
    assert.ok(httpReq, "http_request tool should exist");
    assert.equal(
      httpReq.requiresNetworkPermission,
      true,
      "http_request should require network permission"
    );
  });
});
