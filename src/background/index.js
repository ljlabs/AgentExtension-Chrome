import { performHttpRequest } from "../lib/network.js";

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
    console.log("[Background] Configuring side panel options and behavior...");
    await chrome.sidePanel.setOptions({
      enabled: true,
      path: "sidepanel.html"
    });

    await chrome.sidePanel.setPanelBehavior({
      openPanelOnActionClick: true
    });
    console.log("[Background] Side panel configured successfully with openPanelOnActionClick = true.");
  } catch (err) {
    console.error("[Background] Side panel configuration failed:", err);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Background] Extension installed/updated.");
  configureSidePanel();
});
chrome.runtime.onStartup.addListener(() => {
  console.log("[Background] Browser startup.");
  configureSidePanel();
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    console.log("[Background] Tab activated:", activeInfo.tabId, tab.url);
    chrome.runtime.sendMessage({
      type: "tabActivated",
      tabId: activeInfo.tabId,
      url: tab.url || "",
      title: tab.title || ""
    }).catch(() => {});
  } catch (err) {
    console.error("[Background] onActivated error:", err);
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  console.log("[Background] Action clicked for tab:", tab.id, tab.url);

  try {
    await chrome.storage.session.set({
      pendingBindTabId: tab.id,
      pendingBindWindowId: tab.windowId
    });

    await chrome.sidePanel.open({ tabId: tab.id });
    console.log("[Background] Side panel opened for tab:", tab.id);
  } catch (err) {
    console.error("[Background] Failed opening side panel for tab:", err);
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      console.log("[Background] Side panel opened for window:", tab.windowId);
    } catch (err2) {
      console.error("[Background] Fallback side panel open failed:", err2);
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

      if (message.type === "openEditor") {
        await chrome.tabs.create({
          url: chrome.runtime.getURL("editor.html")
        });
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "getRiskPatterns") {
        const patterns = await getRiskPatterns();
        sendResponse({ ok: true, data: patterns });
        return;
      }

      if (message.type === "saveRiskPatterns") {
        await saveRiskPatterns(message.patterns);
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "exportRiskPatterns") {
        const patterns = await getRiskPatterns();
        sendResponse({ ok: true, data: JSON.stringify(patterns, null, 2) });
        return;
      }

      if (message.type === "importRiskPatterns") {
        const imported = typeof message.jsonString === "string" ? JSON.parse(message.jsonString) : message.patterns;
        const current = await getRiskPatterns();
        const merged = mergeRiskPatterns(current, imported);
        await saveRiskPatterns(merged);
        sendResponse({ ok: true, data: merged });
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

  if (tool === "read_browser_storage") {
    return await handleReadBrowserStorage(args);
  }

  if (tool === "write_browser_storage") {
    return await handleWriteBrowserStorage(args);
  }

  if (tool === "record_risk_assessment") {
    return await handleRecordRiskAssessment(args);
  }

  if (tool === "memories") {
    return await handleMemories(args);
  }

  if (tool === "skills") {
    return await handleSkills(args);
  }

  if (tool === "rules") {
    return await handleRules(args);
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

// --- Browser Storage Tools ---

async function handleReadBrowserStorage(args) {
  try {
    const keys = Array.isArray(args.keys) ? args.keys : [];
    const result = await chrome.storage.local.get(keys.length ? keys : null);
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: `Storage read failed: ${err.message}` };
  }
}

async function handleWriteBrowserStorage(args) {
  try {
    if (!args.data || typeof args.data !== "object") {
      return { ok: false, error: "data must be an object with key-value pairs." };
    }
    await chrome.storage.local.set(args.data);
    return { ok: true, data: { stored: Object.keys(args.data) } };
  } catch (err) {
    return { ok: false, error: `Storage write failed: ${err.message}` };
  }
}

// --- Memories Tool ---

async function handleMemories(args) {
  const action = args.action;

  try {
    const stored = await chrome.storage.local.get("agent_memories");
    const memories = stored.agent_memories || { memories: [] };

    if (action === "list") {
      const summaries = memories.memories.map((m) => ({
        id: m.id,
        title: m.title,
        created: m.created,
        updated: m.updated
      }));
      return { ok: true, data: { count: summaries.length, memories: summaries } };
    }

    if (action === "read") {
      if (!args.id) return { ok: false, error: "id is required for read." };
      const memory = memories.memories.find((m) => m.id === args.id);
      if (!memory) return { ok: false, error: `Memory "${args.id}" not found.` };
      return { ok: true, data: memory };
    }

    if (action === "write") {
      const title = args.title || "Untitled";
      const content = args.content || "";

      if (args.id) {
        // Update existing
        const idx = memories.memories.findIndex((m) => m.id === args.id);
        if (idx === -1) return { ok: false, error: `Memory "${args.id}" not found.` };
        memories.memories[idx].title = title;
        memories.memories[idx].content = content;
        memories.memories[idx].updated = new Date().toISOString();
      } else {
        // Create new
        const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        memories.memories.push({
          id,
          title,
          content,
          created: new Date().toISOString(),
          updated: new Date().toISOString()
        });
      }

      await chrome.storage.local.set({ agent_memories: memories });
      return { ok: true, data: { id: args.id || memories.memories[memories.memories.length - 1].id } };
    }

    if (action === "delete") {
      if (!args.id) return { ok: false, error: "id is required for delete." };
      const idx = memories.memories.findIndex((m) => m.id === args.id);
      if (idx === -1) return { ok: false, error: `Memory "${args.id}" not found.` };
      memories.memories.splice(idx, 1);
      await chrome.storage.local.set({ agent_memories: memories });
      return { ok: true, data: { deleted: args.id } };
    }

    return { ok: false, error: `Unknown memories action: ${action}. Use list, read, write, or delete.` };
  } catch (err) {
    return { ok: false, error: `Memories tool failed: ${err.message}` };
  }
}

// --- Skills Tool ---

function parseFrontMatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: text };

  const meta = {};
  const lines = match[1].split("\n");
  for (const line of lines) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) {
      let val = kv[2].trim();
      // Parse YAML array [a, b, c]
      if (val.startsWith("[") && val.endsWith("]")) {
        val = val.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
      }
      meta[kv[1]] = val;
    }
  }

  return { meta, body: match[2] };
}

function buildFrontMatter(meta, body) {
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

async function handleSkills(args) {
  const action = args.action;

  try {
    const stored = await chrome.storage.local.get("agent_skills");
    const skills = stored.agent_skills || { skills: [] };

    if (action === "list") {
      const summaries = skills.skills.map((s) => ({
        id: s.id,
        frontmatter: s.frontmatter
      }));
      return { ok: true, data: { count: summaries.length, skills: summaries } };
    }

    if (action === "read") {
      if (!args.id) return { ok: false, error: "id is required for read." };
      const skill = skills.skills.find((s) => s.id === args.id);
      if (!skill) return { ok: false, error: `Skill "${args.id}" not found.` };
      return { ok: true, data: skill };
    }

    if (action === "write") {
      const name = args.name || "untitled";
      const description = args.description || "";
      const tags = args.tags || [];
      const content = args.content || "";

      const frontmatter = { name, description, tags };
      const fullContent = buildFrontMatter(frontmatter, content);

      if (args.id) {
        // Update existing
        const idx = skills.skills.findIndex((s) => s.id === args.id);
        if (idx === -1) return { ok: false, error: `Skill "${args.id}" not found.` };
        skills.skills[idx].frontmatter = frontmatter;
        skills.skills[idx].content = content;
        skills.skills[idx].fullContent = fullContent;
      } else {
        // Create new
        const id = `skill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        skills.skills.push({
          id,
          frontmatter,
          content,
          fullContent
        });
      }

      await chrome.storage.local.set({ agent_skills: skills });
      return { ok: true, data: { id: args.id || skills.skills[skills.skills.length - 1].id } };
    }

    if (action === "delete") {
      if (!args.id) return { ok: false, error: "id is required for delete." };
      const idx = skills.skills.findIndex((s) => s.id === args.id);
      if (idx === -1) return { ok: false, error: `Skill "${args.id}" not found.` };
      skills.skills.splice(idx, 1);
      await chrome.storage.local.set({ agent_skills: skills });
      return { ok: true, data: { deleted: args.id } };
    }

    return { ok: false, error: `Unknown skills action: ${action}. Use list, read, write, or delete.` };
  } catch (err) {
    return { ok: false, error: `Skills tool failed: ${err.message}` };
  }
}

// --- Rules Tool ---

async function handleRules(args) {
  const action = args.action;

  try {
    const stored = await chrome.storage.local.get("agent_rules");
    const rules = stored.agent_rules || { rules: [] };

    if (action === "list") {
      const summaries = rules.rules.map((r) => ({
        id: r.id,
        title: r.title,
        created: r.created,
        updated: r.updated
      }));
      return { ok: true, data: { count: summaries.length, rules: summaries } };
    }

    if (action === "read") {
      if (!args.id) return { ok: false, error: "id is required for read." };
      const rule = rules.rules.find((r) => r.id === args.id);
      if (!rule) return { ok: false, error: `Rule "${args.id}" not found.` };
      return { ok: true, data: rule };
    }

    if (action === "write") {
      const title = args.title || "Untitled";
      const content = args.content || "";

      if (args.id) {
        const idx = rules.rules.findIndex((r) => r.id === args.id);
        if (idx === -1) return { ok: false, error: `Rule "${args.id}" not found.` };
        rules.rules[idx].title = title;
        rules.rules[idx].content = content;
        rules.rules[idx].updated = new Date().toISOString();
      } else {
        const id = `rule_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        rules.rules.push({
          id,
          title,
          content,
          created: new Date().toISOString(),
          updated: new Date().toISOString()
        });
      }

      await chrome.storage.local.set({ agent_rules: rules });
      return { ok: true, data: { id: args.id || rules.rules[rules.rules.length - 1].id } };
    }

    if (action === "delete") {
      if (!args.id) return { ok: false, error: "id is required for delete." };
      const idx = rules.rules.findIndex((r) => r.id === args.id);
      if (idx === -1) return { ok: false, error: `Rule "${args.id}" not found.` };
      rules.rules.splice(idx, 1);
      await chrome.storage.local.set({ agent_rules: rules });
      return { ok: true, data: { deleted: args.id } };
    }

    return { ok: false, error: `Unknown rules action: ${action}. Use list, read, write, or delete.` };
  } catch (err) {
    return { ok: false, error: `Rules tool failed: ${err.message}` };
  }
}

// --- Page Tools ---

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
      const snapshot = await sendPageTool(tabId, "get_interactive_snapshot", {}, true);
      const data = {
        clicked: true,
        navigated: true,
        url: after.url,
        title: after.title,
        status: after.status,
        note: "Click likely caused navigation. The content-script response was lost, but the bound tab updated."
      };

      if (snapshot.ok) {
        data.changes = {
          type: "full_snapshot",
          reason: "url_changed",
          ...snapshot.data
        };
      }

      return { ok: true, data };
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

const DEFAULT_RISK_PATTERNS = [
  { patternType: "selector", pattern: "button[type='submit'], input[type='submit']", action: "click", riskLevel: "high", reason: "Form submission trigger" },
  { patternType: "urlPattern", pattern: "*play.google.com/console*", action: "navigate", riskLevel: "high", reason: "Google Play Console deployment site" },
  { patternType: "urlPattern", pattern: "*appstoreconnect.apple.com*", action: "navigate", riskLevel: "high", reason: "App Store Connect deployment site" },
  { patternType: "urlPattern", pattern: "*vercel.com*", action: "navigate", riskLevel: "high", reason: "Vercel cloud deployment portal" },
  { patternType: "textPattern", pattern: "\\b(delete|remove|destroy|erase|cancel subscription)\\b", action: "click", riskLevel: "high", reason: "Destructive action label" },
  { patternType: "textPattern", pattern: "\\b(pay|buy|checkout|subscribe|place order)\\b", action: "click", riskLevel: "high", reason: "Financial transaction trigger" },
  { patternType: "inputType", pattern: "file", action: "type_text", riskLevel: "medium", reason: "File upload input" }
];

async function getRiskPatterns() {
  try {
    const res = await chrome.storage.local.get("agent_risk_patterns");
    if (res && res.agent_risk_patterns && Array.isArray(res.agent_risk_patterns.patterns)) {
      return res.agent_risk_patterns.patterns;
    }
  } catch (err) {
    console.error("Failed reading risk patterns", err);
  }
  return DEFAULT_RISK_PATTERNS;
}

async function saveRiskPatterns(patterns) {
  const data = {
    patterns: Array.isArray(patterns) ? patterns : DEFAULT_RISK_PATTERNS,
    updatedAt: new Date().toISOString()
  };
  await chrome.storage.local.set({ agent_risk_patterns: data });
  return data;
}

function mergeRiskPatterns(existing, incoming) {
  const list = Array.isArray(existing) ? [...existing] : [];
  const incomingList = Array.isArray(incoming) ? incoming : [];

  for (const item of incomingList) {
    if (!item || !item.pattern) continue;
    const matchIdx = list.findIndex(p => p.patternType === item.patternType && p.pattern === item.pattern);
    if (matchIdx >= 0) {
      list[matchIdx] = { ...list[matchIdx], ...item };
    } else {
      list.push(item);
    }
  }
  return list;
}

async function handleRecordRiskAssessment(args) {
  const current = await getRiskPatterns();
  const newEntry = {
    patternType: args.patternType,
    pattern: args.pattern,
    action: args.action,
    riskLevel: args.riskLevel || "high",
    reason: args.reason || "Learned risk assessment",
    createdAt: new Date().toISOString()
  };
  const updated = mergeRiskPatterns(current, [newEntry]);
  await saveRiskPatterns(updated);
  return { ok: true, data: { recorded: newEntry, totalPatterns: updated.length } };
}

// Exported for unit tests (Vitest imports this module with a mocked chrome global).
export { screenshotTool, handleExecuteTool, clampInt };
