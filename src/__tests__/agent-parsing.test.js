import { describe, it, expect } from "vitest";
import {
  parseAssistantResponse,
  messageContentToText,
  extractJson,
  convertParsedToToolCalls
} from "../sidepanel/agent/parsing.js";

describe("parseAssistantResponse", () => {
  it("passes through native tool_calls", () => {
    const response = {
      choices: [{
        message: {
          content: "",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "get_text", arguments: "{}" } }]
        }
      }]
    };

    const parsed = parseAssistantResponse(response);
    expect(parsed.tool_calls).toHaveLength(1);
    expect(parsed.tool_calls[0].function.name).toBe("get_text");
  });

  it("returns plain content as final answer", () => {
    const response = { choices: [{ message: { content: "The answer is 42." } }] };
    const parsed = parseAssistantResponse(response);
    expect(parsed.content).toBe("The answer is 42.");
    expect(parsed.tool_calls).toEqual([]);
  });

  it("salvages a JSON tool call embedded in text", () => {
    const response = {
      choices: [{
        message: { content: '{"tool": "get_page_info", "args": {}}' }
      }]
    };

    const parsed = parseAssistantResponse(response);
    expect(parsed.tool_calls).toHaveLength(1);
    expect(parsed.tool_calls[0].function.name).toBe("get_page_info");
  });

  it("flags non-array tool_calls", () => {
    const response = { choices: [{ message: { content: "hi", tool_calls: "bogus" } }] };
    const parsed = parseAssistantResponse(response);
    expect(parsed.invalidToolJsonErrors.length).toBeGreaterThan(0);
  });

  it("handles empty response object", () => {
    const parsed = parseAssistantResponse({});
    expect(parsed.content).toBe("");
    expect(parsed.tool_calls).toEqual([]);
  });
});

describe("messageContentToText", () => {
  it("passes strings through", () => {
    expect(messageContentToText("hello")).toBe("hello");
  });

  it("joins text parts from array content", () => {
    expect(messageContentToText([
      { type: "text", text: "a" },
      { type: "image_url", image_url: { url: "x" } },
      { type: "text", text: "b" }
    ])).toBe("a\nb");
  });

  it("returns empty string for nullish", () => {
    expect(messageContentToText(null)).toBe("");
    expect(messageContentToText(undefined)).toBe("");
  });
});

describe("extractJson", () => {
  it("parses fenced JSON", () => {
    expect(extractJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it("parses balanced braces embedded in prose", () => {
    expect(extractJson('Sure! {"tool": "click", "args": {"ref": "e1"}} done')).toEqual({
      tool: "click",
      args: { ref: "e1" }
    });
  });

  it("handles strings containing braces", () => {
    expect(extractJson('{"text": "a } b"}')).toEqual({ text: "a } b" });
  });

  it("returns undefined for non-JSON", () => {
    expect(extractJson("no json here")).toBeUndefined();
    expect(extractJson("")).toBeUndefined();
  });
});

describe("convertParsedToToolCalls", () => {
  it("converts a single {tool, args} object", () => {
    const calls = convertParsedToToolCalls({ tool: "get_text", args: { selector: "p" } });
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe("function");
    expect(calls[0].function.name).toBe("get_text");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ selector: "p" });
  });

  it("converts an array of calls", () => {
    const calls = convertParsedToToolCalls([
      { name: "get_text", arguments: {} },
      { tool: "click", args: { ref: "e2" } }
    ]);
    expect(calls).toHaveLength(2);
  });

  it("passes through tool_calls arrays", () => {
    const native = [{ id: "x", type: "function", function: { name: "wait", arguments: "{}" } }];
    expect(convertParsedToToolCalls({ tool_calls: native })).toBe(native);
  });

  it("returns empty for garbage", () => {
    expect(convertParsedToToolCalls(null)).toEqual([]);
    expect(convertParsedToToolCalls({ noName: true })).toEqual([]);
  });
});
