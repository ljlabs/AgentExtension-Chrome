/**
 * Screenshot tool tests — imports the real functions from background.js
 * by evaluating it inside a vm sandbox with mocked chrome.* globals.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { buildChromeMock, sidepanelHelpers } from "./test-helpers.mjs";

const { extractImages, buildImageMessage, buildToolMessage } = sidepanelHelpers;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const MIME_MAP = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp"
};

/**
 * Evaluate background.js inside a vm sandbox with the given chrome mock.
 * Returns the sandbox (with real screenshotTool, etc.) and the chrome object
 * so callers can mutate it mid-test.
 */
function loadBackground(overrides = {}) {
  const chrome = buildChromeMock(overrides);

  const sandbox = vm.createContext({
    chrome,
    importScripts: () => {},
    console,
    fetch,
    setTimeout,
    clearTimeout,
    URL,
    AbortController,
    Blob: globalThis.Blob,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
    JSON,
    Math,
    Date,
    Number,
    String,
    Array,
    Object,
    Error,
    TypeError,
    Promise,
    RegExp,
    parseInt: globalThis.parseInt,
    isNaN: globalThis.isNaN,
    isFinite: globalThis.isFinite
  });

  const code = readFileSync(resolve(ROOT, "background.js"), "utf-8");
  vm.runInContext(code, sandbox);

  return { sandbox, chrome };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("screenshotTool — debugger capture returning raw base64", () => {
  it("JPEG: raw base64 produces complete data URL with data: prefix", async () => {
    const { sandbox } = loadBackground({ captureData: "AAAA" });
    const result = await sandbox.screenshotTool(1, { format: "jpeg" });

    assert.equal(result.ok, true);
    assert.equal(result.data.format, "jpeg");
    assert.equal(result.data.mime, "image/jpeg");
    assert.ok(result.data.note);
    assert.ok(Array.isArray(result.data._images));
    assert.equal(result.data._images.length, 1);
    assert.equal(result.data._images[0], "data:image/jpeg;base64,AAAA");
  });

  it("PNG: raw base64 produces correct MIME", async () => {
    const { sandbox } = loadBackground({ captureData: "iVBORw0KGgo" });
    const result = await sandbox.screenshotTool(1, { format: "png" });

    assert.equal(result.ok, true);
    assert.equal(result.data.format, "png");
    assert.equal(result.data.mime, "image/png");
    assert.equal(result.data._images[0], "data:image/png;base64,iVBORw0KGgo");
  });

  it("WebP: raw base64 produces correct MIME", async () => {
    const { sandbox } = loadBackground({ captureData: "UklGRiQAAABX" });
    const result = await sandbox.screenshotTool(1, { format: "webp" });

    assert.equal(result.ok, true);
    assert.equal(result.data.format, "webp");
    assert.equal(result.data.mime, "image/webp");
    assert.equal(result.data._images[0], "data:image/webp;base64,UklGRiQAAABX");
  });
});

describe("screenshotTool — PNG, JPEG, WebP MIME types", () => {
  for (const format of ["png", "jpeg", "webp"]) {
    it(`${format} → correct MIME type in result`, async () => {
      const { sandbox } = loadBackground({ captureData: "dGVzdA==" });
      const result = await sandbox.screenshotTool(1, { format });

      assert.equal(result.ok, true);
      assert.equal(result.data.mime, MIME_MAP[format]);
      assert.equal(result.data.format, format);
    });
  }

  it("unknown format defaults to jpeg", async () => {
    const { sandbox } = loadBackground({ captureData: "dGVzdA==" });
    const result = await sandbox.screenshotTool(1, { format: "gif" });

    assert.equal(result.ok, true);
    assert.equal(result.data.format, "jpeg");
    assert.equal(result.data.mime, "image/jpeg");
  });
});

describe("screenshotTool — visible-tab fallback", () => {
  it("falls back to captureVisibleTab when debugger fails", async () => {
    const { sandbox } = loadBackground({
      debuggerFail: true,
      visibleTabDataUrl: "image/jpeg;base64,VISIBLE"
    });

    const result = await sandbox.screenshotTool(1, { format: "jpeg" });

    assert.equal(result.ok, true);
    assert.equal(result.data.format, "jpeg");
    assert.equal(result.data.mime, "image/jpeg");
    assert.ok(result.data.note.includes("fallback"));
    assert.equal(result.data._images[0], "image/jpeg;base64,VISIBLE");
  });

  it("falls back to PNG when format is png and debugger fails", async () => {
    const { sandbox } = loadBackground({
      debuggerFail: true,
      visibleTabDataUrl: "image/png;base64,VISIBLE"
    });

    const result = await sandbox.screenshotTool(1, { format: "png" });

    assert.equal(result.ok, true);
    assert.equal(result.data.format, "png");
    assert.equal(result.data.mime, "image/png");
    assert.ok(result.data.note.includes("fallback"));
  });

  it("returns error when both debugger and fallback fail", async () => {
    const { sandbox, chrome } = loadBackground({ debuggerFail: true });
    chrome.tabs.get = async () => ({ active: false });

    const result = await sandbox.screenshotTool(1, { format: "jpeg" });

    assert.equal(result.ok, false);
    assert.ok(result.error.includes("Screenshot failed"));
  });

  it("returns error when tabId is null", async () => {
    const { sandbox } = loadBackground();
    const result = await sandbox.screenshotTool(null, { format: "jpeg" });

    assert.equal(result.ok, false);
    assert.equal(result.error, "No bound tab.");
  });

  it("returns error when tabId is undefined", async () => {
    const { sandbox } = loadBackground();
    const result = await sandbox.screenshotTool(undefined, { format: "jpeg" });

    assert.equal(result.ok, false);
    assert.equal(result.error, "No bound tab.");
  });
});

describe("extractImages — screenshot result pipeline", () => {
  it("extracts _images from result.data", () => {
    const result = {
      ok: true,
      data: {
        format: "jpeg",
        mime: "image/jpeg",
        note: "Screenshot captured from bound tab.",
        _images: ["image/jpeg;base64,/9j/4AAQ"]
      }
    };

    const images = extractImages(result);

    assert.deepEqual(images, ["image/jpeg;base64,/9j/4AAQ"]);
    assert.equal(result.data._images, undefined, "_images should be deleted from result.data");
  });

  it("handles multiple images (get_images tool output)", () => {
    const result = {
      ok: true,
      data: {
        images: [],
        _images: [
          "image/png;base64,abc",
          "image/jpeg;base64,def"
        ]
      }
    };

    const images = extractImages(result);

    assert.equal(images.length, 2);
    assert.equal(images[0], "image/png;base64,abc");
    assert.equal(images[1], "image/jpeg;base64,def");
  });

  it("returns empty when no _images present", () => {
    const result = { ok: true, data: { format: "jpeg", text: "hello" } };
    const images = extractImages(result);
    assert.deepEqual(images, []);
  });

  it("returns empty for null result", () => {
    assert.deepEqual(extractImages(null), []);
  });

  it("returns empty for undefined result", () => {
    assert.deepEqual(extractImages(undefined), []);
  });
});

describe("OpenAI message content — image message building", () => {
  it("creates correct image_url content part from data URL", () => {
    const imageUrl = "image/jpeg;base64,/9j/4AAQSkZJRg==";
    const imageMessage = buildImageMessage([imageUrl], "call_screenshot_1");

    assert.equal(imageMessage.role, "user");
    assert.ok(Array.isArray(imageMessage.content));
    assert.equal(imageMessage.content.length, 2);

    assert.equal(imageMessage.content[0].type, "text");
    assert.ok(imageMessage.content[0].text.includes("call_screenshot_1"));

    assert.equal(imageMessage.content[1].type, "image_url");
    assert.deepEqual(imageMessage.content[1].image_url, { url: imageUrl });
  });

  it("creates multiple image_url parts for multiple images", () => {
    const urls = [
      "image/png;base64,abc123",
      "image/jpeg;base64,def456",
      "image/webp;base64,ghi789"
    ];
    const imageMessage = buildImageMessage(urls, "call_multi_1");

    assert.equal(imageMessage.content.length, 4);

    for (let i = 0; i < 3; i++) {
      assert.equal(imageMessage.content[i + 1].type, "image_url");
      assert.equal(imageMessage.content[i + 1].image_url.url, urls[i]);
    }
  });

  it("returns null when no images", () => {
    assert.equal(buildImageMessage([], "call_1"), null);
  });
});

describe("OpenAI message content — tool message with stringified result", () => {
  it("tool message contains result as JSON string (no image data)", () => {
    const result = {
      ok: true,
      data: {
        format: "jpeg",
        mime: "image/jpeg",
        note: "Screenshot captured from bound tab."
      }
    };

    const toolMessage = buildToolMessage("call_test_1", result);

    assert.equal(toolMessage.role, "tool");
    assert.equal(toolMessage.tool_call_id, "call_test_1");
    assert.equal(typeof toolMessage.content, "string");

    const parsed = JSON.parse(toolMessage.content);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.format, "jpeg");
    assert.equal(parsed.data.mime, "image/jpeg");
  });
});

describe("screenshotTool — malformed/empty capture output", () => {
  it("handles empty base64 string from debugger", async () => {
    const { sandbox } = loadBackground({ captureData: "" });
    const result = await sandbox.screenshotTool(1, { format: "jpeg" });

    assert.equal(result.ok, true);
    assert.equal(result.data._images[0], "data:image/jpeg;base64,");
  });

  it("handles undefined data from debugger (empty result object)", async () => {
    const { sandbox, chrome } = loadBackground();
    chrome.debugger.sendCommand = (target, method, params, cb) => {
      if (method === "Page.captureScreenshot") {
        if (cb) cb({});
        return {};
      }
      if (cb) cb({});
      return {};
    };

    const result = await sandbox.screenshotTool(1, { format: "jpeg" });

    assert.equal(result.ok, true);
    assert.equal(result.data._images[0], "data:image/jpeg;base64,undefined");
  });

  it("handles null data from debugger (falls back to mock default via ??)", async () => {
    const { sandbox } = loadBackground({ captureData: null });
    const result = await sandbox.screenshotTool(1, { format: "jpeg" });

    assert.equal(result.ok, true);
    assert.equal(result.data._images[0], "data:image/jpeg;base64,AAAA");
  });

  it("preserves all metadata fields on success", async () => {
    const { sandbox } = loadBackground({ captureData: "AAAA" });
    const result = await sandbox.screenshotTool(1, { format: "png" });

    assert.equal(result.ok, true);
    assert.equal(result.data.format, "png");
    assert.equal(result.data.mime, "image/png");
    assert.equal(typeof result.data.note, "string");
    assert.ok(result.data.note.length > 0);
    assert.ok(Array.isArray(result.data._images));
    assert.equal(result.data._images.length, 1);
  });

  it("returns structured error on failure with message included", async () => {
    const { sandbox, chrome } = loadBackground({ debuggerFail: true });
    chrome.tabs.get = async () => ({ active: false });

    const result = await sandbox.screenshotTool(1, { format: "jpeg" });

    assert.equal(result.ok, false);
    assert.equal(typeof result.error, "string");
    assert.ok(result.error.includes("Screenshot failed"));
  });
});

describe("end-to-end — screenshot → extract → message", () => {
  it("full debugger pipeline produces valid OpenAI image content", async () => {
    const { sandbox } = loadBackground({ captureData: "AAAA" });
    const screenshotResult = await sandbox.screenshotTool(1, { format: "jpeg" });

    const imagePayloads = extractImages(screenshotResult);
    const toolMessage = buildToolMessage("call_ss_1", screenshotResult);
    const imageMessage = buildImageMessage(imagePayloads, "call_ss_1");

    assert.equal(toolMessage.role, "tool");
    assert.equal(toolMessage.tool_call_id, "call_ss_1");
    const parsed = JSON.parse(toolMessage.content);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data._images, undefined);

    assert.ok(imageMessage, "Should have image message");
    assert.equal(imageMessage.role, "user");
    assert.equal(imageMessage.content.length, 2);

    const imgPart = imageMessage.content[1];
    assert.equal(imgPart.type, "image_url");
    assert.ok(
      imgPart.image_url.url.startsWith("data:image/"),
      "URL must start with data:image/"
    );
    assert.ok(
      imgPart.image_url.url.includes(";base64,"),
      "URL must contain ;base64,"
    );
    assert.ok(imgPart.image_url.url.endsWith("AAAA"), "URL must contain the base64 payload");
  });

  it("visible-tab fallback produces same end-to-end result shape", async () => {
    const { sandbox } = loadBackground({
      debuggerFail: true,
      visibleTabDataUrl: "image/jpeg;base64,FALLBACK"
    });

    const screenshotResult = await sandbox.screenshotTool(1, { format: "jpeg" });
    const imagePayloads = extractImages(screenshotResult);
    const imageMessage = buildImageMessage(imagePayloads, "call_fb_1");

    assert.equal(screenshotResult.ok, true);
    assert.equal(imagePayloads.length, 1);
    assert.equal(imagePayloads[0], "image/jpeg;base64,FALLBACK");
    assert.ok(imageMessage);
    assert.equal(imageMessage.content[1].image_url.url, "image/jpeg;base64,FALLBACK");
  });

  it("all three MIME types produce valid URLs end-to-end", async () => {
    for (const format of ["png", "jpeg", "webp"]) {
      const { sandbox } = loadBackground({ captureData: "AAAA" });
      const result = await sandbox.screenshotTool(1, { format });
      const images = extractImages(result);
      const msg = buildImageMessage(images, `call_${format}_1`);

      assert.ok(msg, `${format}: should have image message`);
      const url = msg.content[1].image_url.url;
      assert.ok(url.startsWith("data:image/"), `${format}: URL must start with data:image/`);
      assert.ok(url.includes(";base64,"), `${format}: URL must contain ;base64,`);
      assert.ok(
        url.startsWith(`data:${MIME_MAP[format]};base64,`),
        `${format}: URL must have correct MIME in prefix`
      );
    }
  });
});
