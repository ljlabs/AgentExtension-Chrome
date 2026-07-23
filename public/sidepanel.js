(() => {
"use strict";

const DEFAULT_SYSTEM_PROMPT = `You are a careful browser automation agent running inside a Chrome extension side panel.

## Core Rules
- You control only the currently bound active browser tab described in the context.
- Do not ask to switch tabs. The extension automatically follows the active tab and preserves a separate chat context for each tab.
- Use tools to inspect the page before answering questions.
- Prefer get_interactive_snapshot, then use refs for click, type_text, set_value, press_key, and scroll_to.
- If a tool call is invalid, you will receive validation errors. Fix the tool call and try again.
- Do not invent refs, selectors, or page facts.
- When finished, answer in plain text without tool calls unless another tool call is needed.

## Step 1 — Clarify Before Acting
Before starting ANY task, evaluate whether the request is sufficiently clear:
- If the goal, scope, target, or approach is ambiguous, call 'ask_user_question' FIRST with 2-4 recommended options.
- Include a free-text field so the user can add nuance.
- Do NOT begin taking browser actions until you have enough information to act safely.
- For simple, unambiguous 1-step requests (e.g. "what is on this page?") you may skip clarification.

## Step 2 — Research Phase (for complex tasks)
For tasks involving 3 or more steps (e.g. deployments, form filings, multi-page workflows):
- Use get_page_info, get_text, or get_interactive_snapshot to read relevant page content BEFORE planning.
- Identify the specific forms, buttons, and flows involved.
- Check for any warnings, requirements, or prerequisites shown on the page.
- Only proceed to planning once you understand the page context.

## Step 3 — Plan Mode (for multi-step tasks)
For tasks requiring 3 or more browser actions:
- Call 'submit_plan' with a clear title, ordered steps list, and notes about risks/assumptions.
- Wait for the user to Approve or Reject the plan before executing anything.
- If the user provides feedback or rejects the plan, revise and resubmit.
- Never skip the plan step for complex tasks — this keeps the user in control.

## Step 4 — Approval for High-Risk Actions
Always call 'request_approval' before performing ANY of the following, even if part of an approved plan:
- Clicking a submit, confirm, checkout, publish, deploy, send, delete, or remove button.
- Filling in and submitting any form that affects real data (accounts, purchases, messages, files).
- Navigating away from the current page in a way that loses form state.
- Making HTTP POST/PUT/DELETE requests via http_request.
- Any action on a payment, authentication, or settings page.
Include 'actionType', a clear 'description' of what will happen, and 'details' with relevant context (target URL, element text, form values).

## Risk Awareness
- Use 'assess_page_risk' when arriving at a new page during a task to identify high-risk elements.
- Use 'record_risk_assessment' to save any new risk patterns you discover for future sessions.
- When in doubt about whether an action is risky, treat it as high-risk and request approval.`;

const DEFAULT_SETTINGS = {
  baseUrl: "http://localhost:8000/v1",
  modelsPath: "/models",
  chatPath: "/chat/completions",
  apiKey: "",
  model: "",
  temperature: 0.2,
  maxTokens: 2048,
  maxToolSteps: 12,
  maxToolResultChars: 20000,
  requestTimeoutMs: 120000,
  toolTimeoutMs: 60000,
  modelSupportsVision: true,
  autoAllowLocalhostNetwork: true,
  networkAllowlist: [],
  systemPrompt: "",
  safeMode: false,
  planMode: false
};

const TOOL_MAP = globalThis.AGENT_TOOL_MAP || {};

// --- Dev console logging ---
const DEBUG = true;

function devLog(label, ...args) {
  if (DEBUG) console.log(`%c[Agent]%c ${label}`, "color:#888;font-weight:bold", "color:inherit", ...args);
}
function devGroup(label) {
  if (DEBUG) console.group(`%c[Agent]%c ${label}`, "color:#888;font-weight:bold", "color:inherit");
}
function devGroupEnd() {
  if (DEBUG) console.groupEnd();
}
function devWarn(label, ...args) {
  if (DEBUG) console.warn(`%c[Agent]%c ${label}`, "color:#f80;font-weight:bold", "color:inherit", ...args);
}

function truncate(str, maxLen = 100) {
  if (typeof str !== "string") return "";
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen)}...`;
}

const state = {
  boundTabId: null,
  boundTab: null,
  activeTabId: null,
  activeTab: null,
  messages: [],
  models: [],
  isRunning: false,
  stopped: false,
  abortController: null,
  imagePermission: "prompt",
  sessionAllowedNetworkOrigins: new Set(),
  sessionDeniedNetworkOrigins: new Set(),
  visionFailed: false,
  activePermission: null,
  planMode: false,
  safeMode: false,
  currentPlan: null,
  currentApproval: null,
  runPromise: null
};

let tabSwitchQueue = Promise.resolve();

// --- Per-tab state persistence ---
const tabStates = {};

function getTabStateKey(tabId) {
  return `chat_${tabId}`;
}

async function saveTabState(tabId) {
  if (!tabId) return;
  try {
    await chrome.storage.session.set({
      [getTabStateKey(tabId)]: {
        messages: state.messages,
        imagePermission: state.imagePermission
      }
    });
  } catch {
    // storage full or unavailable — silently drop
  }
}

async function loadTabState(tabId) {
  if (!tabId) return;
  try {
    const key = getTabStateKey(tabId);
    const stored = await chrome.storage.session.get(key);
    if (stored[key]) {
      state.messages = stored[key].messages || [];
      state.imagePermission = stored[key].imagePermission || "prompt";
    } else {
      state.messages = [];
      state.imagePermission = "prompt";
    }
    state.sessionAllowedNetworkOrigins.clear();
    state.sessionDeniedNetworkOrigins.clear();
    state.visionFailed = false;
    state.currentPlan = null;
    state.currentApproval = null;
  } catch {
    state.messages = [];
    state.imagePermission = "prompt";
    state.currentPlan = null;
    state.currentApproval = null;
  }
}

function renderChatLog() {
  dom.chatLog.innerHTML = "";

  for (const msg of state.messages) {
    const content = messageContentToText(msg.content);

    if (msg.role === "user") {
      addUserMessage(content);
    } else if (msg.role === "assistant") {
      addAssistantMessage(content, Array.isArray(msg.tool_calls) ? msg.tool_calls.map((toolCall) => ({
        name: toolCall.function?.name || toolCall.name || "unknown",
        ok: true
      })) : []);
    } else if (msg.role === "system") {
      addSystem(content, { persist: false });
    } else if (msg.role === "error") {
      addError(content, { persist: false });
    } else if (msg.role === "tool") {
      if (msg.ui) addCompletedToolUi(msg.ui);

      const body = createMessage("tool", "Tool Result");
      addParagraph(body, truncate(content, 500));
    }
  }

  scrollToBottom();
}

function renderStatusPill() {
  const pill = document.getElementById("statusPill");
  if (!pill) return;

  if (!state.boundTabId || !state.boundTab) {
    pill.textContent = "NO TAB";
    pill.title = "No tab bound";
    pill.className = "status-pill status-pill--none";
    return;
  }

  const url = state.boundTab.url || "";
  const hostname = (() => {
    try { return new URL(url).hostname; } catch { return "unknown"; }
  })();

  pill.textContent = hostname || "unknown";
  pill.title = `${state.boundTab.title || "Untitled"}\n${url}\nTab #${state.boundTab.id}`;
  pill.className = "status-pill status-pill--active";
}

function renderActiveTabInfo() {
  const info = dom.activeTabInfo;
  if (!info) return;

  if (!state.activeTabId || !state.activeTab) {
    info.textContent = "Active: No tab";
    info.title = "No active tab";
    return;
  }

  const tab = state.activeTab;
  const label = tab.title || tab.url || `Tab ${tab.id}`;
  info.textContent = `Active: ${truncate(label, 52)} (#${tab.id})`;
  info.title = `${tab.title || "Untitled"}\n${tab.url || ""}\nTab ID: ${tab.id}`;
}

async function refreshActiveTabInfo() {
  const activeTabId = await getActiveTabIdInLastNormalWindow();
  if (!activeTabId) {
    state.activeTabId = null;
    state.activeTab = null;
    renderActiveTabInfo();
    return;
  }

  try {
    state.activeTabId = activeTabId;
    state.activeTab = await chrome.tabs.get(activeTabId);
  } catch (err) {
    devWarn(`Failed to get active tab info for tabId ${activeTabId}:`, err);
    state.activeTabId = activeTabId;
    state.activeTab = { id: activeTabId };
  }

  renderActiveTabInfo();
}

let settings = { ...DEFAULT_SETTINGS };

const dom = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  cacheDom();
  attachListeners();

  await loadSettings();
  applySettingsToForm();

  // Sync button visual states from persisted settings
  if (state.safeMode && dom.safeModeBtn) {
    dom.safeModeBtn.textContent = "Safe: ON";
    dom.safeModeBtn.classList.add("safe-active");
    if (dom.planModeBtn) dom.planModeBtn.disabled = true;
  }
  if (state.planMode && dom.planModeBtn) {
    dom.planModeBtn.textContent = "Plan: ON";
    dom.planModeBtn.classList.add("plan-active");
  }

  await bindInitialTab();
  await refreshActiveTabInfo();
  await refreshBoundTabInfo();
  renderChatLog();
  renderStatusPill();

  await loadModels();

  addSystem("Ready. The agent follows the active tab and keeps a separate chat context for each tab.");
}

function cacheDom() {
  dom.menuToggleBtn = document.getElementById("menuToggleBtn");
  dom.menuDropdown = document.getElementById("menuDropdown");
  dom.planModeBtn = document.getElementById("planModeBtn");
  dom.safeModeBtn = document.getElementById("safeModeBtn");
  dom.tabInfo = document.getElementById("tabInfo");
  dom.activeTabInfo = document.getElementById("activeTabInfo");
  dom.editBtn = document.getElementById("editBtn");
  dom.rebindBtn = document.getElementById("rebindBtn");
  dom.settingsBtn = document.getElementById("settingsBtn");
  dom.clearBtn = document.getElementById("clearBtn");
  dom.settingsDrawer = document.getElementById("settingsDrawer");
  dom.chatLog = document.getElementById("chatLog");
  dom.statusBar = document.getElementById("statusBar");
  dom.userInput = document.getElementById("userInput");
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
  dom.maxToolResultCharsInput = document.getElementById("maxToolResultCharsInput");
  dom.requestTimeoutInput = document.getElementById("requestTimeoutInput");
  dom.toolTimeoutInput = document.getElementById("toolTimeoutInput");
  dom.modelVisionToggle = document.getElementById("modelVisionToggle");
  dom.autoLocalhostToggle = document.getElementById("autoLocalhostToggle");
  dom.networkAllowlistInput = document.getElementById("networkAllowlistInput");
  dom.systemPromptInput = document.getElementById("systemPromptInput");
  dom.saveSettingsBtn = document.getElementById("saveSettingsBtn");

  dom.exportRiskPatternsBtn = document.getElementById("exportRiskPatternsBtn");
  dom.importRiskPatternsBtn = document.getElementById("importRiskPatternsBtn");
  dom.importRiskFileInput = document.getElementById("importRiskFileInput");

  dom.modalBackdrop = document.getElementById("modalBackdrop");
  dom.modalTitle = document.getElementById("modalTitle");
  dom.modalBody = document.getElementById("modalBody");
  dom.modalAllowOnce = document.getElementById("modalAllowOnce");
  dom.modalAllowSession = document.getElementById("modalAllowSession");
  dom.modalDeny = document.getElementById("modalDeny");
}

function attachListeners() {
  if (dom.menuToggleBtn && dom.menuDropdown) {
    dom.menuToggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      dom.menuDropdown.classList.toggle("hidden");
    });

    document.addEventListener("click", (e) => {
      if (!dom.menuDropdown.contains(e.target) && e.target !== dom.menuToggleBtn) {
        dom.menuDropdown.classList.add("hidden");
      }
    });

    dom.menuDropdown.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        dom.menuDropdown.classList.add("hidden");
      });
    });
  }

  dom.planModeBtn.addEventListener("click", togglePlanMode);
  dom.safeModeBtn.addEventListener("click", toggleSafeMode);
  dom.sendBtn.addEventListener("click", onSend);
  dom.stopBtn.addEventListener("click", onStop);
  dom.clearBtn.addEventListener("click", onClear);
  dom.settingsBtn.addEventListener("click", () => dom.settingsDrawer.classList.toggle("hidden"));
  dom.rebindBtn.addEventListener("click", onRebind);
  dom.editBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "openEditor" });
  });
  dom.refreshModelsBtn.addEventListener("click", loadModels);
  dom.saveSettingsBtn.addEventListener("click", saveSettings);

  dom.exportRiskPatternsBtn.addEventListener("click", onExportRiskPatterns);
  dom.importRiskPatternsBtn.addEventListener("click", () => dom.importRiskFileInput.click());
  dom.importRiskFileInput.addEventListener("change", onImportRiskFile);

  dom.userInput.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      onSend();
    }
  });

  dom.modelSelect.addEventListener("change", async () => {
    settings.model = dom.modelSelect.value;
    await chrome.storage.local.set({ settings });
  });

  dom.modalAllowOnce.addEventListener("click", () => closePermission({ allow: true, scope: "once" }));
  dom.modalAllowSession.addEventListener("click", () => closePermission({ allow: true, scope: "session" }));
  dom.modalDeny.addEventListener("click", () => closePermission({ allow: false, scope: "session" }));

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId === state.activeTabId && (changeInfo.title || changeInfo.url || changeInfo.status)) {
      refreshActiveTabInfo().catch(() => { });
    }

    if (tabId !== state.boundTabId) return;

    devLog("Tab updated:", tabId, changeInfo);
    if (changeInfo.title || changeInfo.url || changeInfo.status) {
      refreshBoundTabInfo().catch(() => { });
    }

    if (changeInfo.status === "complete") {
      ensureBoundContentScript().catch(() => { });
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === state.activeTabId) {
      state.activeTabId = null;
      state.activeTab = null;
      renderActiveTabInfo();
    }

    if (tabId === state.boundTabId) {
      devWarn("Bound tab removed:", tabId);
      state.boundTabId = null;
      state.boundTab = null;
      refreshBoundTabInfo().catch(() => { });
      addSystem("Bound tab closed. Switch to another tab to continue, or use Rebind to refresh the binding.");
    }
  });

  // Listen for tab activation directly in the panel so the bound tab follows
  // the active tab even if the background relay message is missed.
  chrome.tabs.onActivated.addListener((activeInfo) => {
    devLog("tabs.onActivated:", activeInfo.tabId);
    handleTabActivated(activeInfo.tabId).catch(() => {});
  });

  // When focus moves between windows, follow the active tab of the newly
  // focused window.
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    chrome.tabs.query({ active: true, windowId }).then((tabs) => {
      if (tabs[0] && tabs[0].id) {
        handleTabActivated(tabs[0].id).catch(() => {});
      }
    }).catch(() => {});
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === "tabActivated") {
      devLog("Received tabActivated message:", message);
      handleTabActivated(message.tabId, message.url || "", message.title || "").catch(() => {});
    }
  });
}

async function loadSettings() {
  const stored = await chrome.storage.local.get("settings");
  settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...(stored.settings || {}) });
  // Restore mode state from persisted settings. Safe Mode always includes Plan Mode.
  state.safeMode = settings.safeMode;
  state.planMode = settings.planMode || state.safeMode;
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
    maxToolResultChars: Number.parseInt(input.maxToolResultChars, 10),
    requestTimeoutMs: Number.parseInt(input.requestTimeoutMs, 10),
    toolTimeoutMs: Number.parseInt(input.toolTimeoutMs, 10),
    modelSupportsVision: Boolean(input.modelSupportsVision),
    autoAllowLocalhostNetwork: Boolean(input.autoAllowLocalhostNetwork),
    networkAllowlist,
    systemPrompt: String(input.systemPrompt || ""),
    safeMode: Boolean(input.safeMode),
    planMode: Boolean(input.planMode)
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
  dom.maxToolResultCharsInput.value = settings.maxToolResultChars;
  dom.requestTimeoutInput.value = settings.requestTimeoutMs;
  dom.toolTimeoutInput.value = settings.toolTimeoutMs;
  dom.modelVisionToggle.checked = settings.modelSupportsVision;
  dom.autoLocalhostToggle.checked = settings.autoAllowLocalhostNetwork;
  dom.networkAllowlistInput.value = (settings.networkAllowlist || []).join("\n");
  dom.systemPromptInput.value = settings.systemPrompt;
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
    maxToolResultChars: dom.maxToolResultCharsInput.value,
    requestTimeoutMs: dom.requestTimeoutInput.value,
    toolTimeoutMs: dom.toolTimeoutInput.value,
    modelSupportsVision: dom.modelVisionToggle.checked,
    autoAllowLocalhostNetwork: dom.autoLocalhostToggle.checked,
    networkAllowlist: dom.networkAllowlistInput.value,
    systemPrompt: dom.systemPromptInput.value,
    safeMode: state.safeMode,
    planMode: state.planMode
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
      devLog("Bound initial tab from pendingBindTabId:", state.boundTabId);
      await chrome.storage.session.remove("pendingBindTabId");
      await loadTabState(state.boundTabId);
      return;
    }
  } catch (err) {
    devWarn("Failed reading pendingBindTabId:", err);
  }

  state.boundTabId = await getActiveTabIdInLastNormalWindow();
  devLog("Bound initial tab to active tab in window:", state.boundTabId);
  await loadTabState(state.boundTabId);
}

async function getActiveTabIdInLastNormalWindow() {
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (win && win.id) {
      const tabs = await chrome.tabs.query({ active: true, windowId: win.id });
      devLog("getLastFocused window active tab search:", tabs);
      if (tabs[0] && tabs[0].id) return tabs[0].id;
    }
  } catch (err) {
    devWarn("getLastFocused window search failed:", err);
  }

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    devLog("currentWindow active tab search:", tabs);
    if (tabs[0] && tabs[0].id) return tabs[0].id;
  } catch (err) {
    devWarn("currentWindow active tab search failed:", err);
  }

  try {
    const tabs = await chrome.tabs.query({ active: true });
    devLog("all active tabs search:", tabs);
    const normalTab = tabs.find((t) => t && t.url && !t.url.startsWith("chrome-extension://"));
    return normalTab ? normalTab.id : (tabs[0] ? tabs[0].id : null);
  } catch (err) {
    devWarn("all active tabs search failed:", err);
    return null;
  }
}

async function onRebind() {
  const targetTabId = await getActiveTabIdInLastNormalWindow();

  if (!targetTabId) {
    addError("Could not find an active tab to bind.");
    return;
  }

  await requestTabSwitch(targetTabId, { force: true });
  addSystem(`Rebound agent to tab #${targetTabId}.`);
}

async function switchBoundTab(newTabId) {
  if (!newTabId || newTabId === state.boundTabId) return;

  const oldTabId = state.boundTabId;
  devLog("Switching bound tab from", oldTabId, "to", newTabId);

  // Persist the outgoing tab's conversation before swapping.
  await saveTabState(oldTabId);

  state.boundTabId = newTabId;

  // Load the incoming tab's saved conversation (or a fresh empty one).
  await loadTabState(newTabId);

  // Refresh both indicators (bound === active now) and repaint the chat.
  await refreshActiveTabInfo();
  await refreshBoundTabInfo();
  renderStatusPill();
  renderChatLog();
  await ensureBoundContentScript();
}

function requestTabSwitch(newTabId, options = {}) {
  tabSwitchQueue = tabSwitchQueue.then(async () => {
    if (newTabId === state.boundTabId && !options.force) return;

    // If the agent is mid-run, stop it and wait for it to unwind so its
    // messages are saved to the outgoing tab before we swap.
    if (state.isRunning) {
      onStop();
      try {
        await state.runPromise;
      } catch {
        // ignore run errors; we still switch
      }
    }

    await switchBoundTab(newTabId);
  }).catch((err) => {
    devWarn("Tab switch failed:", err);
    addError(`Could not switch to the active tab: ${err.message || String(err)}`);
  });

  return tabSwitchQueue;
}

async function handleTabActivated(newTabId, newTabUrl = "", newTabTitle = "") {
  if (!newTabId) return;

  // Resolve URL/title so we can detect the extension's own pages.
  let tabInfo = { id: newTabId, url: newTabUrl, title: newTabTitle };
  if (!newTabUrl || !newTabTitle) {
    try {
      tabInfo = await chrome.tabs.get(newTabId);
    } catch (err) {
      devWarn(`Failed to read activated tab ${newTabId}:`, err);
    }
  }

  // Ignore the extension's own pages (e.g. the editor tab opened via Edit).
  // These are not real browsing tabs and must not steal the chat session.
  if (tabInfo.url && tabInfo.url.startsWith("chrome-extension://")) {
    devLog("Ignoring activation of extension page:", tabInfo.url);
    return;
  }

  state.activeTabId = newTabId;
  state.activeTab = tabInfo;
  renderActiveTabInfo();

  if (newTabId !== state.boundTabId) {
    await requestTabSwitch(newTabId);
  }
}

async function refreshBoundTabInfo() {
  if (!state.boundTabId) {
    state.boundTab = null;
    dom.tabInfo.textContent = "Bound: No tab";
    renderStatusPill();
    return;
  }

  try {
    const tab = await chrome.tabs.get(state.boundTabId);
    state.boundTab = tab;

    const label = tab.title || tab.url || `Tab ${tab.id}`;
    dom.tabInfo.textContent = `Bound: ${truncate(label, 60)} (#${tab.id})`;
    dom.tabInfo.title = `${tab.url || ""}\nTab ID: ${tab.id}`;
    renderStatusPill();
  } catch (err) {
    devWarn(`Failed to get tab info for tabId ${state.boundTabId}:`, err);
    state.boundTabId = null;
    state.boundTab = null;
    dom.tabInfo.textContent = "Bound: Tab closed";
    renderStatusPill();
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
    addError("No active tab is available for the agent.");
    return;
  }

  dom.userInput.value = "";
  state.currentPlan = null;
  state.currentApproval = null;
  addUserMessage(text);

  state.messages.push({
    role: "user",
    content: text
  });

  devLog("User message:", text);

  await saveTabState(state.boundTabId);
  await runAgent();
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

async function onClear() {
  if (!confirm("Clear chat history and permissions for this session?")) return;

  state.messages = [];
  state.imagePermission = "prompt";
  state.currentPlan = null;
  state.currentApproval = null;
  state.sessionAllowedNetworkOrigins.clear();
  state.sessionDeniedNetworkOrigins.clear();
  state.visionFailed = false;
  dom.chatLog.innerHTML = "";

  addSystem("Chat cleared.");
  await saveTabState(state.boundTabId);
}

async function runAgent() {
  if (state.isRunning) return;

  setRunning(true);
  state.stopped = false;
  state.visionFailed = false;

  let finalAnswer = null;
  let step = 0;
  let apiMessages;

  try {
    apiMessages = buildInitialApiMessages();

    while (step < settings.maxToolSteps) {
      if (state.stopped) break;

      step += 1;
      setStatus(`Step ${step}: calling model...`);

      devGroup(`Step ${step}`);
      devLog("Messages sent to model:", apiMessages.map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content.slice(0, 200) : "[array]" })));

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

      devLog("Model response:", { content: (parsed.content || "").slice(0, 300), toolCalls: (parsed.tool_calls || []).length });

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
          devLog(`Tool call: ${validation.name}`, validation.args);

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

          devLog(`Tool result: ${validation.name}`, { ok: result?.ok, data: result?.data ? JSON.stringify(result.data).slice(0, 300) : result?.error });

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

          if (result && result.ui) {
            toolMessage.ui = result.ui;
          }

          if (imagePayloads.length && settings.modelSupportsVision && !state.visionFailed) {
            toolMessage.content = [
              { type: "text", text: stringifyToolResult(result) },
              ...imagePayloads.map((url) => ({ type: "image_url", image_url: { url } }))
            ];
          }

          apiMessages.push(toolMessage);
          stepMessages.push(toolMessage);

          addToolResult(validation, result);
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
          devGroupEnd();
          continue;
        }

        devGroupEnd();
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
        devGroupEnd();
        continue;
      }

      finalAnswer = parsed.content || "(empty response)";
      assistantMessage.content = finalAnswer;

      devLog("Final answer:", finalAnswer.slice(0, 500));
      devGroupEnd();

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
    const completedTabId = state.boundTabId;
    setRunning(false);
    setStatus("");
    await saveTabState(completedTabId);

    const pendingTabId = state.pendingTabSwitchId;
    state.pendingTabSwitchId = null;
    if (pendingTabId && pendingTabId !== state.boundTabId) {
      await requestTabSwitch(pendingTabId);
    }
  }
}

function buildInitialApiMessages() {
  return [buildSystemMessage()].concat(state.messages);
}

function buildSystemMessage() {
  const basePrompt = settings.systemPrompt && settings.systemPrompt.trim()
    ? settings.systemPrompt.trim()
    : DEFAULT_SYSTEM_PROMPT;

  const tab = state.boundTab || {};

  // Build dynamic guardrail addendum based on active modes
  const guardrailAddendum = [];

  if (state.safeMode) {
    guardrailAddendum.push(
      `## SAFE MODE IS ACTIVE`,
      `All guardrails are enforced at maximum strictness:`,
      `1. You MUST call 'ask_user_question' before starting ANY task unless it is a simple read-only question about the page.`,
      `2. You MUST call 'assess_page_risk' immediately after reading a new page during a task.`,
      `3. You MUST call 'submit_plan' for ANY task involving 2 or more browser actions. Wait for approval before proceeding.`,
      `4. You MUST call 'request_approval' before EVERY click, form submission, or data-modifying action — even within an approved plan.`,
      `5. Never assume. Never skip. Never proceed without explicit user confirmation.`
    );
  } else {
    if (state.planMode) {
      guardrailAddendum.push(
        `## PLAN MODE IS ACTIVE`,
        `You MUST call 'submit_plan' before executing any sequence of browser actions involving 3 or more steps.`,
        `Wait for the user to approve or reject before proceeding. Revise and resubmit if rejected.`,
        `For tasks with 1-2 simple steps you may proceed, but still clarify ambiguities first.`
      );
    }
  }

  const addendum = guardrailAddendum.length
    ? `\n\n---\n${guardrailAddendum.join("\n")}`
    : "";

  return {
    role: "system",
    content:
      `${basePrompt}${addendum}\n\n` +
      `Bound tab title: ${tab.title || "unknown"}\n` +
      `Bound tab URL: ${tab.url || "unknown"}\n` +
      `Bound tab ID: ${state.boundTabId || "unknown"}\n` +
      `Current time: ${new Date().toISOString()}\n` +
      `Active modes: Plan Mode=${state.planMode ? "ON" : "OFF"}, Safe Mode=${state.safeMode ? "ON" : "OFF"}\n\n` +
      `Important: use only the currently bound active tab. Do not request tab switches; the extension changes the bound tab when the active browser tab changes.`
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

const PLAN_GATED_TOOLS = new Set([
  "click",
  "type_text",
  "set_value",
  "press_key",
  "scroll_to",
  "write_browser_storage"
]);

const SAFE_MODE_APPROVAL_TOOLS = new Set([
  "click",
  "type_text",
  "set_value",
  "press_key",
  "write_browser_storage"
]);

function requiresApprovedPlan(name) {
  return (state.planMode || state.safeMode) && PLAN_GATED_TOOLS.has(name);
}

function requiresFreshApproval(name) {
  return state.safeMode && SAFE_MODE_APPROVAL_TOOLS.has(name);
}

async function executeToolWithPermissions(name, args) {
  try {
    if (requiresApprovedPlan(name) && (!state.currentPlan || state.currentPlan.approved !== true)) {
      return {
        ok: false,
        error: {
          code: "plan_required",
          tool: name,
          message: "Plan Mode requires an approved submit_plan before this browser action can run."
        }
      };
    }

    if (requiresFreshApproval(name) && (!state.currentApproval || state.currentApproval.approved !== true)) {
      return {
        ok: false,
        error: {
          code: "approval_required",
          tool: name,
          message: "Safe Mode requires an approved request_approval immediately before this browser action."
        }
      };
    }

    if (requiresFreshApproval(name)) {
      state.currentApproval = null;
    }

    if (name === "ask_user_question") {
      const response = await renderQuestionInChat(args);
      return { ok: true, data: response, ui: { type: name, args, response } };
    }

    if (name === "request_approval") {
      const response = await renderApprovalInChat(args);
      state.currentApproval = {
        approved: response.approved === true,
        actionType: args.actionType || "",
        description: args.description || ""
      };
      return { ok: true, data: response, ui: { type: name, args, response } };
    }

    if (name === "submit_plan") {
      const response = await renderPlanInChat(args);
      state.currentPlan = {
        title: args.title || "Plan Overview",
        steps: Array.isArray(args.steps) ? args.steps : [],
        approved: response.approved === true,
        feedback: response.feedback || ""
      };
      return { ok: true, data: response, ui: { type: name, args, response } };
    }

    if (name === "assess_page_risk") {
      if (!state.boundTabId) {
        return { ok: false, error: "No bound tab to scan for risks." };
      }
      return await executeContentScriptTool("assess_page_risk", args);
    }

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
    const clean = JSON.parse(JSON.stringify(result, (key, value) => key === "ui" ? undefined : value));
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
  addParagraph(body, messageContentToText(text));
}

function addAssistantMessage(text, validations = []) {
  const body = createMessage("assistant", "Agent");
  const displayText = messageContentToText(text);

  if (displayText) {
    if (typeof renderMarkdown === "function") {
      try {
        body.appendChild(renderMarkdown(displayText));
      } catch (err) {
        devWarn("Markdown rendering failed; displaying normalized text:", err);
        addParagraph(body, displayText);
      }
    } else {
      devWarn("Markdown renderer is unavailable; displaying normalized text.");
      addParagraph(body, displayText);
    }
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

  if (!displayText && validations.length) {
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

function addCompletedToolUi(ui) {
  if (!ui || !ui.type) return;

  const args = ui.args || {};
  const response = ui.response || {};
  const body = createMessage("assistant", ui.type === "ask_user_question" ? "Clarifying Question" : ui.type === "request_approval" ? "Approval Required" : "Proposed Plan");
  let card;

  if (ui.type === "ask_user_question") {
    card = document.createElement("div");
    card.className = "question-card restored-ui-card";
    const title = document.createElement("h4");
    title.textContent = args.question || "Question";
    card.appendChild(title);
    const summary = document.createElement("div");
    summary.className = "interactive-response-summary";
    summary.textContent = `Answered: ${response.answer || "No answer provided"}`;
    card.appendChild(summary);
  } else if (ui.type === "request_approval") {
    card = document.createElement("div");
    card.className = "approval-card restored-ui-card";
    const badge = document.createElement("span");
    badge.className = "risk-badge";
    badge.textContent = args.actionType || "HIGH RISK";
    card.appendChild(badge);
    const desc = document.createElement("span");
    desc.style.fontWeight = "700";
    desc.textContent = args.description || "Action approval requested.";
    card.appendChild(desc);
    const summary = document.createElement("div");
    summary.className = "interactive-response-summary";
    summary.style.background = response.approved ? "var(--green)" : "var(--danger)";
    summary.textContent = response.approved ? "Approved" : "Rejected";
    card.appendChild(summary);
  } else if (ui.type === "submit_plan") {
    card = document.createElement("div");
    card.className = "plan-card restored-ui-card";
    const title = document.createElement("h4");
    title.textContent = args.title || "Plan Overview";
    card.appendChild(title);
    const steps = document.createElement("ol");
    steps.className = "plan-steps-list";
    (Array.isArray(args.steps) ? args.steps : []).forEach((step) => {
      const item = document.createElement("li");
      item.textContent = step;
      steps.appendChild(item);
    });
    card.appendChild(steps);
    const summary = document.createElement("div");
    summary.className = "interactive-response-summary";
    summary.style.background = response.approved ? "var(--green)" : "var(--danger)";
    summary.textContent = response.approved
      ? (response.feedback ? `Plan Approved with feedback: "${response.feedback}"` : "Plan Approved")
      : (response.feedback ? `Plan Rejected with feedback: "${response.feedback}"` : "Plan Rejected");
    card.appendChild(summary);
  }

  if (card) body.appendChild(card);
}

function addSystem(text, options = {}) {
  const displayText = messageContentToText(text);
  const body = createMessage("system", "System");
  addParagraph(body, displayText);

  if (options.persist !== false) {
    state.messages.push({ role: "system", content: displayText });
    saveTabState(state.boundTabId).catch(() => {});
  }
}

function addError(text, options = {}) {
  const displayText = messageContentToText(text);
  const body = createMessage("error", "Error");
  addParagraph(body, displayText);

  if (options.persist !== false) {
    state.messages.push({ role: "error", content: displayText });
    saveTabState(state.boundTabId).catch(() => {});
  }
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

function togglePlanMode() {
  // If safe mode is on, plan mode is locked on
  if (state.safeMode) {
    addSystem("Plan Mode is locked ON while Safe Mode is active.");
    return;
  }
  state.planMode = !state.planMode;
  settings.planMode = state.planMode;
  chrome.storage.local.set({ settings }).catch(() => {});
  if (dom.planModeBtn) {
    dom.planModeBtn.textContent = state.planMode ? "Plan: ON" : "Plan: OFF";
    dom.planModeBtn.classList.toggle("plan-active", state.planMode);
  }
  addSystem(`Plan Mode ${state.planMode ? "enabled" : "disabled"}.`);
}

function toggleSafeMode() {
  state.safeMode = !state.safeMode;

  // Safe Mode forces Plan Mode on and persists both mode flags.
  if (state.safeMode) {
    state.planMode = true;
  }

  if (dom.safeModeBtn) {
    dom.safeModeBtn.textContent = state.safeMode ? "Safe: ON" : "Safe: OFF";
    dom.safeModeBtn.classList.toggle("safe-active", state.safeMode);
  }
  if (dom.planModeBtn) {
    dom.planModeBtn.textContent = state.planMode ? "Plan: ON" : "Plan: OFF";
    dom.planModeBtn.classList.toggle("plan-active", state.planMode);
    dom.planModeBtn.disabled = state.safeMode; // lock plan mode btn when safe mode is on
  }

  settings.safeMode = state.safeMode;
  settings.planMode = state.planMode;
  chrome.storage.local.set({ settings }).catch(() => {});

  addSystem(`Safe Mode ${state.safeMode ? "enabled — all guardrails enforced at maximum strictness" : "disabled"}.`);
}

async function renderQuestionInChat(args) {
  return new Promise((resolve) => {
    const body = createMessage("assistant", "Clarifying Question");

    const card = document.createElement("div");
    card.className = "question-card";

    const titleEl = document.createElement("h4");
    titleEl.textContent = args.question || "Question";
    card.appendChild(titleEl);

    const optionsContainer = document.createElement("div");
    optionsContainer.className = "question-options";

    const options = Array.isArray(args.options) ? args.options : [];
    const inputType = args.multiSelect ? "checkbox" : "radio";
    const groupName = `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    options.forEach((optText, i) => {
      const label = document.createElement("label");
      label.className = "question-option-label";

      const input = document.createElement("input");
      input.type = inputType;
      input.name = groupName;
      input.value = optText;

      const span = document.createElement("span");
      span.textContent = optText;

      label.appendChild(input);
      label.appendChild(span);
      optionsContainer.appendChild(label);
    });

    card.appendChild(optionsContainer);

    let freeTextInput = null;
    if (args.allowFreeText !== false) {
      freeTextInput = document.createElement("input");
      freeTextInput.type = "text";
      freeTextInput.className = "question-free-text";
      freeTextInput.placeholder = "Other / additional details...";
      card.appendChild(freeTextInput);
    }

    const submitBtn = document.createElement("button");
    submitBtn.className = "btn primary small";
    submitBtn.textContent = "Submit Answer";
    submitBtn.style.marginTop = "10px";
    card.appendChild(submitBtn);

    body.appendChild(card);
    scrollToBottom();

    submitBtn.addEventListener("click", () => {
      const selected = Array.from(optionsContainer.querySelectorAll("input:checked")).map((el) => el.value);
      const freeText = freeTextInput ? freeTextInput.value.trim() : "";

      let answer = "";
      if (selected.length > 0) {
        answer = selected.join(", ");
        if (freeText) answer += ` (${freeText})`;
      } else {
        answer = freeText || "No answer provided";
      }

      // Remove interactive form controls and highlight selected response
      card.innerHTML = "";
      const summary = document.createElement("div");
      summary.className = "interactive-response-summary";
      summary.textContent = `Answered: ${answer}`;
      card.appendChild(summary);

      resolve({ answer, selectedOptions: selected, freeText });
    });
  });
}

async function renderApprovalInChat(args) {
  return new Promise((resolve) => {
    const body = createMessage("assistant", "Approval Required");

    const card = document.createElement("div");
    card.className = "approval-card";

    const badge = document.createElement("span");
    badge.className = "risk-badge";
    badge.textContent = args.actionType || "HIGH RISK";
    card.appendChild(badge);

    const desc = document.createElement("span");
    desc.style.fontWeight = "700";
    desc.textContent = args.description || "Action approval requested.";
    card.appendChild(desc);

    if (args.details && typeof args.details === "object") {
      const detailsPre = document.createElement("pre");
      detailsPre.style.fontSize = "11px";
      detailsPre.style.marginTop = "6px";
      detailsPre.textContent = JSON.stringify(args.details, null, 2);
      card.appendChild(detailsPre);
    }

    const actionsRow = document.createElement("div");
    actionsRow.style.display = "flex";
    actionsRow.style.gap = "8px";
    actionsRow.style.marginTop = "10px";

    const allowBtn = document.createElement("button");
    allowBtn.className = "btn primary small";
    allowBtn.textContent = "Approve";

    const denyBtn = document.createElement("button");
    denyBtn.className = "btn danger small";
    denyBtn.textContent = "Reject";

    actionsRow.appendChild(allowBtn);
    actionsRow.appendChild(denyBtn);
    card.appendChild(actionsRow);

    body.appendChild(card);
    scrollToBottom();

    const finalize = (approved) => {
      card.innerHTML = "";
      const summary = document.createElement("div");
      summary.className = "interactive-response-summary";
      summary.style.background = approved ? "var(--green)" : "var(--danger)";
      summary.textContent = approved ? "Approved" : "Rejected";
      card.appendChild(summary);

      resolve({ approved, decision: approved ? "approved" : "rejected" });
    };

    allowBtn.addEventListener("click", () => finalize(true));
    denyBtn.addEventListener("click", () => finalize(false));
  });
}

async function renderPlanInChat(args) {
  return new Promise((resolve) => {
    const body = createMessage("assistant", "Proposed Plan");

    const card = document.createElement("div");
    card.className = "plan-card";

    const title = document.createElement("h4");
    title.textContent = args.title || "Plan Overview";
    card.appendChild(title);

    const ol = document.createElement("ol");
    ol.className = "plan-steps-list";
    (args.steps || []).forEach((stepText) => {
      const li = document.createElement("li");
      li.textContent = stepText;
      ol.appendChild(li);
    });
    card.appendChild(ol);

    if (args.notes) {
      const notes = document.createElement("div");
      notes.className = "plan-notes";
      notes.textContent = args.notes;
      card.appendChild(notes);
    }

    const actionsRow = document.createElement("div");
    actionsRow.style.display = "flex";
    actionsRow.style.gap = "8px";
    actionsRow.style.marginTop = "10px";

    const approveBtn = document.createElement("button");
    approveBtn.className = "btn primary small";
    approveBtn.textContent = "Approve Plan";

    const modifyInput = document.createElement("input");
    modifyInput.type = "text";
    modifyInput.placeholder = "Feedback or modifications...";
    modifyInput.className = "question-free-text";
    modifyInput.style.flex = "1";

    const rejectBtn = document.createElement("button");
    rejectBtn.className = "btn danger small";
    rejectBtn.textContent = "Reject";

    actionsRow.appendChild(approveBtn);
    actionsRow.appendChild(rejectBtn);
    card.appendChild(modifyInput);
    card.appendChild(actionsRow);

    body.appendChild(card);
    scrollToBottom();

    const finishPlan = (approved) => {
      const feedback = modifyInput.value.trim();
      card.innerHTML = "";
      const summary = document.createElement("div");
      summary.className = "interactive-response-summary";
      summary.style.background = approved ? "var(--green)" : "var(--danger)";
      summary.textContent = approved 
        ? (feedback ? `Plan Approved with feedback: "${feedback}"` : "Plan Approved")
        : (feedback ? `Plan Rejected with feedback: "${feedback}"` : "Plan Rejected");
      card.appendChild(summary);

      resolve({ approved, feedback });
    };

    approveBtn.addEventListener("click", () => finishPlan(true));
    rejectBtn.addEventListener("click", () => finishPlan(false));
  });
}

async function onExportRiskPatterns() {
  chrome.runtime.sendMessage({ type: "exportRiskPatterns" }, (response) => {
    if (response && response.ok) {
      const blob = new Blob([response.data], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `risk-patterns-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      addSystem("Exported risk patterns.");
    } else {
      addError("Failed to export risk patterns.");
    }
  });
}

function onImportRiskFile(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const jsonString = e.target.result;
      chrome.runtime.sendMessage({ type: "importRiskPatterns", jsonString }, (res) => {
        if (res && res.ok) {
          addSystem(`Successfully imported risk patterns.`);
        } else {
          addError(`Failed to import risk patterns: ${res?.error || "Unknown error"}`);
        }
      });
    } catch (err) {
      addError(`Invalid JSON file: ${err.message}`);
    }
  };
  reader.readAsText(file);
}
})();