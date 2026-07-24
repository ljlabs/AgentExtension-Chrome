import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import Header from "../sidepanel/components/Header.jsx";
import SitemapDrawer from "../sidepanel/components/SitemapDrawer.jsx";
import { state } from "../sidepanel/agent/store.js";

const baseSnapshot = {
  boundTabId: 1,
  boundTab: { id: 1, url: "https://example.com", title: "Example" },
  activeTabId: 1,
  activeTab: { id: 1, url: "https://example.com", title: "Example" },
  planMode: false,
  safeMode: false
};

beforeEach(() => {
  state.sitemap = [];
  chrome.tabs.create.mockReset().mockResolvedValue({});
  chrome.storage.local.remove = vi.fn().mockResolvedValue(undefined);
});

describe("Agent Sitemap UI", () => {
  it("opens from the hamburger menu", () => {
    const onToggleSitemap = vi.fn();

    render(
      <Header
        snapshot={baseSnapshot}
        onToggleSettings={vi.fn()}
        onToggleSitemap={onToggleSitemap}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Agent Sitemap" }));

    expect(onToggleSitemap).toHaveBeenCalledTimes(1);
  });

  it("renders visited URLs and opens an entry in a new tab", () => {
    render(<SitemapDrawer snapshot={{ sitemap: [{
      url: "https://example.com/docs",
      title: "Documentation",
      tabId: 3,
      lastVisitedAt: "2025-01-01T12:00:00.000Z",
      visitCount: 2
    }] }} />);

    expect(screen.getByText("Documentation")).toBeInTheDocument();
    expect(screen.getByText("https://example.com/docs")).toBeInTheDocument();
    expect(screen.getByText("2 visits")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Documentation" }));
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "https://example.com/docs" });
  });

  it("clears the sitemap after confirmation", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<SitemapDrawer snapshot={{ sitemap: [{
      url: "https://example.com",
      title: "Example",
      tabId: 1,
      lastVisitedAt: "2025-01-01T12:00:00.000Z",
      visitCount: 1
    }] }} />);

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(confirm).toHaveBeenCalledWith("Clear the agent sitemap?");
    expect(chrome.storage.local.remove).toHaveBeenCalledWith("agent_sitemap");
    confirm.mockRestore();
  });
});
