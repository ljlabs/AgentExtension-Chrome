import { beforeEach, describe, expect, it, vi } from "vitest";
import { state } from "../sidepanel/agent/store.js";
import { clearSitemap, loadSitemap, recordVisitedUrl } from "../sidepanel/agent/sitemap.js";

beforeEach(() => {
  state.sitemap = [];
  chrome.storage.local.get.mockReset().mockResolvedValue({});
  chrome.storage.local.set.mockReset().mockResolvedValue(undefined);
  chrome.storage.local.remove = vi.fn().mockResolvedValue(undefined);
});

describe("agent sitemap storage", () => {
  it("loads persisted entries and ignores invalid URLs", async () => {
    chrome.storage.local.get.mockResolvedValue({
      agent_sitemap: [
        {
          url: "https://example.com/docs#intro",
          title: "Docs",
          tabId: 7,
          firstVisitedAt: "2025-01-01T00:00:00.000Z",
          lastVisitedAt: "2025-01-01T01:00:00.000Z",
          visitCount: 2
        },
        { url: "chrome://settings" },
        { url: "not a URL" }
      ]
    });

    await loadSitemap();

    expect(state.sitemap).toHaveLength(1);
    expect(state.sitemap[0]).toMatchObject({
      url: "https://example.com/docs",
      title: "Docs",
      tabId: 7,
      visitCount: 2
    });
  });

  it("deduplicates URLs without fragments and increments visit counts", async () => {
    await recordVisitedUrl("https://example.com/docs#intro", { title: "Docs", tabId: 3 });
    await recordVisitedUrl("https://example.com/docs#api", { title: "API Docs", tabId: 4 });

    expect(state.sitemap).toHaveLength(1);
    expect(state.sitemap[0]).toMatchObject({
      url: "https://example.com/docs",
      title: "API Docs",
      tabId: 4,
      visitCount: 2
    });
    expect(chrome.storage.local.set).toHaveBeenLastCalledWith({ agent_sitemap: state.sitemap });
  });

  it("does not persist unsupported URLs", async () => {
    await recordVisitedUrl("mailto:test@example.com");
    await recordVisitedUrl("chrome://settings");

    expect(state.sitemap).toEqual([]);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("clears in-memory and persisted sitemap data", async () => {
    await recordVisitedUrl("https://example.com");

    await clearSitemap();

    expect(state.sitemap).toEqual([]);
    expect(chrome.storage.local.remove).toHaveBeenCalledWith("agent_sitemap");
  });
});
