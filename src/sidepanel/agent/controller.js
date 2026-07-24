import { validateToolCall } from "../../lib/toolsSchema.js";
import { performHttpRequest, isLocalOrigin, originMatchesPattern } from "../../lib/network.js";
import { state, emit } from "./store.js";
import { DEFAULT_SETTINGS, normalizeSettings } from "./settings.js";
import { buildSystemMessage } from "./systemPrompt.js";
import { llmChat, fetchModels, filterMessagesForLlm } from "./llm.js";
import {
  parseAssistantResponse,
  messageContentToText
} from "./parsing.js";
import {
  extractImages,
  stringifyToolResult,
  containsImages,
  stripImages,
  looksLikeImageError
} from "./images.js";
import { requiresApprovedPlan, requiresFreshApproval } from "./gating.js";
import { sendMessageWithTimeout } from "./messaging.js";
import { devLog, devGroup, devGroupEnd, devWarn, truncate } from "./util.js";

let tabSwitchQueue = Promise.resolve();
let nextItemId = 1;
const interactionResolvers = new Map();

function newItemId() {
  return `item_${nextItemId++}`;
}

// --- Chat display items (React renders these; state.messages stays the
// OpenAI transcript persisted per tab) ---

function pushItem(item) {
  state.chatItems.push({ id: newItemId(), ...item });
  emit();
  return state.chatItems[state.chatItems.length - 1];
}

function addUserMessage(text) {
  pushItem({ kind: "user", text: messageContentToText(text) });
}

function addAssistantMessage(text, validations = []) {
  pushItem({
    kind: "assistant",
    text: messageContentToText(text),
    chips: validations.map((validation) => ({
      name: validation.name || "unknown",
      ok: Boolean(validation.ok)
    }))
  });
}

function addToolResult(validation, result) {
  // Interactive tools (question/approval/plan) already render as a card —
  // the card IS the record; don't add a duplicate JSON bubble.
  if (result && result.ui) return;

  const ok = Boolean(result && result.ok);
  const args = validation.args ?? validation.normalized?.function?.arguments ?? {};

  pushItem({
    kind: "tool-result",
    ok,
    toolName: validation.name || "tool",
    argsText: truncate(typeof args === "string" ? args : JSON.stringify(args), 300),
    resultText: truncate(JSON.stringify(result, null, 2), 8000)
  });
}

function addCompletedToolUi(ui) {
  if (!ui || !ui.type) return;
  pushItem({
    kind: "interactive",
    uiType: ui.type,
    args: ui.args || {},
    pending: false,
    response: ui.response || {}
  });
}

export function addSystem(text, options = {}) {
  const displayText = messageContentToText(text);
  pushItem({ kind: "system", text: displayText });

  if (options.persist !== false) {
    state.messages.push({ role: "system", content: displayText });
    saveTabState(state.boundTabId).catch(() => {});
  }
}

export function addError(text, options = {}) {
  const displayText = messageContentToText(text);
  pushItem({ kind: "error", text: displayText });

  if (options.persist !== false) {
    state.messages.push({ role: "error", content: displayText });
    saveTabState(state.boundTabId).catch(() => {});
  }
}

/** Rebuild the display list from the persisted transcript (tab switch/load). */
function rebuildChatItems() {
  state.chatItems = [];

  // Map tool_call_id → {name, arguments} so restored tool bubbles keep
  // their tool names and argument summaries.
  const callIndex = new Map();
  for (const msg of state.messages) {
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const toolCall of msg.tool_calls) {
        callIndex.set(toolCall.id, {
          name: toolCall.function?.name || toolCall.name || "tool",
          argsText: toolCall.function?.arguments || "{}"
        });
      }
    }
  }

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
      pushItem({ kind: "system", text: content });
    } else if (msg.role === "error") {
      pushItem({ kind: "error", text: content });
    } else if (msg.role === "tool") {
      // Interactive tools restore as their card only — no JSON bubble.
      if (msg.ui) {
        addCompletedToolUi(msg.ui);
        continue;
      }

      const call = callIndex.get(msg.tool_call_id) || {};
      let ok = true;
      try {
        ok = JSON.parse(content)?.ok !== false;
      } catch {
        // non-JSON content — leave ok true
      }

      pushItem({
        kind: "tool-result",
        ok,
        toolName: call.name || "tool",
        argsText: truncate(call.argsText || "", 300),
        resultText: truncate(content, 8000)
      });
    }
  }

  emit();
}

function setStatus(text) {
  state.statusText = text || "";
  emit();
}

function setRunning(running) {
  state.isRunning = running;
  if (running) {
    state.stopped = false;
  }
  emit();
}

// --- Per-tab state persistence ---

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

// --- Settings ---

export async function loadSettings() {
  const stored = await chrome.storage.local.get("settings");
  state.settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...(stored.settings || {}) });
  // Restore mode state from persisted settings. Safe Mode always includes Plan Mode.
  state.safeMode = state.settings.safeMode;
  state.planMode = state.settings.planMode || state.safeMode;
  emit();
}

export async function saveSettings(formSettings) {
  state.settings = normalizeSettings({
    ...formSettings,
    safeMode: state.safeMode,
    planMode: state.planMode
  });
  await chrome.storage.local.set({ settings: state.settings });

  addSystem("Settings saved.");
  await loadModels();
}

export async function setModel(model) {
  state.settings = { ...state.settings, model };
  emit();
  await chrome.storage.local.set({ settings: state.settings });
}

// --- Tab binding / switching ---

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

export async function onRebind() {
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
  rebuildChatItems();
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

export async function handleTabActivated(newTabId, newTabUrl = "", newTabTitle = "") {
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
  emit();

  if (newTabId !== state.boundTabId) {
    await requestTabSwitch(newTabId);
  }
}

export async function refreshActiveTabInfo() {
  const activeTabId = await getActiveTabIdInLastNormalWindow();
  if (!activeTabId) {
    state.activeTabId = null;
    state.activeTab = null;
    emit();
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

  emit();
}

export async function refreshBoundTabInfo() {
  if (!state.boundTabId) {
    state.boundTab = null;
    emit();
    return;
  }

  try {
    state.boundTab = await chrome.tabs.get(state.boundTabId);
    emit();
  } catch (err) {
    devWarn(`Failed to get tab info for tabId ${state.boundTabId}:`, err);
    state.boundTabId = null;
    state.boundTab = null;
    emit();
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

// --- Chrome event wiring (registered once by SidePanelApp) ---

export function handleBoundTabUpdated(tabId, changeInfo) {
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
}

export function handleTabRemoved(tabId) {
  if (tabId === state.activeTabId) {
    state.activeTabId = null;
    state.activeTab = null;
    emit();
  }

  if (tabId === state.boundTabId) {
    devWarn("Bound tab removed:", tabId);
    state.boundTabId = null;
    state.boundTab = null;
    refreshBoundTabInfo().catch(() => { });
    addSystem("Bound tab closed. Switch to another tab to continue, or use Rebind to refresh the binding.");
  }
}

// --- Models ---

export async function loadModels() {
  state.modelsLoading = true;
  emit();
  setStatus("Loading models...");

  try {
    const models = await fetchModels(state.settings);
    state.models = models;

    if (!state.settings.model && models.length) {
      state.settings = { ...state.settings, model: models[0] };
      await chrome.storage.local.set({ settings: state.settings });
    }

    setStatus("");
  } catch (err) {
    setStatus("");
    addError(`Could not load models: ${err.message}`);
    state.models = [];
  } finally {
    state.modelsLoading = false;
    emit();
  }
}

// --- Composer actions ---

export async function onSend(text) {
  const trimmed = String(text || "").trim();

  if (!trimmed || state.isRunning) return;

  if (!state.boundTabId) {
    addError("No active tab is available for the agent.");
    return;
  }

  state.currentPlan = null;
  state.currentApproval = null;
  addUserMessage(trimmed);

  state.messages.push({
    role: "user",
    content: trimmed
  });

  devLog("User message:", trimmed);

  await saveTabState(state.boundTabId);

  // Track the run so requestTabSwitch can await a mid-flight agent.
  state.runPromise = runAgent();
  await state.runPromise;
}

export function onStop() {
  state.stopped = true;

  if (state.abortController) {
    state.abortController.abort();
  }

  if (state.activePermission) {
    closePermission({ allow: false, scope: "once" });
  }

  // Cancel any pending interactive cards (question/approval/plan). Without
  // this, runAgent awaits the card promise forever and the tab-switch queue
  // deadlocks behind state.runPromise.
  cancelPendingInteractions();

  setStatus("Stopping...");
}

function cancelPendingInteractions() {
  for (const [interactionId, resolve] of interactionResolvers) {
    const item = state.chatItems.find((entry) => entry.id === interactionId);
    if (item) {
      item.pending = false;
      item.response = { cancelled: true, approved: false, answer: "Cancelled by user (agent stopped)." };
    }
    resolve({ cancelled: true, approved: false, answer: "Cancelled by user (agent stopped)." });
  }
  interactionResolvers.clear();
  emit();
}

export async function onClear() {
  if (!window.confirm("Clear chat history and permissions for this session?")) return;

  state.messages = [];
  state.imagePermission = "prompt";
  state.currentPlan = null;
  state.currentApproval = null;
  state.sessionAllowedNetworkOrigins.clear();
  state.sessionDeniedNetworkOrigins.clear();
  state.visionFailed = false;
  state.chatItems = [];
  emit();

  addSystem("Chat cleared.");
  await saveTabState(state.boundTabId);
}

// --- Agent run loop ---

async function runAgent() {
  if (state.isRunning) return;

  const settings = state.settings;

  setRunning(true);
  state.stopped = false;
  state.visionFailed = false;

  let finalAnswer = null;
  let step = 0;
  let apiMessages;

  try {
    apiMessages = [buildSystemMessage(state, settings)].concat(filterMessagesForLlm(state.messages));

    while (step < settings.maxToolSteps) {
      if (state.stopped) break;

      step += 1;
      setStatus(`Step ${step}: calling model...`);

      devGroup(`Step ${step}`);
      devLog("Messages sent to model:", apiMessages.map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content.slice(0, 200) : "[array]" })));

      let response;

      try {
        response = await llmChat(apiMessages, settings, (controller) => {
          state.abortController = controller;
        });
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
            content: stringifyToolResult(result, settings.maxToolResultChars)
          };

          if (result && result.ui) {
            toolMessage.ui = result.ui;
          }

          if (imagePayloads.length && settings.modelSupportsVision && !state.visionFailed) {
            toolMessage.content = [
              { type: "text", text: stringifyToolResult(result, settings.maxToolResultChars) },
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
    state.runPromise = null;
    await saveTabState(completedTabId);
  }
}

// --- Interactive in-chat cards (question / approval / plan) ---

function pushInteractive(uiType, args) {
  return new Promise((resolve) => {
    const interactionId = newItemId();
    interactionResolvers.set(interactionId, resolve);

    state.chatItems.push({
      id: interactionId,
      kind: "interactive",
      uiType,
      args: args || {},
      pending: true,
      response: null,
      interactionId
    });
    emit();
  });
}

/** Called by card components when the user answers/approves/rejects. */
export function resolveInteraction(interactionId, response) {
  const resolve = interactionResolvers.get(interactionId);
  if (!resolve) return;

  interactionResolvers.delete(interactionId);

  const item = state.chatItems.find((entry) => entry.id === interactionId);
  if (item) {
    item.pending = false;
    item.response = response;
  }
  emit();

  resolve(response);
}

// --- Permission modal ---

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
    emit();
  });
}

export function closePermission(response) {
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
  emit();
  active.resolve(response);
}

// --- Tool dispatch ---

export async function executeToolWithPermissions(name, args) {
  try {
    if (requiresApprovedPlan(name, state) && (!state.currentPlan || state.currentPlan.approved !== true)) {
      return {
        ok: false,
        error: {
          code: "plan_required",
          tool: name,
          message: `Plan Mode is ON, so "${name}" is blocked until a plan is approved.`,
          instruction: "Call the 'submit_plan' tool now with a title and an ordered list of steps, then wait for the user to approve it. After approval, call this tool again."
        }
      };
    }

    if (requiresFreshApproval(name, state) && (!state.currentApproval || state.currentApproval.approved !== true)) {
      return {
        ok: false,
        error: {
          code: "approval_required",
          tool: name,
          message: `Safe Mode is ON, so "${name}" is blocked until you obtain fresh approval.`,
          instruction: `Call the 'request_approval' tool now with actionType and a description of this exact action, then wait for the user to approve. After approval, call '${name}' again immediately (approval applies only to the next action).`
        }
      };
    }

    if (requiresFreshApproval(name, state)) {
      state.currentApproval = null;
    }

    if (name === "ask_user_question") {
      const response = await pushInteractive("ask_user_question", args);
      return { ok: true, data: response, ui: { type: name, args, response } };
    }

    if (name === "wait_for_user_input") {
      const response = await pushInteractive("wait_for_user_input", args);
      if (response.cancelled) {
        return { ok: true, data: response, ui: { type: name, args, response } };
      }

      const changes = await executePrivilegedTool("get_changes_since_last_interactive_snapshot", {});
      const pageChanges = changes.ok
        ? changes.data
        : { type: "error", error: changes.error || "Unable to refresh page context." };
      const continuedResponse = { ...response, changes: pageChanges };

      return {
        ok: true,
        data: continuedResponse,
        ui: { type: name, args, response: continuedResponse }
      };
    }

    if (name === "request_approval") {
      // If auto-approve is active, automatically approve
      if (state.autoApproveActions) {
        const autoApprovedResponse = {
          approved: true,
          autoApproved: true,
          actionType: args.actionType || "",
          description: args.description || ""
        };
        state.currentApproval = {
          approved: true,
          actionType: args.actionType || "",
          description: args.description || ""
        };
        // Add a UI notification that it was auto-approved
        addCompletedToolUi({
          type: "request_approval",
          args,
          response: autoApprovedResponse
        });
        return {
          ok: true,
          data: autoApprovedResponse,
          ui: { type: "request_approval", args, response: autoApprovedResponse }
        };
      }

      const response = await pushInteractive("request_approval", args);
      state.currentApproval = {
        approved: response.approved === true,
        actionType: args.actionType || "",
        description: args.description || ""
      };
      return { ok: true, data: response, ui: { type: name, args, response } };
    }

    if (name === "submit_plan") {
      const response = await pushInteractive("submit_plan", args);
      state.currentPlan = {
        title: args.title || "Plan Overview",
        steps: Array.isArray(args.steps) ? args.steps : [],
        approved: response.approved === true,
        feedback: response.feedback || ""
      };
      // Auto-approval is enabled only for an explicitly approved plan that
      // requested it. A later plan without the option turns it off.
      state.autoApproveActions = response.approved === true && response.autoApprove === true;
      state.currentApproval = null;
      emit();
      return { ok: true, data: response, ui: { type: name, args, response } };
    }

    if (name === "assess_page_risk") {
      if (!state.boundTabId) {
        return { ok: false, error: "No bound tab to scan for risks." };
      }
      return await executePrivilegedTool("assess_page_risk", args);
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

  if (state.settings.autoAllowLocalhostNetwork && isLocalOrigin(origin)) return true;

  return (state.settings.networkAllowlist || []).some((pattern) => originMatchesPattern(origin, pattern));
}

function executePrivilegedTool(name, args) {
  return sendMessageWithTimeout(
    {
      type: "executeTool",
      tool: name,
      args,
      tabId: state.boundTabId
    },
    state.settings.toolTimeoutMs || 60000
  );
}

// --- Mode toggles ---

export function togglePlanMode() {
  // If safe mode is on, plan mode is locked on
  if (state.safeMode) {
    addSystem("Plan Mode is locked ON while Safe Mode is active.");
    return;
  }
  state.planMode = !state.planMode;
  state.settings = { ...state.settings, planMode: state.planMode };
  emit();
  chrome.storage.local.set({ settings: state.settings }).catch(() => {});
  addSystem(`Plan Mode ${state.planMode ? "enabled" : "disabled"}.`);
}

export function toggleSafeMode() {
  state.safeMode = !state.safeMode;

  // Safe Mode forces Plan Mode on and persists both mode flags.
  if (state.safeMode) {
    state.planMode = true;
  }

  state.settings = { ...state.settings, safeMode: state.safeMode, planMode: state.planMode };
  emit();
  chrome.storage.local.set({ settings: state.settings }).catch(() => {});

  addSystem(`Safe Mode ${state.safeMode ? "enabled — all guardrails enforced at maximum strictness" : "disabled"}.`);
}

export function setAutoApproveActions(autoApprove) {
  state.autoApproveActions = autoApprove;
  emit();
}

// --- Menu actions ---

export function openEditor() {
  chrome.runtime.sendMessage({ type: "openEditor" });
}

// --- Risk pattern import/export ---

export function exportRiskPatterns() {
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

export function importRiskPatterns(jsonString) {
  chrome.runtime.sendMessage({ type: "importRiskPatterns", jsonString }, (res) => {
    if (res && res.ok) {
      addSystem(`Successfully imported risk patterns.`);
    } else {
      addError(`Failed to import risk patterns: ${res?.error || "Unknown error"}`);
    }
  });
}

// --- Bootstrap ---

let initialized = false;

export async function initController() {
  if (initialized) return;
  initialized = true;

  await loadSettings();
  await bindInitialTab();
  await refreshActiveTabInfo();
  await refreshBoundTabInfo();
  rebuildChatItems();

  await loadModels();

  addSystem("Ready. The agent follows the active tab and keeps a separate chat context for each tab.");
}
