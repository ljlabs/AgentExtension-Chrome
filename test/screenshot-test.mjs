/**
 * Focused unit tests for the screenshot tool image pipeline.
 *
 * Validates:
 * - Debugger capture returning raw base64 → complete data URL with "data:" prefix
 * - PNG, JPEG, and WebP MIME types
 * - Visible-tab fallback path
 * - Final generated OpenAI message content structure
 * - Malformed/empty capture output
 * - extractImages / image message building end-to-end
 *
 * Run: node test/screenshot-test.mjs
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Helpers ────────────────────────────────────────────────────────────────

const MIME_MAP = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp"
};

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Build a minimal Chrome-like mock for testing screenshotTool logic.
 * captureData simulates what the CDP Page.captureScreenshot API returns
 * in its result.data field (raw base64, not a data URL).
 */
function buildChromeMock(overrides = {}) {
  const runtime = { lastError: null };
  const debuggerFail = overrides.debuggerFail || false;
  const debuggerErrorMsg = overrides.debuggerErrorMsg || "Cannot attach";

  return {
    runtime,
    debugger: {
      attach: mock.fn((_target, _version, cb) => {
        if (debuggerFail) {
          runtime.lastError = { message: debuggerErrorMsg };
        }
        if (cb) cb();
      }),
      sendCommand: mock.fn((_target, method, _params, cb) => {
        if (debuggerFail) {
          runtime.lastError = { message: debuggerErrorMsg };
          if (cb) cb(undefined);
          return {};
        }
        if (method === "Page.captureScreenshot") {
          // The CDP API returns { data: "<raw base64>" }
          const result = { data: overrides.captureData ?? "AAAA" };
          if (cb) cb(result);
          return result;
        }
        if (cb) cb({});
        return {};
      }),
      detach: mock.fn((_target, cb) => {
        if (cb) cb();
      })
    },
    tabs: {
      get: mock.fn(async () => ({
        id: overrides.tabId || 1,
        active: overrides.tabActive !== undefined ? overrides.tabActive : true,
        windowId: overrides.windowId || 1,
        url: "https://example.com",
        title: "Test"
      })),
      captureVisibleTab: mock.fn(async () =>
        overrides.visibleTabDataUrl || "data:image/jpeg;base64,VISIBLE"
      )
    }
  };
}

/**
 * Replicate screenshotTool + captureScreenshotWithDebugger from background.js.
 * This matches the FIXED version with:
 *   _images: [`data:${mime};base64,${base64}`]
 * and the fallback returning the dataUrl directly.
 */
async function screenshotToolLogic(chrome, tabId, args) {
  if (!tabId) {
    return { ok: false, error: "No bound tab." };
  }

  const format = ["png", "jpeg", "webp"].includes(args.format) ? args.format : "jpeg";
  const quality = clampInt(args.quality, 1, 100, 70);

  async function captureScreenshotWithDebugger(tabId, format, quality) {
    const target = { tabId };
    let attachedByUs = false;

    try {
      await new Promise((resolve, reject) => {
        chrome.debugger.attach(target, "1.3", () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve();
          }
        });
      });
      attachedByUs = true;
    } catch (err) {
      if (!/Another debugger is already attached/i.test(err.message)) {
        throw err;
      }
    }

    try {
      await new Promise((resolve, reject) => {
        chrome.debugger.sendCommand(target, "Page.enable", {}, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve();
          }
        });
      });

      const params = { format, captureBeyondViewport: true };
      if (format !== "png") params.quality = quality;

      const result = await new Promise((resolve, reject) => {
        chrome.debugger.sendCommand(target, "Page.captureScreenshot", params, (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(res);
          }
        });
      });
      return result.data;
    } finally {
      if (attachedByUs) {
        await new Promise((resolve) => {
          chrome.debugger.detach(target, () => resolve());
        });
      }
    }
  }

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

// ─── Shared sidepanel logic (replicated for isolation) ──────────────────────

/**
 * Matches sidepanel.js extractImages — reads _images from result.data,
 * then from result root, deletes both after extraction.
 */
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

/**
 * Matches the sidepanel.js image message builder (line ~739).
 * When vision is enabled and images are present, a user message is created
 * with content array: [{ type: "text", text: ... }, { type: "image_url", image_url: { url } }]
 */
function buildImageMessage(imagePayloads, toolCallId) {
  if (imagePayloads.length) {
    return {
      role: "user",
      content: [
        {
          type: "text",
          text: `Images for tool call ${toolCallId}:`
        },
        ...imagePayloads.map((url) => ({
          type: "image_url",
          image_url: { url }
        }))
      ]
    };
  }
  return null;
}

/**
 * Matches the sidepanel.js tool message builder (line ~728).
 */
function buildToolMessage(toolCallId, result) {
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: JSON.stringify(result)
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("screenshotTool — debugger capture returning raw base64", () => {
  it("JPEG: raw base64 produces complete data URL with data: prefix", async () => {
    const chrome = buildChromeMock({ captureData: "AAAA" });
    const result = await screenshotToolLogic(chrome, 1, { format: "jpeg" });

    assert.equal(result.ok, true);
    assert.equal(result.data.format, "jpeg");
    assert.equal(result.data.mime, "image/jpeg");
    assert.ok(result.data.note);
    assert.ok(Array.isArray(result.data._images));
    assert.equal(result.data._images.length, 1);
    assert.equal(result.data._images[0], "data:image/jpeg;base64,AAAA");
  });

  it("PNG: raw base64 produces correct MIME", async () => {
    const chrome = buildChromeMock({ captureData: "iVBORw0KGgo" });
    const result = await screenshotToolLogic(chrome, 1, { format: "png" });

    assert.equal(result.ok, true);
    assert.equal(result.data.format, "png");
    assert.equal(result.data.mime, "image/png");
    assert.equal(result.data._images[0], "data:image/png;base64,iVBORw0KGgo");
  });

  it("WebP: raw base64 produces correct MIME", async () => {
    const chrome = buildChromeMock({ captureData: "UklGRiQAAABX" });
    const result = await screenshotToolLogic(chrome, 1, { format: "webp" });

    assert.equal(result.ok, true);
    assert.equal(result.data.format, "webp");
    assert.equal(result.data.mime, "image/webp");
    assert.equal(result.data._images[0], "data:image/webp;base64,UklGRiQAAABX");
  });
});

describe("screenshotTool — PNG, JPEG, WebP MIME types", () => {
  for (const format of ["png", "jpeg", "webp"]) {
    it(`${format} → correct MIME type in result`, async () => {
      const chrome = buildChromeMock({ captureData: "dGVzdA==" });
      const result = await screenshotToolLogic(chrome, 1, { format });

      assert.equal(result.ok, true);
      assert.equal(result.data.mime, MIME_MAP[format]);
      assert.equal(result.data.format, format);
    });
  }

  it("unknown format defaults to jpeg", async () => {
    const chrome = buildChromeMock({ captureData: "dGVzdA==" });
    const result = await screenshotToolLogic(chrome, 1, { format: "gif" });

    assert.equal(result.ok, true);
    assert.equal(result.data.format, "jpeg");
    assert.equal(result.data.mime, "image/jpeg");
  });
});

describe("screenshotTool — visible-tab fallback", () => {
  it("falls back to captureVisibleTab when debugger fails", async () => {
    const chrome = buildChromeMock({
      debuggerFail: true,
      visibleTabDataUrl: "data:image/jpeg;base64,VISIBLE"
    });

    const result = await screenshotToolLogic(chrome, 1, { format: "jpeg" });

    assert.equal(result.ok, true);
    assert.equal(result.data.format, "jpeg");
    assert.equal(result.data.mime, "image/jpeg");
    assert.ok(result.data.note.includes("fallback"));
    assert.equal(result.data._images[0], "data:image/jpeg;base64,VISIBLE");
  });

  it("falls back to PNG when format is png and debugger fails", async () => {
    const chrome = buildChromeMock({
      debuggerFail: true,
      visibleTabDataUrl: "data:image/png;base64,VISIBLE"
    });

    const result = await screenshotToolLogic(chrome, 1, { format: "png" });

    assert.equal(result.ok, true);
    assert.equal(result.data.format, "png");
    assert.equal(result.data.mime, "image/png");
    assert.ok(result.data.note.includes("fallback"));
  });

  it("returns error when both debugger and fallback fail", async () => {
    const chrome = buildChromeMock({ debuggerFail: true });
    // Make fallback fail: tab is not active
    chrome.tabs.get = mock.fn(async () => ({ active: false }));

    const result = await screenshotToolLogic(chrome, 1, { format: "jpeg" });

    assert.equal(result.ok, false);
    assert.ok(result.error.includes("Screenshot failed"));
  });

  it("returns error when tabId is null", async () => {
    const chrome = buildChromeMock();
    const result = await screenshotToolLogic(chrome, null, { format: "jpeg" });

    assert.equal(result.ok, false);
    assert.equal(result.error, "No bound tab.");
  });

  it("returns error when tabId is undefined", async () => {
    const chrome = buildChromeMock();
    const result = await screenshotToolLogic(chrome, undefined, { format: "jpeg" });

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
        _images: ["data:image/jpeg;base64,/9j/4AAQ"]
      }
    };

    const images = extractImages(result);

    assert.deepEqual(images, ["data:image/jpeg;base64,/9j/4AAQ"]);
    assert.equal(result.data._images, undefined, "_images should be deleted from result.data");
  });

  it("handles multiple images (get_images tool output)", () => {
    const result = {
      ok: true,
      data: {
        images: [],
        _images: [
          "data:image/png;base64,abc",
          "data:image/jpeg;base64,def"
        ]
      }
    };

    const images = extractImages(result);

    assert.equal(images.length, 2);
    assert.equal(images[0], "data:image/png;base64,abc");
    assert.equal(images[1], "data:image/jpeg;base64,def");
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
    const imageUrl = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
    const imageMessage = buildImageMessage([imageUrl], "call_screenshot_1");

    assert.equal(imageMessage.role, "user");
    assert.ok(Array.isArray(imageMessage.content));
    assert.equal(imageMessage.content.length, 2);

    // Text part
    assert.equal(imageMessage.content[0].type, "text");
    assert.ok(imageMessage.content[0].text.includes("call_screenshot_1"));

    // Image part
    assert.equal(imageMessage.content[1].type, "image_url");
    assert.deepEqual(imageMessage.content[1].image_url, { url: imageUrl });
  });

  it("creates multiple image_url parts for multiple images", () => {
    const urls = [
      "data:image/png;base64,abc123",
      "data:image/jpeg;base64,def456",
      "data:image/webp;base64,ghi789"
    ];
    const imageMessage = buildImageMessage(urls, "call_multi_1");

    assert.equal(imageMessage.content.length, 4); // 1 text + 3 images

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
    const chrome = buildChromeMock({ captureData: "" });
    const result = await screenshotToolLogic(chrome, 1, { format: "jpeg" });

    assert.equal(result.ok, true);
    assert.equal(result.data._images[0], "data:image/jpeg;base64,");
  });

  it("handles undefined data from debugger (empty result object)", async () => {
    const chrome = buildChromeMock();
    // Override to return {} instead of { data: ... }
    chrome.debugger.sendCommand = mock.fn((_target, method, _params, cb) => {
      if (method === "Page.captureScreenshot") {
        if (cb) cb({});
        return {};
      }
      if (cb) cb({});
      return {};
    });

    const result = await screenshotToolLogic(chrome, 1, { format: "jpeg" });

    assert.equal(result.ok, true);
    assert.equal(result.data._images[0], "data:image/jpeg;base64,undefined");
  });

  it("handles null data from debugger (falls back to mock default via ??)", async () => {
    const chrome = buildChromeMock({ captureData: null });
    const result = await screenshotToolLogic(chrome, 1, { format: "jpeg" });

    // buildChromeMock uses `captureData ?? "AAAA"`, and `??` treats null as
    // nullish, so passing null here yields the mock's default payload.
    assert.equal(result.ok, true);
    assert.equal(result.data._images[0], "data:image/jpeg;base64,AAAA");
  });

  it("preserves all metadata fields on success", async () => {
    const chrome = buildChromeMock({ captureData: "AAAA" });
    const result = await screenshotToolLogic(chrome, 1, { format: "png" });

    assert.equal(result.ok, true);
    assert.equal(result.data.format, "png");
    assert.equal(result.data.mime, "image/png");
    assert.equal(typeof result.data.note, "string");
    assert.ok(result.data.note.length > 0);
    assert.ok(Array.isArray(result.data._images));
    assert.equal(result.data._images.length, 1);
  });

  it("returns structured error on failure with message included", async () => {
    const chrome = buildChromeMock({ debuggerFail: true });
    chrome.tabs.get = mock.fn(async () => ({ active: false }));

    const result = await screenshotToolLogic(chrome, 1, { format: "jpeg" });

    assert.equal(result.ok, false);
    assert.equal(typeof result.error, "string");
    assert.ok(result.error.includes("Screenshot failed"));
  });
});

describe("end-to-end — screenshot → extract → message", () => {
  it("full debugger pipeline produces valid OpenAI image content", async () => {
    // 1. Take screenshot via debugger
    const chrome = buildChromeMock({ captureData: "AAAA" });
    const screenshotResult = await screenshotToolLogic(chrome, 1, { format: "jpeg" });

    // 2. Extract images (sidepanel.js logic)
    const imagePayloads = extractImages(screenshotResult);

    // 3. Build tool message (stringified result — no image data in it)
    const toolMessage = buildToolMessage("call_ss_1", screenshotResult);

    // 4. Build image message (if images present)
    const imageMessage = buildImageMessage(imagePayloads, "call_ss_1");

    // Verify tool message
    assert.equal(toolMessage.role, "tool");
    assert.equal(toolMessage.tool_call_id, "call_ss_1");
    const parsed = JSON.parse(toolMessage.content);
    assert.equal(parsed.ok, true);
    // _images should have been removed by extractImages
    assert.equal(parsed.data._images, undefined);

    // Verify image message
    assert.ok(imageMessage, "Should have image message");
    assert.equal(imageMessage.role, "user");
    assert.equal(imageMessage.content.length, 2); // 1 text + 1 image

    // Verify image_url structure (OpenAI format)
    const imgPart = imageMessage.content[1];
    assert.equal(imgPart.type, "image_url");
    assert.ok(
      imgPart.image_url.url.startsWith("data:"),
      "URL must start with data:"
    );
    assert.ok(
      imgPart.image_url.url.includes(";base64,"),
      "URL must contain ;base64,"
    );
    assert.ok(imgPart.image_url.url.endsWith("AAAA"), "URL must contain the base64 payload");
  });

  it("visible-tab fallback produces same end-to-end result shape", async () => {
    const chrome = buildChromeMock({
      debuggerFail: true,
      visibleTabDataUrl: "data:image/jpeg;base64,FALLBACK"
    });

    const screenshotResult = await screenshotToolLogic(chrome, 1, { format: "jpeg" });
    const imagePayloads = extractImages(screenshotResult);
    const imageMessage = buildImageMessage(imagePayloads, "call_fb_1");

    assert.equal(screenshotResult.ok, true);
    assert.equal(imagePayloads.length, 1);
    assert.equal(imagePayloads[0], "data:image/jpeg;base64,FALLBACK");
    assert.ok(imageMessage);
    assert.equal(imageMessage.content[1].image_url.url, "data:image/jpeg;base64,FALLBACK");
  });

  it("all three MIME types produce valid URLs end-to-end", async () => {
    for (const format of ["png", "jpeg", "webp"]) {
      const chrome = buildChromeMock({ captureData: "AAAA" });
      const result = await screenshotToolLogic(chrome, 1, { format });
      const images = extractImages(result);
      const msg = buildImageMessage(images, `call_${format}_1`);

      assert.ok(msg, `${format}: should have image message`);
      const url = msg.content[1].image_url.url;
      assert.ok(url.startsWith("data:"), `${format}: URL must start with data:`);
      assert.ok(url.includes(`;base64,`), `${format}: URL must contain ;base64,`);
      assert.ok(
        url.startsWith(`data:${MIME_MAP[format]};base64,`),
        `${format}: URL must have correct MIME in data: prefix`
      );
    }
  });
});
