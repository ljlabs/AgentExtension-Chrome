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

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    chrome.runtime.sendMessage({
      type: "tabActivated",
      tabId: activeInfo.tabId,
      url: tab.url || "",
      title: tab.title || ""
    }).catch(() => {});
  } catch (err) {
    console.error("onActivated error", err);
  }
});

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
