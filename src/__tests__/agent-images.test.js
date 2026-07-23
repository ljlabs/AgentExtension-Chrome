import { describe, it, expect } from "vitest";
import {
  extractImages,
  stringifyToolResult,
  containsImages,
  stripImages,
  looksLikeImageError
} from "../sidepanel/agent/images.js";

describe("extractImages", () => {
  it("extracts _images from result.data and deletes them", () => {
    const result = {
      ok: true,
      data: {
        format: "jpeg",
        mime: "image/jpeg",
        _images: ["data:image/jpeg;base64,/9j/4AAQ"]
      }
    };

    const images = extractImages(result);

    expect(images).toEqual(["data:image/jpeg;base64,/9j/4AAQ"]);
    expect(result.data._images).toBeUndefined();
  });

  it("handles multiple images", () => {
    const result = {
      ok: true,
      data: {
        images: [],
        _images: ["data:image/png;base64,abc", "data:image/jpeg;base64,def"]
      }
    };

    const images = extractImages(result);
    expect(images).toHaveLength(2);
  });

  it("extracts top-level _images", () => {
    const result = { ok: true, _images: ["data:image/png;base64,xyz"] };
    expect(extractImages(result)).toEqual(["data:image/png;base64,xyz"]);
    expect(result._images).toBeUndefined();
  });

  it("returns empty when no _images present", () => {
    expect(extractImages({ ok: true, data: { text: "hello" } })).toEqual([]);
  });

  it("returns empty for null/undefined result", () => {
    expect(extractImages(null)).toEqual([]);
    expect(extractImages(undefined)).toEqual([]);
  });
});

describe("stringifyToolResult", () => {
  it("strips the ui key and stringifies", () => {
    const text = stringifyToolResult({ ok: true, data: { a: 1 }, ui: { type: "x" } }, 20000);
    const parsed = JSON.parse(text);
    expect(parsed.ok).toBe(true);
    expect(parsed.ui).toBeUndefined();
  });

  it("truncates past maxToolResultChars", () => {
    const text = stringifyToolResult({ ok: true, data: { big: "x".repeat(500) } }, 100);
    expect(text.length).toBeLessThan(150);
    expect(text).toContain("...[truncated]");
  });

  it("handles serialization failure", () => {
    const circular = {};
    circular.self = circular;
    expect(typeof stringifyToolResult(circular, 1000)).toBe("string");
  });
});

describe("containsImages", () => {
  it("detects image_url parts in array content", () => {
    const messages = [
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,x" } }] }
    ];
    expect(containsImages(messages)).toBe(true);
  });

  it("detects data:image in string content", () => {
    expect(containsImages([{ role: "tool", content: "data:image/jpeg;base64,abc" }])).toBe(true);
  });

  it("returns false for plain text", () => {
    expect(containsImages([{ role: "user", content: "hello" }])).toBe(false);
  });
});

describe("stripImages", () => {
  it("replaces image parts with [image omitted]", () => {
    const messages = [
      {
        role: "tool",
        content: [
          { type: "text", text: "result" },
          { type: "image_url", image_url: { url: "data:image/png;base64,x" } }
        ]
      }
    ];

    const stripped = stripImages(messages);
    expect(stripped[0].content).toBe("result\n[image omitted]");
  });

  it("strips base64 data URLs from string content", () => {
    const stripped = stripImages([{ role: "tool", content: "before data:image/png;base64,AAAA after" }]);
    expect(stripped[0].content).toBe("before [image omitted] after");
  });

  it("leaves plain messages untouched", () => {
    const messages = [{ role: "user", content: "hello" }];
    expect(stripImages(messages)[0]).toEqual(messages[0]);
  });
});

describe("looksLikeImageError", () => {
  it("matches vision/image errors", () => {
    expect(looksLikeImageError(new Error("model does not support image_url content part"))).toBe(true);
    expect(looksLikeImageError(new Error("vision not enabled"))).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(looksLikeImageError(new Error("connection refused"))).toBe(false);
  });
});
