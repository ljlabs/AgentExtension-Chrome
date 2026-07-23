import { describe, it, expect, beforeEach, vi } from "vitest";
import { screenshotTool, handleExecuteTool, clampInt } from "../background/index.js";

const MIME_MAP = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp"
};

function mockDebuggerCapture(captureData) {
  chrome.runtime.lastError = null;
  chrome.debugger.attach = vi.fn((target, version, cb) => cb && cb());
  chrome.debugger.sendCommand = vi.fn((target, method, params, cb) => {
    if (method === "Page.captureScreenshot") {
      cb && cb({ data: captureData });
      return;
    }
    cb && cb({});
  });
  chrome.debugger.detach = vi.fn((target, cb) => cb && cb());
}

function mockDebuggerFailure(message = "Cannot attach") {
  chrome.debugger.attach = vi.fn((target, version, cb) => {
    chrome.runtime.lastError = { message };
    cb && cb();
  });
}

beforeEach(() => {
  chrome.runtime.lastError = null;
  chrome.tabs.get = vi.fn(async (tabId) => ({ id: tabId, active: true, windowId: 1, url: "https://example.com", title: "Test" }));
  chrome.tabs.captureVisibleTab = vi.fn(async () => "data:image/jpeg;base64,VISIBLE");
});

describe("screenshotTool — debugger capture", () => {
  for (const format of ["png", "jpeg", "webp"]) {
    it(`${format}: raw base64 produces complete data URL with correct MIME`, async () => {
      mockDebuggerCapture("AAAA");
      const result = await screenshotTool(1, { format });

      expect(result.ok).toBe(true);
      expect(result.data.format).toBe(format);
      expect(result.data.mime).toBe(MIME_MAP[format]);
      expect(result.data._images).toEqual([`data:${MIME_MAP[format]};base64,AAAA`]);
    });
  }

  it("unknown format defaults to jpeg", async () => {
    mockDebuggerCapture("dGVzdA==");
    const result = await screenshotTool(1, { format: "gif" });

    expect(result.ok).toBe(true);
    expect(result.data.format).toBe("jpeg");
    expect(result.data.mime).toBe("image/jpeg");
  });
});

describe("screenshotTool — visible-tab fallback", () => {
  it("falls back to captureVisibleTab when debugger fails", async () => {
    mockDebuggerFailure();
    const result = await screenshotTool(1, { format: "jpeg" });

    expect(result.ok).toBe(true);
    expect(result.data.note).toContain("fallback");
    expect(result.data._images).toEqual(["data:image/jpeg;base64,VISIBLE"]);
  });

  it("returns error when both debugger and fallback fail", async () => {
    mockDebuggerFailure();
    chrome.tabs.get = vi.fn(async () => ({ active: false }));

    const result = await screenshotTool(1, { format: "jpeg" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Screenshot failed");
  });

  it("returns error when tabId is missing", async () => {
    expect((await screenshotTool(null, { format: "jpeg" })).error).toBe("No bound tab.");
    expect((await screenshotTool(undefined, { format: "jpeg" })).error).toBe("No bound tab.");
  });
});

describe("handleExecuteTool — dispatch errors", () => {
  it("errors on missing tool name", async () => {
    const result = await handleExecuteTool({ args: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Missing tool");
  });

  it("errors on page tools without a bound tab", async () => {
    const result = await handleExecuteTool({ tool: "get_text", args: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No bound tab");
  });

  it("handles wait tool inline", async () => {
    const result = await handleExecuteTool({ tool: "wait", args: { ms: 1 } });
    expect(result.ok).toBe(true);
    expect(result.data.waitedMs).toBe(1);
  });
});

describe("clampInt", () => {
  it("clamps and falls back", () => {
    expect(clampInt("5", 1, 10, 3)).toBe(5);
    expect(clampInt("100", 1, 10, 3)).toBe(10);
    expect(clampInt("garbage", 1, 10, 3)).toBe(3);
  });
});
