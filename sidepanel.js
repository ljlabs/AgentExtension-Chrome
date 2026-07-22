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

    if (content && /