import "@testing-library/jest-dom";
import { vi } from "vitest";

// Mock chrome.runtime for tests
globalThis.chrome = {
  runtime: {
    sendMessage: vi.fn(),
    getURL: vi.fn((path) => `chrome-extension://fake/${path}`),
    lastError: null
  },
  storage: {
    local: {
      get: vi.fn(),
      set: vi.fn()
    },
    session: {
      get: vi.fn(),
      set: vi.fn()
    }
  },
  tabs: {
    create: vi.fn(),
    query: vi.fn()
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
