import { describe, it, expect, beforeEach, vi } from "vitest";
import { state } from "../sidepanel/agent/store.js";
import {
  executeToolWithPermissions,
  handleTabActivated,
  resolveInteraction
} from "../sidepanel/agent/controller.js";

function resetState() {
  state.boundTabId = 1;
  state.boundTab = { id: 1, url: "https://one.test", title: "One" };
  state.activeTabId = 1;
  state.activeTab = state.boundTab;
  state.messages = [];
  state.chatItems = [];
  state.isRunning = false;
  state.stopped = false;
  state.abortController = null;
  state.currentPlan = null;
  state.currentApproval = null;
  state.planTurnAuthorized = false;
  state.planApproved = false;
  state.autoApproveActions = false;
  state.paused = false;
  state.pausedTabId = null;
  state.restoredPendingInteractions = [];
}

beforeEach(() => {
  resetState();
  const sessions = new Map();
  chrome.storage.session.set = vi.fn(async (value) => {
    Object.entries(value).forEach(([key, data]) => sessions.set(key, structuredClone(data)));
  });
  chrome.storage.session.get = vi.fn(async (key) => ({ [key]: sessions.get(key) }));
  chrome.tabs.get = vi.fn(async (tabId) => ({
    id: tabId,
    active: true,
    windowId: 1,
    url: `https://${tabId}.test`,
    title: `Tab ${tabId}`
  }));
  chrome.tabs.query = vi.fn(async () => []);
  chrome.runtime.sendMessage = vi.fn((message, callback) => callback?.({ ok: true, data: {} }));
});

describe("plan lifecycle", () => {
  it("preserves an awaiting plan card and its resolver across a tab switch", async () => {
    const planPromise = executeToolWithPermissions("submit_plan", {
      title: "Updated pension review",
      objective: "Compare current and alternative funds",
      steps: ["Read current factsheets", "Read alternatives", "Compare charges"],
      verification: ["Check all sources"]
    });
    const card = state.chatItems.at(-1);
    state.currentPlan = {
      planId: "plan_saved",
      title: "Review pension",
      steps: ["Read factsheets"],
      approved: true,
      feedback: ""
    };
    state.planApproved = true;
    state.isRunning = true;
    state.runPromise = planPromise;

    await handleTabActivated(2, "https://two.test", "Two");
    expect(state.boundTabId).toBe(2);
    expect(state.pausedTabId).toBe(1);

    await handleTabActivated(1, "https://one.test", "One");
    const restored = state.chatItems.find((item) => item.id === card.id);
    expect(restored).toMatchObject({ uiType: "submit_plan", pending: true });
    expect(state.currentPlan).toMatchObject({ planId: "plan_saved", approved: true });

    resolveInteraction(card.id, { approved: true, feedback: "" });
    expect((await planPromise).data.approved).toBe(true);
    state.isRunning = false;
  });
});
