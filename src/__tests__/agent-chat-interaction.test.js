import { describe, it, expect, beforeEach, vi } from "vitest";
import conversation from "./fixtures/auto-approve-conversation.json";
import { state } from "../sidepanel/agent/store.js";
import {
  resetAgentConversationState,
  runMockConversation,
  pendingApprovalCards
} from "./helpers/mockAgentConversation.js";

describe("fixture-driven agent conversations", () => {
  beforeEach(() => {
    resetAgentConversationState(conversation.initialState);
    chrome.runtime.sendMessage = vi.fn((message, callback) => {
      callback?.({ ok: true, data: { echoed: message.tool } });
    });
  });

  it("approves the plan once and auto-approves later tasks without manual approval", async () => {
    const results = await runMockConversation(conversation);

    expect(results).toHaveLength(4);
    expect(state.currentPlan.approved).toBe(true);
    expect(state.autoApproveActions).toBe(true);

    const autoApproval = results.at(-1).result;
    expect(autoApproval.ui).toEqual(expect.objectContaining({
      type: "request_approval",
      response: expect.objectContaining({ approved: true, autoApproved: true })
    }));
    expect(pendingApprovalCards()).toHaveLength(0);
  });
});
