import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useStorage } from "../hooks/useStorage";

beforeEach(() => {
  chrome.runtime.sendMessage.mockReset();
});

describe("useStorage", () => {
  it("loads list on mount", async () => {
    chrome.runtime.sendMessage.mockImplementation((msg, callback) => {
      callback({
        ok: true,
        data: {
          memories: [
            { id: "mem_1", title: "Test Memory", created: "2024-01-01", updated: "2024-01-01" }
          ]
        }
      });
    });

    const { result } = renderHook(() => useStorage("memories"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].title).toBe("Test Memory");
  });

  it("readItem sends correct message", async () => {
    const mockItem = { id: "mem_1", title: "Test", content: "Hello" };
    chrome.runtime.sendMessage.mockImplementation((msg, callback) => {
      callback({ ok: true, data: mockItem });
    });

    const { result } = renderHook(() => useStorage("memories"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const item = await result.current.readItem("mem_1");
    expect(item).toEqual(mockItem);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "memories",
        args: { action: "read", id: "mem_1" }
      }),
      expect.any(Function)
    );
  });

  it("writeItem sends correct message and reloads", async () => {
    let callCount = 0;
    chrome.runtime.sendMessage.mockImplementation((msg, callback) => {
      if (msg.args?.action === "list") {
        callCount++;
        callback({
          ok: true,
          data: {
            memories: callCount > 1
              ? [{ id: "mem_new", title: "New" }]
              : []
          }
        });
      } else {
        callback({ ok: true, data: { id: "mem_new" } });
      }
    });

    const { result } = renderHook(() => useStorage("memories"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const res = await result.current.writeItem({ title: "New", content: "" });
    expect(res.ok).toBe(true);

    await waitFor(() => {
      expect(result.current.items).toHaveLength(1);
    });
  });

  it("deleteItem sends correct message and reloads", async () => {
    chrome.runtime.sendMessage.mockImplementation((msg, callback) => {
      if (msg.args?.action === "list") {
        callback({ ok: true, data: { memories: [] } });
      } else {
        callback({ ok: true, data: { deleted: "mem_1" } });
      }
    });

    const { result } = renderHook(() => useStorage("memories"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const res = await result.current.deleteItem("mem_1");
    expect(res.ok).toBe(true);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        args: { action: "delete", id: "mem_1" }
      }),
      expect.any(Function)
    );
  });
});
