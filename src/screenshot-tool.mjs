/**
 * Screenshot tool implementation for the AgentExtension.
 *
 * This module contains the core screenshot logic extracted from background.js
 * so it can be imported and tested directly.
 */

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

function debuggerAttach(chrome, target, version) {
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

function debuggerSendCommand(chrome, target, method, params) {
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

function debuggerDetach(chrome, target) {
  return new Promise((resolve) => {
    chrome.debugger.detach(target, () => resolve());
  });
}

async function captureScreenshotWithDebugger(chrome, tabId, format, quality) {
  const target = { tabId };
  let attachedByUs = false;

  try {
    await debuggerAttach(chrome, target, "1.3");
    attachedByUs = true;
  } catch (err) {
    if (!/Another debugger is already attached/i.test(err.message)) {
      throw err;
    }
  }

  try {
    await debuggerSendCommand(chrome, target, "Page.enable", {});

    const params = {
      format,
      captureBeyondViewport: true
    };

    if (format !== "png") {
      params.quality = quality;
    }

    const result = await debuggerSendCommand(chrome, target, "Page.captureScreenshot", params);
    return result.data;
  } finally {
    if (attachedByUs) {
      await debuggerDetach(chrome, target).catch(() => {});
    }
  }
}

async function screenshotTool(chrome, tabId, args) {
  if (!tabId) {
    return { ok: false, error: "No bound tab." };
  }

  const format = ["png", "jpeg", "webp"].includes(args.format) ? args.format : "jpeg";
  const quality = clampInt(args.quality, 1, 100, 70);

  try {
    const base64 = await captureScreenshotWithDebugger(chrome, tabId, format, quality);
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

/**
 * Extract images from tool result
 * @param {Object} result - Tool result object
 * @returns {string[]} Array of image data URLs
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
 * Build image message for OpenAI format
 * @param {string[]} imagePayloads - Array of image data URLs
 * @param {string} toolCallId - Tool call ID
 * @returns {Object|null} OpenAI format message or null
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
 * Build tool message for OpenAI format
 * @param {string} toolCallId - Tool call ID
 * @param {Object} result - Tool result
 * @returns {Object} OpenAI format tool message
 */
function buildToolMessage(toolCallId, result) {
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: JSON.stringify(result)
  };
}

export {
  screenshotTool,
  captureScreenshotWithDebugger,
  extractImages,
  buildImageMessage,
  buildToolMessage,
  clampInt,
  MIME_MAP
};