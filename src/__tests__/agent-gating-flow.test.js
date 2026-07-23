import { describe, it, expect, beforeEach, vi } from "vitest";
import { state } from "../sidepanel/agent/store.js";
import {
  executeToolWithPermissions,
  resolveInteraction,
  onStop,
  closePermission
} from "../sidepanel/agent/controller.js";
import { DEFAULT_SETTINGS } from "../sidepanel/agent/settings.js";

function resetState() {
  state.boundTabId = 1;
  state.boundTab = { id: 1, url: "https://example.com", title: "Test" };
  state.messages = [];
  state.chatItems = [];
  state.isRunning = false;
  state.stopped = false;
  state.abortController = null;
  state.imagePermission = "prompt";
  state.sessionAllowedNetworkOrigins = new Set();
  state.sessionDeniedNetworkOrigins = new Set();
  state.visionFailed = false;
  state.activePermission = null;
  state.planMode = false;
  state.safeMode = false;
  state.currentPlan = null;
  state.currentApproval = null;
  state.settings = { ...DEFAULT_SETTINGS };
}

function lastInteractiveItem() {
  return [...state.chatItems].reverse().find((item) => item.kind === "interactive");
}

beforeEach(() => {
  resetState();
  // Privileged tools go through chrome.runtime.sendMessage — succeed by default.
  chrome.runtime.sendMessage = vi.fn((message, cb) => {
    if (cb) cb({ ok: true, data: { echoed: message.tool } });
  });
});

describe("modes OFF — actions execute directly", () => {
  it("click is forwarded to the background without any gate", async () => {
    const result = await executeToolWithPermissions("click", { ref: "e1" });
    expect(result.ok).toBe(true);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "executeTool", tool: "click", tabId: 1 }),
      expect.any(Function)
    );
  });
});

describe("Plan Mode gating", () => {
  beforeEach(() => {
    state.planMode = true;
  });

  it("blocks click with an actionable plan_required error", async () => {
    const result = await executeToolWithPermissions("click", { ref: "e1" });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("plan_required");
    expect(result.error.instruction).toContain("submit_plan");
  });

  it("never gates read-only tools", async () => {
    for (const tool of ["get_text", "get_interactive_snapshot", "scroll_to"]) {
      const result = await executeToolWithPermissions(tool, {});
      expect(result.ok, `${tool} should not be gated`).toBe(true);
    }
  });

  it("submit_plan approval unblocks actions for the whole plan", async () => {
    // Model submits a plan → interactive card appears → user approves.
    const planPromise = executeToolWithPermissions("submit_plan", {
      title: "Do the thing",
      steps: ["click a", "type b"]
    });

    const card = lastInteractiveItem();
    expect(card.pending).toBe(true);
    resolveInteraction(card.id, { approved: true, feedback: "" });

    const planResult = await planPromise;
    expect(planResult.ok).toBe(true);
    expect(state.currentPlan.approved).toBe(true);

    // Multiple subsequent actions all pass without further approval.
    expect((await executeToolWithPermissions("click", { ref: "e1" })).ok).toBe(true);
    expect((await executeToolWithPermissions("type_text", { ref: "e2", text: "x" })).ok).toBe(true);
  });

  it("a rejected plan keeps actions blocked", async () => {
    const planPromise = executeToolWithPermissions("submit_plan", { title: "P", steps: ["s"] });
    resolveInteraction(lastInteractiveItem().id, { approved: false, feedback: "no" });
    await planPromise;

    const result = await executeToolWithPermissions("click", { ref: "e1" });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("plan_required");
  });
});

describe("Safe Mode gating", () => {
  beforeEach(() => {
    state.safeMode = true;
    state.planMode = true;
    // Pre-approve a plan so only the approval gate is exercised.
    state.currentPlan = { title: "P", steps: [], approved: true, feedback: "" };
  });

  it("blocks actions without fresh approval", async () => {
    const result = await executeToolWithPermissions("click", { ref: "e1" });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("approval_required");
    expect(result.error.instruction).toContain("request_approval");
  });

  it("approval is single-use: first action passes, second is blocked again", async () => {
    const approvalPromise = executeToolWithPermissions("request_approval", {
      actionType: "click",
      description: "Click the button"
    });
    resolveInteraction(lastInteractiveItem().id, { approved: true, decision: "approved" });
    await approvalPromise;
    expect(state.currentApproval.approved).toBe(true);

    expect((await executeToolWithPermissions("click", { ref: "e1" })).ok).toBe(true);

    const second = await executeToolWithPermissions("click", { ref: "e1" });
    expect(second.ok).toBe(false);
    expect(second.error.code).toBe("approval_required");
  });
});

describe("ask_user_question flow", () => {
  it("blocks until the card resolves, then returns the answer", async () => {
    const promise = executeToolWithPermissions("ask_user_question", {
      question: "Which one?",
      options: ["a", "b"]
    });

    const card = lastInteractiveItem();
    expect(card.uiType).toBe("ask_user_question");
    resolveInteraction(card.id, { answer: "a", selectedOptions: ["a"], freeText: "" });

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.data.answer).toBe("a");
    expect(result.ui.response.answer).toBe("a");
  });
});

describe("Stop cancels pending interactions", () => {
  it("onStop resolves an open card so the agent loop can unwind", async () => {
    const promise = executeToolWithPermissions("ask_user_question", { question: "Stuck?" });

    onStop();

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.data.cancelled).toBe(true);

    const card = lastInteractiveItem();
    expect(card.pending).toBe(false);
  });
});

describe("network permission for http_request", () => {
  it("auto-allows localhost by default", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200, headers: { "content-type": "text/plain" } })
    );

    const result = await executeToolWithPermissions("http_request", { url: "http://localhost:8000/x" });
    expect(result.ok).toBe(true);
    fetchSpy.mockRestore();
  });

  it("prompts for non-allowlisted origins and denial blocks the request", async () => {
    const promise = executeToolWithPermissions("http_request", { url: "https://api.evil.test/data" });

    // The permission modal state should now be active.
    expect(state.activePermission).toBeTruthy();
    expect(state.activePermission.kind).toBe("network");

    closePermission({ allow: false, scope: "session" });

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("Permission denied");
    // Denial persists for the session.
    expect(state.sessionDeniedNetworkOrigins.has("https://api.evil.test")).toBe(true);
  });

  it("rejects non-http protocols outright", async () => {
    const result = await executeToolWithPermissions("http_request", { url: "ftp://x.test/file" });
    expect(result.ok).toBe(false);
  });
});

describe("image permission for screenshot", () => {
  it("session denial short-circuits without a modal", async () => {
    state.imagePermission = "deny-session";
    const result = await executeToolWithPermissions("screenshot", { format: "jpeg" });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("Permission denied");
    expect(state.activePermission).toBeNull();
  });

  it("session allow short-circuits and forwards to background", async () => {
    state.imagePermission = "allow-session";
    const result = await executeToolWithPermissions("screenshot", { format: "jpeg" });
    expect(result.ok).toBe(true);
  });
});
