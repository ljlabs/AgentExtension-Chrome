if (!window.__LOCAL_LLM_AGENT_CONTENT__) {
  window.__LOCAL_LLM_AGENT_CONTENT__ = true;

  const DEFAULT_INTERACTIVE_SELECTOR = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="combobox"]',
    '[role="option"]',
    "[onclick]",
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]',
    "label[for]"
  ].join(", ");

  let lastInteractiveSnapshot = null;
  let lastInteractiveSnapshotOptions = null;
  let nextInteractiveRef = 1;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "PAGE_TOOL") return;

    (async () => {
      try {
        const data = await executeContentTool(message.tool, message.args || {});
        sendResponse({ ok: true, data });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();

    return true;
  });

  async function executeContentTool(tool, args) {
    switch (tool) {
      case "get_page_info":
        return getPageInfo();

      case "get_html":
        return getHtml(args);

      case "get_text":
        return getText(args);

      case "get_interactive_snapshot":
        return getInteractiveSnapshot(args);

      case "get_changes_since_last_interactive_snapshot":
        return getChangesSinceLastInteractiveSnapshot();

      case "click":
        return await clickTool(args);

      case "type_text":
        return typeText(args);

      case "set_value":
        return setValueTool(args);

      case "press_key":
        return pressKeyTool(args);

      case "scroll_to":
        return scrollToTool(args);

      case "get_images":
        return getImages(args);

      case "assess_page_risk":
        return scanPageForRisks(args);

      default:
        throw new Error(`Unknown content tool: ${tool}`);
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function truncate(value, max) {
    const text = typeof value === "string" ? value : value == null ? "" : String(value);
    const limit = Number.isFinite(max) && max > 0 ? max : 0;

    if (!limit) {
      return {
        text,
        truncated: false,
        originalLength: text.length,
        returnedLength: text.length
      };
    }

    const truncated = text.length > limit;
    const returned = truncated ? text.slice(0, limit) : text;

    return {
      text: returned,
      truncated,
      originalLength: text.length,
      returnedLength: returned.length
    };
  }

  function hasTargetArgs(args) {
    return Boolean(args && (args.ref || args.selector || args.xpath));
  }

  function resolveTarget(args) {
    if (args.ref) {
      const el = document.querySelector(`[data-llm-agent-ref="${CSS.escape(args.ref)}"]`);
      if (el) return el;
    }

    if (args.selector) {
      try {
        const el = document.querySelector(args.selector);
        if (el) return el;
      } catch (err) {
        throw new Error(`Invalid CSS selector: ${err.message}`);
      }
    }

    if (args.xpath) {
      try {
        const result = document.evaluate(args.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        if (result.singleNodeValue) return result.singleNodeValue;
      } catch (err) {
        throw new Error(`Invalid XPath: ${err.message}`);
      }
    }

    if (args.ref) {
      throw new Error(`Ref "${args.ref}" not found. Call get_interactive_snapshot again to refresh refs.`);
    }

    if (args.selector) {
      throw new Error(`Selector "${args.selector}" not found.`);
    }

    if (args.xpath) {
      throw new Error("XPath did not match any element.");
    }

    throw new Error("Provide ref, selector, or xpath.");
  }

  function resolveTargetOptional(args) {
    if (hasTargetArgs(args)) return resolveTarget(args);
    return null;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;

    const style = getComputedStyle(el);
    if (!style) return false;

    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function getAccessibleText(el) {
    if (!el) return "";

    const ariaLabel = el.getAttribute && el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel;

    if (el.tagName === "IMG" && el.alt) return el.alt;

    if (el.id) {
      try {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label && label.textContent) return label.textContent.trim();
      } catch {
        // ignore
      }
    }

    const closestLabel = el.closest && el.closest("label");
    if (closestLabel && closestLabel.textContent) return closestLabel.textContent.trim();

    if (el.placeholder) return el.placeholder;

    if (typeof el.value === "string" && el.value) return el.value;

    const text = (el.innerText || el.textContent || "").trim();
    return text;
  }

  function getPageInfo() {
    const metaDescription =
      document.querySelector('meta[name="description"]')?.content ||
      document.querySelector('meta[property="og:description"]')?.content ||
      "";

    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      metaDescription,
      viewport: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY
      },
      selection: truncate(window.getSelection ? window.getSelection().toString() : "", 5000).text,
      timestamp: new Date().toISOString()
    };
  }

  function removeComments(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
    const nodes = [];

    while (walker.nextNode()) {
      nodes.push(walker.currentNode);
    }

    nodes.forEach((node) => node.remove());
  }

  function getHtml(args) {
    const el = resolveTargetOptional(args) || document.documentElement;
    const clone = el.cloneNode(true);

    if (!args.includeScripts) {
      clone.querySelectorAll("script, noscript").forEach((node) => node.remove());
    }

    if (!args.includeStyles) {
      clone.querySelectorAll("style, link[rel='stylesheet']").forEach((node) => node.remove());
    }

    if (!args.includeComments) {
      removeComments(clone);
    }

    let html = clone.outerHTML;

    if (el === document.documentElement) {
      html = `<!DOCTYPE html>\n${html}`;
    }

    const result = truncate(html, args.maxLength ?? 120000);

    return {
      url: location.href,
      title: document.title,
      selector: args.selector || args.ref || args.xpath || "html",
      html: result.text,
      truncated: result.truncated,
      originalLength: result.originalLength,
      returnedLength: result.returnedLength
    };
  }

  function getText(args) {
    const el = resolveTargetOptional(args) || document.body;
    const text = el.innerText || el.textContent || "";
    const result = truncate(text, args.maxLength ?? 50000);

    return {
      url: location.href,
      title: document.title,
      text: result.text,
      truncated: result.truncated,
      originalLength: result.originalLength,
      returnedLength: result.returnedLength
    };
  }

  function clearRefs() {
    document.querySelectorAll("[data-llm-agent-ref]").forEach((el) => {
      el.removeAttribute("data-llm-agent-ref");
    });
    nextInteractiveRef = 1;
  }

  function normalizeSnapshotOptions(args = {}) {
    return {
      selector: args.selector || DEFAULT_INTERACTIVE_SELECTOR,
      includeHidden: Boolean(args.includeHidden),
      maxElements: Math.min(Math.max(Number.parseInt(args.maxElements, 10) || 200, 1), 500)
    };
  }

  function getInteractiveSnapshot(args = {}) {
    clearRefs();
    const options = normalizeSnapshotOptions(args);
    const snapshot = collectInteractiveSnapshot(options, false);
    lastInteractiveSnapshot = snapshot;
    lastInteractiveSnapshotOptions = options;
    return snapshot;
  }

  function collectInteractiveSnapshot(options, preserveRefs) {
    let candidates;
    try {
      candidates = Array.from(document.querySelectorAll(options.selector));
    } catch (err) {
      throw new Error(`Invalid snapshot selector: ${err.message}`);
    }

    const elements = [];

    for (const el of candidates) {
      if (elements.length >= options.maxElements) break;
      if (!options.includeHidden && !isVisible(el)) continue;

      let ref = preserveRefs && el.getAttribute("data-llm-agent-ref");
      if (!ref) {
        ref = `e${nextInteractiveRef++}`;
        el.setAttribute("data-llm-agent-ref", ref);
      }

      const rect = el.getBoundingClientRect();
      const tag = el.tagName ? el.tagName.toLowerCase() : "";

      const value =
        tag === "input" && el.type === "password"
          ? "••••••"
          : typeof el.value === "string"
            ? el.value
            : undefined;

      elements.push({
        ref,
        tag,
        role: el.getAttribute ? el.getAttribute("role") || undefined : undefined,
        type: el.getAttribute ? el.getAttribute("type") || undefined : undefined,
        id: el.id || undefined,
        name: el.getAttribute ? el.getAttribute("name") || undefined : undefined,
        testId: el.getAttribute ? el.getAttribute("data-testid") || undefined : undefined,
        text: truncate(getAccessibleText(el), 200).text,
        ariaLabel: el.getAttribute ? el.getAttribute("aria-label") || undefined : undefined,
        placeholder: el.placeholder || undefined,
        value,
        href: el.href || undefined,
        disabled: Boolean(el.disabled),
        checked: Boolean(el.checked),
        selected: Boolean(el.selected),
        readOnly: Boolean(el.readOnly),
        contentEditable: Boolean(el.isContentEditable),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      });
    }

    return {
      url: location.href,
      title: document.title,
      count: elements.length,
      elements,
      hint: "Use refs with click, type_text, set_value, press_key, and scroll_to. Action results include UI changes; call get_changes_since_last_interactive_snapshot when needed."
    };
  }

  function getChangesSinceLastInteractiveSnapshot() {
    if (!lastInteractiveSnapshot) {
      return fullSnapshotChange("no_previous_snapshot", getInteractiveSnapshot({}));
    }

    if (lastInteractiveSnapshot.url !== location.href) {
      return fullSnapshotChange(
        "url_changed",
        getInteractiveSnapshot(lastInteractiveSnapshotOptions || {})
      );
    }

    const current = collectInteractiveSnapshot(lastInteractiveSnapshotOptions, true);
    const previous = lastInteractiveSnapshot;
    const previousByRef = new Map(previous.elements.map((element) => [element.ref, element]));
    const currentByRef = new Map(current.elements.map((element) => [element.ref, element]));

    const added = current.elements.filter((element) => !previousByRef.has(element.ref));
    const removed = previous.elements.filter((element) => !currentByRef.has(element.ref));
    const changed = current.elements
      .filter((element) => previousByRef.has(element.ref))
      .map((element) => ({ before: previousByRef.get(element.ref), after: element }))
      .filter(({ before, after }) => JSON.stringify(before) !== JSON.stringify(after));

    const diffLines = [];
    if (previous.title !== current.title) {
      diffLines.push(`- title: ${JSON.stringify(previous.title)}`);
      diffLines.push(`+ title: ${JSON.stringify(current.title)}`);
    }
    for (const element of removed) diffLines.push(`- ${JSON.stringify(element)}`);
    for (const { before, after } of changed) {
      diffLines.push(`- ${JSON.stringify(before)}`);
      diffLines.push(`+ ${JSON.stringify(after)}`);
    }
    for (const element of added) diffLines.push(`+ ${JSON.stringify(element)}`);

    lastInteractiveSnapshot = current;

    return {
      type: "diff",
      format: "git",
      diff: diffLines.join("\n"),
      url: current.url,
      title: current.title,
      previousTitle: previous.title,
      count: current.count,
      added,
      removed,
      changed,
      unchangedCount: current.count - added.length - changed.length,
      hint: "Apply added and changed elements to the previous snapshot; removed refs are no longer available. The diff uses Git-style '-' removals and '+' additions."
    };
  }

  function fullSnapshotChange(reason, snapshot) {
    return {
      type: "full_snapshot",
      reason,
      ...snapshot
    };
  }

  async function clickTool(args) {
    const el = resolveTarget(args);

    if (el.disabled && !args.force) {
      throw new Error("Element is disabled. Use force:true to click anyway.");
    }

    el.scrollIntoView({ block: "center", inline: "center" });
    await sleep(50);

    const beforeUrl = location.href;
    const beforeTitle = document.title;

    if (typeof el.focus === "function") {
      try {
        el.focus({ preventScroll: true });
      } catch {
        // ignore
      }
    }

    simulateClick(el);

    const waitAfterMs = Math.min(Math.max(Number.parseInt(args.waitAfterMs, 10) || 350, 0), 15000);
    await sleep(waitAfterMs);

    return {
      tag: el.tagName ? el.tagName.toLowerCase() : "",
      text: truncate(getAccessibleText(el), 120).text,
      beforeUrl,
      beforeTitle,
      afterUrl: location.href,
      afterTitle: document.title,
      navigated: beforeUrl !== location.href,
      changes: getChangesSinceLastInteractiveSnapshot()
    };
  }

  function simulateClick(el) {
    const tag = el.tagName ? el.tagName.toUpperCase() : "";
    const type = (el.getAttribute && el.getAttribute("type") || "").toLowerCase();

    if (
      tag === "A" ||
      tag === "BUTTON" ||
      (tag === "INPUT" && ["button", "submit", "reset", "checkbox", "radio"].includes(type))
    ) {
      try {
        el.click();
        return;
      } catch {
        // fall through to synthetic events
      }
    }

    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    const options = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0
    };

    const Pointer = window.PointerEvent || window.MouseEvent;

    try {
      el.dispatchEvent(new Pointer("pointerover", options));
      el.dispatchEvent(new Pointer("pointerenter", options));
      el.dispatchEvent(new Pointer("pointerdown", options));
      el.dispatchEvent(new MouseEvent("mousedown", options));
      el.dispatchEvent(new Pointer("pointerup", options));
      el.dispatchEvent(new MouseEvent("mouseup", options));
      el.dispatchEvent(new MouseEvent("click", options));
    } catch {
      try {
        el.dispatchEvent(new MouseEvent("click", options));
      } catch {
        // ignore
      }
    }
  }

  function dispatchInputEvents(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setNativeValue(el, value) {
    const prototype = Object.getPrototypeOf(el);
    const descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, "value") : undefined;

    if (descriptor && typeof descriptor.set === "function") {
      descriptor.set.call(el, value);
    } else {
      el.value = value;
    }

    dispatchInputEvents(el);
  }

  function clearElement(el) {
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      setNativeValue(el, "");
      return;
    }

    if (el.isContentEditable) {
      el.textContent = "";
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return;
    }

    el.textContent = "";
  }

  function typeText(args) {
    const el = resolveTarget(args);
    const text = args.text == null ? "" : String(args.text);

    const editable =
      el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.isContentEditable;

    if (!editable && !args.force) {
      throw new Error("Target is not an input, textarea, or contenteditable element. Use force:true to force textContent.");
    }

    if ((el.disabled || el.readOnly) && !args.force) {
      throw new Error("Target is disabled or readonly. Use force:true to force typing.");
    }

    el.scrollIntoView({ block: "center", inline: "center" });

    try {
      el.focus({ preventScroll: true });
    } catch {
      // ignore
    }

    if (args.clear) {
      clearElement(el);
    }

    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const nextValue = args.clear ? text : `${el.value || ""}${text}`;
      setNativeValue(el, nextValue);
    } else if (el.isContentEditable) {
      let inserted = false;

      try {
        inserted = document.execCommand("insertText", false, text);
      } catch {
        inserted = false;
      }

      if (!inserted) {
        el.textContent = args.clear ? text : `${el.textContent || ""}${text}`;
        el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      }
    } else {
      el.textContent = args.clear ? text : `${el.textContent || ""}${text}`;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }

    if (args.pressEnter) {
      dispatchKeyEvent(el, "keydown", "Enter", "Enter", 13);
      dispatchKeyEvent(el, "keyup", "Enter", "Enter", 13);
    }

    return {
      typed: text,
      clear: Boolean(args.clear),
      pressEnter: Boolean(args.pressEnter),
      tag: el.tagName ? el.tagName.toLowerCase() : "",
      url: location.href
    };
  }

  function setValueTool(args) {
    const el = resolveTarget(args);
    const rawValue = args.value;

    if (el.type === "checkbox" || el.type === "radio") {
      let checked;

      if (typeof rawValue === "boolean") {
        checked = rawValue;
      } else {
        const normalized = String(rawValue).trim().toLowerCase();
        checked = ["true", "1", "on", "yes", "checked"].includes(normalized);
      }

      el.checked = checked;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));

      return {
        set: true,
        checked,
        tag: el.tagName.toLowerCase(),
        type: el.type
      };
    }

    if (el.tagName === "SELECT") {
      const stringValue = String(rawValue);
      setNativeValue(el, stringValue);

      if (el.value !== stringValue) {
        const option = Array.from(el.options).find((opt) => opt.text.trim() === stringValue.trim());
        if (option) {
          el.value = option.value;
          dispatchInputEvents(el);
        }
      }

      return {
        set: true,
        value: el.value,
        tag: "select"
      };
    }

    setNativeValue(el, rawValue == null ? "" : String(rawValue));

    return {
      set: true,
      value: el.value,
      tag: el.tagName ? el.tagName.toLowerCase() : ""
    };
  }

  function getKeyCode(key) {
    const map = {
      Enter: 13,
      Escape: 27,
      Tab: 9,
      Backspace: 8,
      Delete: 46,
      ArrowLeft: 37,
      ArrowUp: 38,
      ArrowRight: 39,
      ArrowDown: 40,
      " ": 32,
      Spacebar: 32
    };

    if (map[key] !== undefined) return map[key];

    if (key.length === 1) {
      return key.toUpperCase().charCodeAt(0);
    }

    return 0;
  }

  function dispatchKeyEvent(el, type, key, code, keyCode) {
    const event = new KeyboardEvent(type, {
      key,
      code,
      bubbles: true,
      cancelable: true
    });

    try {
      Object.defineProperty(event, "keyCode", { get: () => keyCode });
      Object.defineProperty(event, "which", { get: () => keyCode });
    } catch {
      // ignore
    }

    el.dispatchEvent(event);
  }

  function pressKeyTool(args) {
    const el = hasTargetArgs(args) ? resolveTarget(args) : document.activeElement || document.body;
    const key = String(args.key);
    const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
    const keyCode = getKeyCode(key);

    if (typeof el.focus === "function") {
      try {
        el.focus({ preventScroll: true });
      } catch {
        // ignore
      }
    }

    dispatchKeyEvent(el, "keydown", key, code, keyCode);

    if (key.length === 1) {
      dispatchKeyEvent(el, "keypress", key, code, keyCode);
    }

    dispatchKeyEvent(el, "keyup", key, code, keyCode);

    return {
      key,
      code,
      tag: el.tagName ? el.tagName.toLowerCase() : ""
    };
  }

  async function scrollToTool(args) {
    const behavior = args.behavior === "smooth" ? "smooth" : "auto";

    if (hasTargetArgs(args)) {
      const el = resolveTarget(args);
      el.scrollIntoView({ behavior, block: "center", inline: "center" });

      if (behavior === "smooth") await sleep(100);

      return {
        scrolledToElement: true,
        tag: el.tagName ? el.tagName.toLowerCase() : "",
        changes: getChangesSinceLastInteractiveSnapshot()
      };
    }

    const x = Number.parseInt(args.x, 10) || 0;
    const y = Number.parseInt(args.y, 10) || 0;

    window.scrollTo({ left: x, top: y, behavior });
    if (behavior === "smooth") await sleep(100);

    return {
      scrolledToCoordinates: true,
      x,
      y,
      changes: getChangesSinceLastInteractiveSnapshot()
    };
  }

  function getImages(args) {
    const selector = args.selector || "img";
    const maxImages = Math.min(Math.max(Number.parseInt(args.maxImages, 10) || 20, 1), 50);

    let nodes;
    try {
      nodes = Array.from(document.querySelectorAll(selector));
    } catch (err) {
      throw new Error(`Invalid image selector: ${err.message}`);
    }

    const images = nodes.slice(0, maxImages).map((img, index) => ({
      index,
      src: img.currentSrc || img.src || undefined,
      alt: img.alt || undefined,
      title: img.title || undefined,
      width: img.naturalWidth || img.width || undefined,
      height: img.naturalHeight || img.height || undefined,
      visible: isVisible(img)
    }));

    return {
      url: location.href,
      title: document.title,
      count: images.length,
      images
    };
  }

  function scanPageForRisks(args = {}) {
    const risks = [];
    const url = location.href.toLowerCase();

    // 1. URL pattern risks
    const deployDomains = ["play.google.com/console", "appstoreconnect.apple.com", "vercel.com", "netlify.app", "console.aws.amazon.com", "dashboard.heroku.com"];
    if (deployDomains.some((d) => url.includes(d))) {
      risks.push({
        type: "deployment_url",
        risk: "high",
        description: `Page URL matches developer/deployment console: ${location.hostname}`
      });
    }

    const checkoutKeywords = ["checkout", "cart", "payment", "subscribe", "buy", "billing"];
    if (checkoutKeywords.some((kw) => url.includes(kw))) {
      risks.push({
        type: "payment_url",
        risk: "high",
        description: `Page URL indicates payment/checkout context: ${location.pathname}`
      });
    }

    // 2. High-risk elements
    const submitBtns = Array.from(document.querySelectorAll('form button[type="submit"], form input[type="submit"], button[type="submit"]'));
    submitBtns.forEach((btn, idx) => {
      if (isVisible(btn)) {
        btn.setAttribute("data-llm-agent-risk", "high");
        risks.push({
          type: "form_submission",
          risk: "high",
          element: btn.tagName.toLowerCase(),
          text: (btn.innerText || btn.value || "").trim().slice(0, 50),
          selector: btn.id ? `#${btn.id}` : `button[type="submit"]:nth-of-type(${idx + 1})`
        });
      }
    });

    const actionElements = Array.from(document.querySelectorAll("button, a, input[type='button'], input[type='submit']"));
    const deleteRegex = /\b(delete|remove|destroy|cancel subscription|erase|clear all)\b/i;
    const paymentRegex = /\b(pay|buy|place order|checkout|subscribe|purchase|confirm payment)\b/i;

    actionElements.forEach((el) => {
      if (!isVisible(el)) return;
      const text = (el.innerText || el.value || el.title || el.ariaLabel || "").trim();
      
      if (deleteRegex.test(text)) {
        el.setAttribute("data-llm-agent-risk", "high");
        risks.push({
          type: "deletion",
          risk: "high",
          text,
          tag: el.tagName.toLowerCase()
        });
      } else if (paymentRegex.test(text)) {
        el.setAttribute("data-llm-agent-risk", "high");
        risks.push({
          type: "purchase",
          risk: "high",
          text,
          tag: el.tagName.toLowerCase()
        });
      }
    });

    const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
    fileInputs.forEach((input) => {
      if (isVisible(input)) {
        input.setAttribute("data-llm-agent-risk", "medium");
        risks.push({
          type: "file_upload",
          risk: "medium",
          name: input.name || input.id || "file_input"
        });
      }
    });

    return {
      url: location.href,
      title: document.title,
      riskCount: risks.length,
      hasHighRisk: risks.some((r) => r.risk === "high"),
      risks
    };
  }
}
