import "@testing-library/jest-dom";
import { vi } from "vitest";

// Mock chrome.* for tests. Event namespaces are included because
// src/background/index.js and the sidepanel controller register
// listeners at import time.
const mockEvent = () => ({ addListener: vi.fn(), removeListener: vi.fn() });

globalThis.chrome = {
  runtime: {
    sendMessage: vi.fn(),
    getURL: vi.fn((path) => `chrome-extension://fake/${path}`),
    lastError: null,
    onMessage: mockEvent(),
    onInstalled: mockEvent(),
    onStartup: mockEvent()
  },
  storage: {
    local: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {})
    },
    session: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
      remove: vi.fn(async () => {})
    },
    onChanged: mockEvent()
  },
  tabs: {
    create: vi.fn(),
    query: vi.fn(async () => []),
    get: vi.fn(async (tabId) => ({ id: tabId, active: true, windowId: 1, url: "https://example.com", title: "Test" })),
    captureVisibleTab: vi.fn(async () => "image/jpeg;base64,VISIBLE"),
    sendMessage: vi.fn(),
    onUpdated: mockEvent(),
    onRemoved: mockEvent(),
    onActivated: mockEvent()
  },
  windows: {
    getLastFocused: vi.fn(async () => ({ id: 1 })),
    onFocusChanged: mockEvent(),
    WINDOW_ID_NONE: -1
  },
  debugger: {
    attach: vi.fn((target, version, cb) => cb && cb()),
    sendCommand: vi.fn((target, method, params, cb) => cb && cb({ data: "AAAA" })),
    detach: vi.fn((target, cb) => cb && cb())
  },
  sidePanel: {
    setOptions: vi.fn(async () => {}),
    setPanelBehavior: vi.fn(async () => {}),
    open: vi.fn(async () => {})
  },
  action: {
    onClicked: mockEvent()
  },
  scripting: {
    executeScript: vi.fn(async () => {})
  }
};

// Mock monaco-editor modules
vi.mock("monaco-editor", () => ({
  editor: {
    create: () => ({
      getValue: () => "",
      setValue: () => {},
      dispose: () => {},
      focus: () => {},
      layout: () => {},
      addCommand: () => {}
    })
  },
  KeyMod: { CtrlCmd: 1 },
  KeyCode: { KeyS: 1 }
}));

vi.mock("@monaco-editor/react", () => {
  const MockEditor = ({ value, onChange, language }) => (
    <div data-testid="monaco-editor" data-language={language}>
      <textarea
        data-testid="monaco-textarea"
        value={value || ""}
        onChange={(e) => onChange?.(e.target.value)}
      />
    </div>
  );
  return {
    default: MockEditor,
    loader: { config: vi.fn() }
  };
});
