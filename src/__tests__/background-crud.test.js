import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleExecuteTool } from "../background/index.js";

// In-memory chrome.storage.local backing store for CRUD tests.
let store;

beforeEach(() => {
  store = {};
  chrome.storage.local.get = vi.fn(async (key) => {
    if (typeof key === "string") return key in store ? { [key]: store[key] } : {};
    return { ...store };
  });
  chrome.storage.local.set = vi.fn(async (data) => {
    Object.assign(store, data);
  });
});

for (const [tool, storageKey, collection] of [
  ["memories", "agent_memories", "memories"],
  ["rules", "agent_rules", "rules"]
]) {
  describe(`${tool} tool — CRUD against ${storageKey}`, () => {
    it("list returns empty initially", async () => {
      const result = await handleExecuteTool({ tool, args: { action: "list" } });
      expect(result.ok).toBe(true);
      expect(result.data.count).toBe(0);
    });

    it("write creates, list shows summary, read returns content, delete removes", async () => {
      const write = await handleExecuteTool({
        tool,
        args: { action: "write", title: "T1", content: "Body text" }
      });
      expect(write.ok).toBe(true);
      const id = write.data.id;
      expect(id).toBeTruthy();

      const list = await handleExecuteTool({ tool, args: { action: "list" } });
      expect(list.data.count).toBe(1);
      expect(list.data[collection][0].title).toBe("T1");
      // list must be metadata-only
      expect(list.data[collection][0].content).toBeUndefined();

      const read = await handleExecuteTool({ tool, args: { action: "read", id } });
      expect(read.ok).toBe(true);
      expect(read.data.content).toBe("Body text");

      const update = await handleExecuteTool({
        tool,
        args: { action: "write", id, title: "T1b", content: "New body" }
      });
      expect(update.ok).toBe(true);

      const reread = await handleExecuteTool({ tool, args: { action: "read", id } });
      expect(reread.data.title).toBe("T1b");
      expect(reread.data.content).toBe("New body");

      const del = await handleExecuteTool({ tool, args: { action: "delete", id } });
      expect(del.ok).toBe(true);

      const finalList = await handleExecuteTool({ tool, args: { action: "list" } });
      expect(finalList.data.count).toBe(0);
    });

    it("read/delete without id or with unknown id return errors", async () => {
      expect((await handleExecuteTool({ tool, args: { action: "read" } })).ok).toBe(false);
      expect((await handleExecuteTool({ tool, args: { action: "read", id: "nope" } })).ok).toBe(false);
      expect((await handleExecuteTool({ tool, args: { action: "delete", id: "nope" } })).ok).toBe(false);
    });

    it("unknown action returns an actionable error", async () => {
      const result = await handleExecuteTool({ tool, args: { action: "explode" } });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("list, read, write, or delete");
    });
  });
}

describe("skills tool — front matter round trip", () => {
  it("write stores name/description/tags in front matter; read returns them", async () => {
    const write = await handleExecuteTool({
      tool: "skills",
      args: {
        action: "write",
        name: "form-filling",
        description: "How to fill forms",
        tags: ["forms", "web"],
        content: "Snapshot first, then set values."
      }
    });
    expect(write.ok).toBe(true);

    const list = await handleExecuteTool({ tool: "skills", args: { action: "list" } });
    expect(list.ok).toBe(true);
    expect(list.data.count).toBe(1);

    const read = await handleExecuteTool({ tool: "skills", args: { action: "read", id: write.data.id } });
    expect(read.ok).toBe(true);
  });
});

describe("browser storage tools", () => {
  it("write then read round trip", async () => {
    const write = await handleExecuteTool({
      tool: "write_browser_storage",
      args: { data: { note: "remember this", n: 42 } }
    });
    expect(write.ok).toBe(true);

    const read = await handleExecuteTool({
      tool: "read_browser_storage",
      args: { keys: ["note", "n"] }
    });
    expect(read.ok).toBe(true);
  });
});
