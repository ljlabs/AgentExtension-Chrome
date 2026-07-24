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
  state.planTurnAuthorized = false;
  state.autoApproveActions = false;
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
    for (const tool of ["get_text", "get_interactive_snapshot", "get_changes_since_last_interactive_snapshot", "scroll_to"]) {
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

  it("requires an explicit continuation on a later conversation turn", async () => {
    state.currentPlan = {
      planId: "plan_existing",
      title: "Review pension",
      steps: ["Read factsheets"],
      approved: true,
      feedback: ""
    };
    state.planTurnAuthorized = false;

    const blocked = await executeToolWithPermissions("click", { ref: "e1" });
    expect(blocked.ok).toBe(false);
    expect(blocked.error.code).toBe("plan_required");
    expect(blocked.error.instruction).toContain("continue_plan");

    const continued = await executeToolWithPermissions("continue_plan", { planId: "plan_existing" });
    expect(continued.ok).toBe(true);
    expect(state.planTurnAuthorized).toBe(true);
    expect((await executeToolWithPermissions("click", { ref: "e1" })).ok).toBe(true);
  });

  it("rejects resubmitting an equivalent approved plan", async () => {
    state.currentPlan = {
      planId: "plan_active",
      title: "Review pension",
      objective: "Review current funds",
      steps: ["Read factsheets", "Compare charges", "Summarize findings"],
      verification: ["Check sources"],
      approved: true,
      feedback: ""
    };

    const result = await executeToolWithPermissions("submit_plan", {
      title: "Review pension",
      objective: "Review current funds",
      steps: ["Read factsheets", "Compare charges", "Summarize findings"],
      verification: ["Check sources"]
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("plan_already_active");
    expect(result.error.instruction).toContain("continue_plan");
  });

  it("allows a changed task to replace an approved plan after fresh approval", async () => {
    state.currentPlan = {
      planId: "plan_old",
      title: "Review pension",
      steps: ["Read current fund factsheets"],
      approved: true,
      feedback: ""
    };
    state.planTurnAuthorized = false;

    const planPromise = executeToolWithPermissions("submit_plan", {
      title: "Review savings account",
      objective: "Compare savings products",
      steps: ["Read savings product details", "Compare charges", "Summarize differences"],
      verification: ["Check all product charges"]
    });
    const card = lastInteractiveItem();
    resolveInteraction(card.id, { approved: true, feedback: "" });

    const result = await planPromise;
    expect(result.ok).toBe(true);
    expect(state.currentPlan.planId).not.toBe("plan_old");
    expect(state.currentPlan.title).toBe("Review savings account");
    expect(state.planTurnAuthorized).toBe(true);
  });

  it("requires rejected-plan feedback mapping and material changes", async () => {
    const firstPlan = executeToolWithPermissions("submit_plan", {
      title: "Review pension",
      objective: "Review current funds",
      steps: ["Read the three current fund factsheets", "Compare charges", "Summarize findings"],
      verification: ["Check each current fund"]
    });
    resolveInteraction(lastInteractiveItem().id, {
      approved: false,
      feedback: "Review factsheets for all available funds, not just the current three."
    });
    await firstPlan;
    const rejectedPlanId = state.currentPlan.planId;

    const unchanged = await executeToolWithPermissions("submit_plan", {
      title: "Review pension",
      objective: "Review current funds",
      steps: ["Read the three current fund factsheets", "Compare charges", "Summarize findings"],
      verification: ["Check each current fund"],
      revisionOfPlanId: rejectedPlanId,
      changesFromPrevious: ["Added a note"],
      feedbackAddressed: ["Will consider the feedback"]
    });
    expect(unchanged.ok).toBe(false);
    expect(unchanged.error.code).toBe("plan_revision_required");

    const revised = executeToolWithPermissions("submit_plan", {
      title: "Review the complete pension fund range",
      objective: "Compare current holdings with all available alternatives",
      steps: ["Read factsheets for every available fund category", "Compare current and alternative charges", "Summarize findings"],
      verification: ["Check current and alternative fund coverage"],
      revisionOfPlanId: rejectedPlanId,
      changesFromPrevious: ["Expanded factsheet review beyond the three current funds"],
      feedbackAddressed: ["Review factsheets for all available funds, not only current holdings"]
    });
    resolveInteraction(lastInteractiveItem().id, { approved: true, feedback: "" });
    expect((await revised).ok).toBe(true);
  });

  it("allows a materially different unrelated task after a rejection", async () => {
    const rejected = executeToolWithPermissions("submit_plan", {
      title: "Review pension",
      objective: "Review pension funds",
      steps: ["Read pension factsheets", "Compare charges", "Summarize findings"],
      verification: ["Check pension sources"]
    });
    resolveInteraction(lastInteractiveItem().id, { approved: false, feedback: "Include all pension alternatives." });
    await rejected;

    const unrelated = executeToolWithPermissions("submit_plan", {
      title: "Review mortgage rates",
      objective: "Compare mortgage products",
      steps: ["Read mortgage product details", "Compare rates", "Summarize findings"],
      verification: ["Check mortgage sources"]
    });
    resolveInteraction(lastInteractiveItem().id, { approved: true, feedback: "" });

    expect((await unrelated).ok).toBe(true);
    expect(state.currentPlan.title).toBe("Review mortgage rates");
  });
});


describe("Safe Mode gating", () => {
  beforeEach(() => {
    state.safeMode = true;
    state.planMode = true;
    // Pre-approve a plan so only the approval gate is exercised.
    state.currentPlan = { title: "P", steps: [], approved: true, feedback: "" };
    state.planTurnAuthorized = true;
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

describe("wait_for_user_input flow", () => {
  it("waits for Continue and refreshes page context afterward", async () => {
    const promise = executeToolWithPermissions("wait_for_user_input", {
      message: "Enter the password or upload the file in the browser, then continue."
    });

    const card = lastInteractiveItem();
    expect(card.uiType).toBe("wait_for_user_input");
    expect(card.pending).toBe(true);

    resolveInteraction(card.id, { continued: true });

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.data.continued).toBe(true);
    expect(result.data.changes.echoed).toBe("get_changes_since_last_interactive_snapshot");
    expect(result.ui.response.changes).toEqual(result.data.changes);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "get_changes_since_last_interactive_snapshot",
        tabId: 1
      }),
      expect.any(Function)
    );
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

  it("explicit Stop cancels active plan authorization", () => {
    state.currentPlan = { planId: "plan_stop", title: "Task", approved: true };
    state.planTurnAuthorized = true;

    onStop();

    expect(state.currentPlan).toBeNull();
    expect(state.planTurnAuthorized).toBe(false);
    expect(state.autoApproveActions).toBe(false);
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
