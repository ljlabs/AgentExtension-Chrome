import { describe, it, expect } from "vitest";
import { parseFrontMatter, buildFrontMatter } from "../utils/frontmatter";

describe("parseFrontMatter", () => {
  it("parses YAML frontmatter", () => {
    const input = `---
name: my-skill
description: A test skill
tags: [testing, example]
---
This is the body content.`;

    const result = parseFrontMatter(input);
    expect(result.meta.name).toBe("my-skill");
    expect(result.meta.description).toBe("A test skill");
    expect(result.meta.tags).toEqual(["testing", "example"]);
    expect(result.body).toBe("This is the body content.");
  });

  it("returns full text as body when no frontmatter", () => {
    const input = "Just plain markdown content.";
    const result = parseFrontMatter(input);
    expect(result.meta).toEqual({});
    expect(result.body).toBe("Just plain markdown content.");
  });

  it("handles empty frontmatter", () => {
    const input = `---
---
Body here.`;
    const result = parseFrontMatter(input);
    expect(result.meta).toEqual({});
    expect(result.body).toBe("Body here.");
  });

  it("parses single-quoted strings", () => {
    const input = `---
name: 'quoted-name'
---
Body`;
    const result = parseFrontMatter(input);
    expect(result.meta.name).toBe("quoted-name");
  });
});

describe("buildFrontMatter", () => {
  it("builds YAML frontmatter from meta object", () => {
    const meta = { name: "test", description: "A test" };
    const body = "Body content";
    const result = buildFrontMatter(meta, body);
    expect(result).toContain("---\nname: test\n");
    expect(result).toContain("description: A test\n");
    expect(result).toContain("---\nBody content");
  });

  it("handles array values", () => {
    const meta = { tags: ["a", "b", "c"] };
    const body = "Content";
    const result = buildFrontMatter(meta, body);
    expect(result).toContain("tags: [a, b, c]");
  });

  it("roundtrips correctly", () => {
    const original = {
      name: "roundtrip",
      description: "Test roundtrip",
      tags: ["one", "two"]
    };
    const body = "Test body";
    const built = buildFrontMatter(original, body);
    const parsed = parseFrontMatter(built);
    expect(parsed.meta.name).toBe("roundtrip");
    expect(parsed.meta.tags).toEqual(["one", "two"]);
    expect(parsed.body).toBe("Test body");
  });
});
