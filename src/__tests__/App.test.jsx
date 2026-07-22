import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import App from "../App";

// Mock chrome.runtime.sendMessage to return list data
beforeEach(() => {
  chrome.runtime.sendMessage.mockImplementation((msg, callback) => {
    if (msg.tool === "memories" && msg.args?.action === "list") {
      callback({ ok: true, data: { count: 0, memories: [] } });
    } else if (msg.tool === "skills" && msg.args?.action === "list") {
      callback({ ok: true, data: { count: 0, skills: [] } });
    } else if (msg.tool === "rules" && msg.args?.action === "list") {
      callback({ ok: true, data: { count: 0, rules: [] } });
    } else {
      callback({ ok: true, data: {} });
    }
  });
});

describe("App", () => {
  it("renders tab bar with all tabs", () => {
    render(<App />);

    expect(screen.getByText("Agent Editor")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /memories/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /skills/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /rules/i })).toBeInTheDocument();
  });

  it("defaults to memories tab", () => {
    render(<App />);

    const memoriesTab = screen.getByRole("button", { name: /memories/i });
    expect(memoriesTab).toHaveClass("active");
  });

  it("switches tabs on click", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /skills/i }));

    await waitFor(() => {
      const skillsTab = screen.getByRole("button", { name: /skills/i });
      expect(skillsTab).toHaveClass("active");
    });
  });

  it("shows empty state when no items selected", () => {
    render(<App />);
    expect(screen.getByText(/select a memory/i)).toBeInTheDocument();
  });
});
