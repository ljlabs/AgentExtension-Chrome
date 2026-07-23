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

      if (state.sessionDeniedNetworkOrigins.set.has(origin)) {
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

// --- Rendering functions ---

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
    dom.planModeBtn.disabled = state.safeMode;
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
      a.download = `risk-patterns-${Date.now() }.json`;
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

// --- Per-tab state persistence ---

async function saveTabState(tabId) {
  if (!tabId) return;
  try {
    await chrome.storage.session.set({
      [`chat_${tabId}`]: {
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
    const key = `chat_${tabId}`;
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

// --- Helper stubs for compatibility ---

async function executeContentScriptTool(tool, args) {
  return { ok: false, error: "Content script tool execution not available from side panel." };
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