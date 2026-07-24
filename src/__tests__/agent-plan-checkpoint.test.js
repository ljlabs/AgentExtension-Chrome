import { describe, expect, it, beforeEach, vi } from "vitest";
import { state } from "../sidepanel/agent/store.js";
import { onSend, resolveInteraction } from "../sidepanel/agent/controller.js";
import { DEFAULT_SETTINGS } from "../sidepanel/agent/settings.js";
import { resetAgentConversationState } from "./helpers/mockAgentConversation.js";

function completion(message) {
  return new Response(JSON.stringify({ choices: [{ message }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("Plan Mode final-answer checkpoint", () => {
  beforeEach(() => {
    resetAgentConversationState({ planMode: true });
    state.settings = {
      ...DEFAULT_SETTINGS,
      model: "test-model",
      maxToolSteps: 6,
      requestTimeoutMs: 1000
    };
  });

  it("requires an approved plan before accepting a final answer", async () => {
    const responses = [
      { role: "assistant", content: "Premature analysis" },
      { role: "assistant", content: "", tool_calls: [{
        id: "plan-call",
        type: "function",
        function: {
          name: "submit_plan",
          arguments: JSON.stringify({
            title: "Detailed pension review",
            objective: "Compare current holdings with all available funds",
            steps: ["Inspect current holdings", "Review all available funds", "Compare and verify findings"],
            verification: ["Check source coverage"]
          })
        }
      }] },
      { role: "assistant", content: "Final answer after approval" }
    ];
    globalThis.fetch = vi.fn(async () => completion(responses.shift()));

    const sendPromise = onSend("Review my pension without making changes");
    await vi.waitFor(() => expect(state.chatItems.some((item) => item.uiType === "submit_plan" && item.pending)).toBe(true));
    const card = state.chatItems.find((item) => item.uiType === "submit_plan" && item.pending);
    resolveInteraction(card.id, { approved: true, feedback: "" });
    await sendPromise;

    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(state.currentPlan.approved).toBe(true);
    expect(state.chatItems.some((item) => item.kind === "assistant" && item.text === "Premature analysis")).toBe(true);
    expect(state.chatItems.some((item) => item.kind === "user" && item.text.includes("no plan has been approved yet"))).toBe(true);
    expect(state.chatItems.some((item) => item.kind === "assistant" && item.text === "Final answer after approval")).toBe(true);
  });
});
