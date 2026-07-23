import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, normalizeSettings } from "../sidepanel/agent/settings.js";
import { parseModelsJson } from "../sidepanel/agent/llm.js";
import { requiresApprovedPlan, requiresFreshApproval, PLAN_GATED_TOOLS } from "../sidepanel/agent/gating.js";
import { joinUrl, ensureLeadingSlash } from "../sidepanel/agent/urls.js";

describe("normalizeSettings", () => {
  it("applies defaults when called with spread defaults (real usage)", () => {
    // loadSettings always calls normalizeSettings({...DEFAULT_SETTINGS, ...stored})
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS });
    expect(settings.baseUrl).toBe(DEFAULT_SETTINGS.baseUrl);
    expect(settings.maxToolSteps).toBe(DEFAULT_SETTINGS.maxToolSteps);
    expect(settings.temperature).toBe(DEFAULT_SETTINGS.temperature);
  });

  it("strips trailing slashes from baseUrl", () => {
    expect(normalizeSettings({ baseUrl: "http://x.test/v1///" }).baseUrl).toBe("http://x.test/v1");
  });

  it("splits a newline allowlist string into an array", () => {
    const settings = normalizeSettings({ networkAllowlist: "https://a.test\n\n https://b.test " });
    expect(settings.networkAllowlist).toEqual(["https://a.test", "https://b.test"]);
  });

  it("keeps allowlist arrays as-is", () => {
    expect(normalizeSettings({ networkAllowlist: ["*"] }).networkAllowlist).toEqual(["*"]);
  });

  it("parses numeric strings", () => {
    const settings = normalizeSettings({ maxTokens: "512", temperature: "0.7" });
    expect(settings.maxTokens).toBe(512);
    expect(settings.temperature).toBe(0.7);
  });

  it("ensures leading slash on paths", () => {
    const settings = normalizeSettings({ modelsPath: "models", chatPath: "chat/completions" });
    expect(settings.modelsPath).toBe("/models");
    expect(settings.chatPath).toBe("/chat/completions");
  });
});

describe("parseModelsJson", () => {
  it("parses OpenAI {data: [{id}]} format", () => {
    expect(parseModelsJson({ data: [{ id: "m1" }, { id: "m2" }] })).toEqual(["m1", "m2"]);
  });

  it("parses string arrays", () => {
    expect(parseModelsJson(["a", "b"])).toEqual(["a", "b"]);
  });

  it("parses {models: [...]} and {results: [...]}", () => {
    expect(parseModelsJson({ models: [{ name: "x" }] })).toEqual(["x"]);
    expect(parseModelsJson({ results: ["y"] })).toEqual(["y"]);
  });

  it("dedupes", () => {
    expect(parseModelsJson(["a", "a", "b"])).toEqual(["a", "b"]);
  });

  it("returns empty for garbage", () => {
    expect(parseModelsJson(null)).toEqual([]);
    expect(parseModelsJson(42)).toEqual([]);
  });
});

describe("gating", () => {
  it("plan mode gates browser actions", () => {
    expect(requiresApprovedPlan("click", { planMode: true, safeMode: false })).toBe(true);
    expect(requiresApprovedPlan("get_text", { planMode: true, safeMode: false })).toBe(false);
    expect(requiresApprovedPlan("click", { planMode: false, safeMode: false })).toBe(false);
  });

  it("safe mode implies plan gating", () => {
    expect(requiresApprovedPlan("type_text", { planMode: false, safeMode: true })).toBe(true);
  });

  it("fresh approval only in safe mode", () => {
    expect(requiresFreshApproval("click", { safeMode: true })).toBe(true);
    expect(requiresFreshApproval("click", { safeMode: false })).toBe(false);
    expect(requiresFreshApproval("scroll_to", { safeMode: true })).toBe(false);
  });

  it("PLAN_GATED_TOOLS covers the write actions", () => {
    for (const tool of ["click", "type_text", "set_value", "press_key", "scroll_to", "write_browser_storage"]) {
      expect(PLAN_GATED_TOOLS.has(tool)).toBe(true);
    }
  });
});

describe("urls", () => {
  it("joinUrl joins without duplicate slashes", () => {
    expect(joinUrl("http://x.test/v1/", "/models")).toBe("http://x.test/v1/models");
    expect(joinUrl("http://x.test/v1", "models")).toBe("http://x.test/v1/models");
  });

  it("ensureLeadingSlash", () => {
    expect(ensureLeadingSlash("models")).toBe("/models");
    expect(ensureLeadingSlash("/models")).toBe("/models");
    expect(ensureLeadingSlash("")).toBe("/");
  });
});
