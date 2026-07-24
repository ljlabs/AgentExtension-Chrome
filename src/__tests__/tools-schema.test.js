import { describe, it, expect } from "vitest";
import {
  AGENT_TOOLS,
  AGENT_TOOL_MAP,
  getOpenAiTools,
  validateToolCall
} from "../lib/toolsSchema.js";

describe("AGENT_TOOLS / AGENT_TOOL_MAP", () => {
  it("has the expected core tools", () => {
    const names = AGENT_TOOLS.map((tool) => tool.name);
    for (const required of [
      "get_page_info", "get_html", "get_text", "get_interactive_snapshot",
      "click", "type_text", "set_value", "press_key", "scroll_to",
      "screenshot", "get_images", "http_request", "wait",
      "ask_user_question", "request_approval", "continue_plan", "submit_plan",
      "assess_page_risk", "record_risk_assessment",
      "memories", "skills", "rules"
    ]) {
      expect(names, `missing tool ${required}`).toContain(required);
    }
  });

  it("map keys mirror the tools list", () => {
    for (const tool of AGENT_TOOLS) {
      expect(AGENT_TOOL_MAP[tool.name]).toBe(tool);
    }
  });

  it("screenshot requires image permission; http_request requires network permission", () => {
    expect(AGENT_TOOL_MAP.screenshot.requiresImagePermission).toBe(true);
    expect(AGENT_TOOL_MAP.http_request.requiresNetworkPermission).toBe(true);
  });
});

describe("getOpenAiTools", () => {
  it("returns OpenAI function-tool format", () => {
    const tools = getOpenAiTools();
    expect(tools.length).toBe(AGENT_TOOLS.length);
    for (const tool of tools) {
      expect(tool.type).toBe("function");
      expect(typeof tool.function.name).toBe("string");
      expect(typeof tool.function.parameters).toBe("object");
    }
  });
});

describe("validateToolCall", () => {
  it("validates a known tool with good args", () => {
    const validation = validateToolCall({
      id: "call_1",
      type: "function",
      function: { name: "wait", arguments: JSON.stringify({ ms: 100 }) }
    }, 0);

    expect(validation.ok).toBe(true);
    expect(validation.name).toBe("wait");
    expect(validation.normalized.function.name).toBe("wait");
  });

  it("rejects unknown tools", () => {
    const validation = validateToolCall({
      id: "call_2",
      type: "function",
      function: { name: "not_a_tool", arguments: "{}" }
    }, 0);

    expect(validation.ok).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
  });

  it("catches invalid argument types", () => {
    // wait.ms must be an integer within range; a non-numeric string fails.
    const validation = validateToolCall({
      id: "call_3",
      type: "function",
      function: { name: "wait", arguments: JSON.stringify({ ms: "not-a-number" }) }
    }, 0);

    expect(validation.ok).toBe(false);
  });

  it("accepts a click marked for pre-plan exploration", () => {
    const validation = validateToolCall({
      id: "call_explore",
      type: "function",
      function: { name: "click", arguments: JSON.stringify({ ref: "e5", exploration: true }) }
    }, 0);

    expect(validation.ok).toBe(true);
    expect(validation.args.exploration).toBe(true);
  });

  it("accepts a click with a ref target (target requirement enforced at runtime, not schema)", () => {
    const validation = validateToolCall({
      id: "call_4",
      type: "function",
      function: { name: "click", arguments: JSON.stringify({ ref: "e5" }) }
    }, 0);

    expect(validation.ok).toBe(true);
    expect(validation.args.ref).toBe("e5");
  });
});