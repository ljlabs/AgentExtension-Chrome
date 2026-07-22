/**
 * Test helpers for the AgentExtension Chrome extension.
 *
 * Provides vm-based loaders that evaluate the real background.js and sidepanel.js
 * inside isolated sandboxes with mocked chrome.* globals, plus shared mock builders.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// Mock chrome APIs for testing
global.chrome = {
  runtime: {
    lastError: null,
    sendMessage: (msg, cb) => cb({}),
    onMessage: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    onMessage: { addListener: () => {} },
  },
  debugger: {
    attach: (target, version, cb) => cb && cb(),
    sendCommand: (target, method, params, cb) => cb && cb({ data: "AAAA" }),
    detach: (target, cb) => cb && cb(),
  },
  tabs: {
    get: async (tabId) => ({ id: tabId, active: true, windowId: 1, url: "https://example.com", title: "Test" }),
    query: async () => [{ id: 1, active: true, windowId: 1, url: "https://example.com", title: "Test" }],
    captureVisibleTab: async (windowId, options) => "image/jpeg;base64,VISIBLE",
    sendMessage: (tabId, msg, opts, cb) => cb && cb({}),
    onUpdated: { addListener: () => {}, removeListener: () => {} },
    onRemoved: { addListener: () => {} },
    onActivated: { addListener: () => {} },
  },
  storage: {
    local: {
      get: async (keys) => ({}),
      set: async (data) => {},
    },
    session: {
      get: async (keys) => ({}),
      set: async (data) => {},
      remove: async (keys) => {},
    },
  },
  sidePanel: {
    setOptions: async () => {},
    setPanelBehavior: async () => {},
    open: async () => {},
  },
  action: {
    onClicked: { addListener: () => {} },
  },
  scripting: {
    executeScript: async () => {},
  },
  windows: {
    getLastFocused: async () => ({ id: 1 }),
  },
};

// Mock global objects
global.btoa = (str) => Buffer.from(str, 'binary').toString('base64');
global.atob = (str) => Buffer.from(str, 'base64').toString('binary');
global.fetch = fetch;
global.Response = Response;
global.Request = Request;
global.Blob = Blob;
global.URL = URL;
global.AbortController = AbortController;
global.setTimeout = setTimeout;
global.clearTimeout = clearTimeout;
global.setTimeout = setTimeout;
global.setInterval = setInterval;
global.clearInterval = clearInterval;
global.console = console;

/**
 * Build a chrome mock with customizable overrides for testing.
 */
export function buildChromeMock(overrides = {}) {
  const runtime = { lastError: null };
  const debuggerFail = overrides.debuggerFail || false;
  const debuggerErrorMsg = overrides.debuggerErrorMsg || "Cannot attach";
  const captureData = overrides.captureData ?? "AAAA";
  const visibleTabDataUrl = overrides.visibleTabDataUrl || "image/jpeg;base64,VISIBLE";
  const tabId = overrides.tabId || 1;
  const tabActive = overrides.tabActive !== undefined ? overrides.tabActive : true;
  const windowId = overrides.windowId || 1;

  return {
    runtime,
    debugger: {
      attach: (target, version, cb) => {
        if (debuggerFail) {
          runtime.lastError = { message: debuggerErrorMsg };
        }
        if (cb) cb();
      },
      sendCommand: (target, method, params, cb) => {
        if (debuggerFail) {
          runtime.lastError = { message: debuggerErrorMsg };
          if (cb) cb(undefined);
          return {};
        }
        if (method === "Page.captureScreenshot") {
          const result = { data: captureData };
          if (cb) cb(result);
          return result;
        }
        if (method === "Page.enable") {
          if (cb) cb({});
          return {};
        }
        if (cb) cb({});
        return {};
      },
      detach: (target, cb) => {
        if (cb) cb();
      }
    },
    tabs: {
      get: async () => ({
        id: tabId,
        active: tabActive,
        windowId: windowId,
        url: "https://example.com",
        title: "Test"
      }),
      captureVisibleTab: async () => visibleTabDataUrl,
      sendMessage: (tabId, msg, opts, cb) => cb && cb({}),
      query: async () => [{ id: 1, active: true, windowId: 1, url: "https://example.com", title: "Test" }],
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      onRemoved: { addListener: () => {} },
      onActivated: { addListener: () => {} },
    },
    storage: {
      local: {
        get: async (keys) => overrides.storageLocalGet ? await overrides.storageLocalGet(keys) : {},
        set: async (data) => overrides.storageLocalSet ? await overrides.storageLocalSet(data) : {},
      },
      session: {
        get: async (keys) => overrides.storageSessionGet ? await overrides.storageSessionGet(keys) : {},
        set: async (data) => overrides.storageSessionSet ? await overrides.storageSessionSet(data) : {},
        remove: async (keys) => overrides.storageSessionRemove ? await overrides.storageSessionRemove(keys) : {},
      },
    },
    sidePanel: {
      setOptions: async () => {},
      setPanelBehavior: async () => {},
      open: async () => {},
    },
    action: { onClicked: { addListener: () => {} } },
    scripting: { executeScript: async () => {} },
    windows: { getLastFocused: async () => ({ id: 1 }) },
    runtime: {
      lastError: null,
      sendMessage: (msg, cb) => cb && cb({}),
      onMessage: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
    },
  };
}

/**
 * Evaluate background.js in a vm sandbox with a mocked chrome global.
 * Returns { sandbox, chrome } — call sandbox.screenshotTool, etc.
 */
export function loadBackground(overrides = {}) {
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

/**
 * Evaluate sidepanel.js in a vm sandbox, stripping the IIFE wrapper,
 * so pure functions like extractImages/containsImages/stripImages are
 * accessible on the returned context.
 */
export function loadSidepanel() {
  let code = readFileSync(resolve(ROOT, "sidepanel.js"), "utf-8");

  // Strip the IIFE wrapper so declarations become sandbox-top-level
  code = code.replace(/^\(\(\) => \{/, "").replace(/\}\)\(\);?\s*$/, "");

  const sandbox = vm.createContext({
    chrome: global.chrome,
    document: {
      getElementById: () => null,
      createElement: (tag) => ({
        textContent: "",
        innerHTML: "",
        appendChild: () => {},
        className: "",
        classList: { add: () => {}, remove: () => {}, contains: () => false },
        style: {},
        href: "",
        target: "",
        rel: "",
        value: "",
        checked: false,
        selected: false,
        click: () => {},
        addEventListener: () => {},
        dispatchEvent: () => {},
        setAttribute: () => {},
        getAttribute: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        dataset: {},
      }),
      createDocumentFragment: () => ({ appendChild: () => {} }),
      addEventListener: () => {},
      body: { appendChild: () => {} },
    },
    MutationObserver: class { observe() {} disconnect() {} },
    console,
    fetch,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
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
    isFinite: globalThis.isFinite,
    Image: class { set src(v) {} },
  });

  vm.runInContext(code, sandbox);

  return sandbox;
}

// --- sidepanel functions: loaded lazily from the real source ---

let _sidepanelCtx = null;
function getSidepanelCtx() {
  if (!_sidepanelCtx) _sidepanelCtx = loadSidepanel();
  return _sidepanelCtx;
}

/**
 * Build image message for OpenAI format (test helper — not duplicated from source)
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
 * Build tool message for OpenAI format (test helper — not duplicated from source)
 */
function buildToolMessage(toolCallId, result) {
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: JSON.stringify(result)
  };
}

/**
 * Access real sidepanel.js functions via lazy vm load.
 * extractImages comes from sidepanel.js; buildImageMessage/buildToolMessage
 * are test-only helpers (sidepanel.js builds these inline, not as functions).
 */
export const sidepanelHelpers = {
  get extractImages() { return getSidepanelCtx().extractImages; },
  get containsImages() { return getSidepanelCtx().containsImages; },
  get stripImages() { return getSidepanelCtx().stripImages; },
  buildImageMessage,
  buildToolMessage,
};

// --- Mock utilities ---

export function resetChromeMock(overrides = {}) {
  global.chrome = buildChromeMock(overrides);
}

export function mockFetch(responses = {}) {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const key = typeof url === 'string' ? url : url.toString();
    if (responses[key]) {
      const resp = responses[key];
      return new Response(resp.body, {
        status: resp.status || 200,
        headers: resp.headers || { 'content-type': 'application/json' }
      });
    }
    return originalFetch(url, options);
  };
  return () => { global.fetch = originalFetch; };
}

export function mockChromeStorage(localData = {}, sessionData = {}) {
  const localStore = { ...localData };
  const sessionStore = { ...sessionData };

  global.chrome.storage.local.get = async (keys) => {
    if (!keys) return { ...localStore };
    if (Array.isArray(keys)) {
      const result = {};
      for (const key of keys) {
        if (localStore[key] !== undefined) result[key] = localStore[key];
      }
      return result;
    }
    return keys in localStore ? { [keys]: localStore[keys] } : {};
  };

  global.chrome.storage.local.set = async (data) => {
    Object.assign(localStore, data);
  };

  global.chrome.storage.session.get = async (keys) => {
    if (!keys) return { ...sessionStore };
    if (Array.isArray(keys)) {
      const result = {};
      for (const key of keys) {
        if (sessionStore[key] !== undefined) result[key] = sessionStore[key];
      }
      return result;
    }
    return keys in sessionStore ? { [keys]: sessionStore[keys] } : {};
  };

  global.chrome.storage.session.set = async (data) => {
    Object.assign(sessionStore, data);
  };

  global.chrome.storage.session.remove = async (keys) => {
    const keyArray = Array.isArray(keys) ? keys : [keys];
    for (const key of keyArray) {
      delete sessionStore[key];
    }
  };
}

export function mockChromeDebugger(options = {}) {
  const {
    attachError = null,
    sendCommandError = null,
    captureScreenshotData = "AAAA",
    captureScreenshotError = null
  } = options;

  let attached = false;

  global.chrome.debugger.attach = (target, version, cb) => {
    if (attachError) {
      global.chrome.runtime.lastError = { message: attachError };
    } else {
      global.chrome.runtime.lastError = null;
      attached = true;
    }
    if (cb) cb();
  };

  global.chrome.debugger.sendCommand = (target, method, params, cb) => {
    if (sendCommandError) {
      global.chrome.runtime.lastError = { message: sendCommandError };
      if (cb) cb(undefined);
      return {};
    }

    if (method === "Page.captureScreenshot") {
      if (captureScreenshotError) {
        global.chrome.runtime.lastError = { message: captureScreenshotError };
        if (cb) cb(undefined);
        return {};
      }
      const result = { data: captureScreenshotData };
      if (cb) cb(result);
      return result;
    }

    if (method === "Page.enable") {
      if (cb) cb({});
      return {};
    }

    if (cb) cb({});
    return {};
  };

  global.chrome.debugger.detach = (target, cb) => {
    attached = false;
    if (cb) cb();
  };
}

export function mockChromeTabs(options = {}) {
  const {
    active = true,
    windowId = 1,
    url = "https://example.com",
    title = "Test",
    captureVisibleTabDataUrl = "image/jpeg;base64,VISIBLE",
    captureVisibleTabError = null,
    getError = null
  } = options;

  global.chrome.tabs.get = async (tabId) => {
    if (getError) throw new Error(getError);
    return { id: tabId, active, windowId, url, title };
  };

  global.chrome.tabs.captureVisibleTab = async (windowId, options) => {
    if (captureVisibleTabError) throw new Error(captureVisibleTabError);
    return captureVisibleTabDataUrl;
  };

  global.chrome.tabs.query = async () => [{ id: 1, active, windowId, url, title }];
}

export function createMockTab(overrides = {}) {
  return {
    id: 1,
    active: true,
    windowId: 1,
    url: "https://example.com",
    title: "Test Page",
    ...overrides
  };
}

export function mockSidepanelFunctions(overrides = {}) {
  const ctx = getSidepanelCtx();
  global.extractImages = overrides.extractImages || ctx.extractImages;
  global.buildImageMessage = overrides.buildImageMessage || buildImageMessage;
  global.buildToolMessage = overrides.buildToolMessage || buildToolMessage;
}
