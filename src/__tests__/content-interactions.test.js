import { beforeEach, describe, expect, it, vi } from "vitest";

let pageToolListener;

function mockAgentToolCall(tool, args = {}) {
  return new Promise((resolve) => {
    pageToolListener(
      { type: "PAGE_TOOL", tool, args },
      {},
      (response) => resolve(response)
    );
  });
}

describe("interactive snapshot changes", () => {
  beforeEach(async () => {
    document.body.innerHTML = '<button id="save">Save</button>';
    document.title = "Test page";
    delete window.__LOCAL_LLM_AGENT_CONTENT__;

    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 100,
      height: 30,
      top: 0,
      left: 0,
      right: 100,
      bottom: 30
    });
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn()
    });
    chrome.runtime.onMessage.addListener = vi.fn((listener) => {
      pageToolListener = listener;
    });

    vi.resetModules();
    await import("../content/index.js?interactive-diff");
  });

  it("allows read-only exploration clicks but blocks risky controls", async () => {
    document.body.innerHTML = '<button id="save">Save</button><button id="view">View details</button>';

    const snapshot = await mockAgentToolCall("get_interactive_snapshot");
    const saveRef = snapshot.data.elements.find((element) => element.id === "save").ref;
    const viewRef = snapshot.data.elements.find((element) => element.id === "view").ref;

    const blocked = await mockAgentToolCall("click", { ref: saveRef, exploration: true });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("Exploration click blocked");

    const allowed = await mockAgentToolCall("click", { ref: viewRef, exploration: true });
    expect(allowed.ok).toBe(true);
  });
  it("returns a Git-style diff once, then no changes when checked again", async () => {
    const initial = await mockAgentToolCall("get_interactive_snapshot");

    expect(initial.ok).toBe(true);
    expect(initial.data.count).toBe(1);
    expect(initial.data.elements[0].text).toBe("Save");

    document.querySelector("#save").textContent = "Saved";
    document.body.insertAdjacentHTML("beforeend", '<button id="next">Next</button>');

    const firstChanges = await mockAgentToolCall("get_changes_since_last_interactive_snapshot");
    expect(firstChanges.ok).toBe(true);
    expect(firstChanges.data.type).toBe("diff");
    expect(firstChanges.data.format).toBe("git");
    expect(firstChanges.data.diff).toMatch(/^- .*\n\+ /m);
    expect(firstChanges.data.changed).toHaveLength(1);
    expect(firstChanges.data.added).toHaveLength(1);

    const secondChanges = await mockAgentToolCall("get_changes_since_last_interactive_snapshot");
    expect(secondChanges.ok).toBe(true);
    expect(secondChanges.data.diff).toBe("");
    expect(secondChanges.data.added).toHaveLength(0);
    expect(secondChanges.data.removed).toHaveLength(0);
    expect(secondChanges.data.changed).toHaveLength(0);
  });
});
