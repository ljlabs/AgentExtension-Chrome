import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import conversation from "./fixtures/error-history-conversation.json";
import { state } from "../sidepanel/agent/store.js";
import { addError, onSend } from "../sidepanel/agent/controller.js";
import { DEFAULT_SETTINGS } from "../sidepanel/agent/settings.js";
import { resetAgentConversationState } from "./helpers/mockAgentConversation.js";

describe("fixture-driven error history", () => {
  beforeEach(() => {
    resetAgentConversationState({ boundTabId: 1 });
    state.settings = {
      ...DEFAULT_SETTINGS,
      model: "test-model",
      maxToolSteps: 1,
      requestTimeoutMs: 1000
    };
    state.messages = conversation.history.map((message) => ({ ...message }));
    for (const message of conversation.history.filter(({ role }) => role === "error")) {
      addError(message.content, { persist: false });
    }

    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify(conversation.llmResponse),
      { status: 200, headers: { "content-type": "application/json" } }
    ));
  });

  afterEach(() => vi.restoreAllMocks());

  it("keeps errors visible but excludes them from the next LLM request", async () => {
    await onSend(conversation.nextUserMessage);

    const requestBody = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(requestBody.messages.map((message) => message.role)).toEqual(
      conversation.expectedModelRoles
    );
    expect(requestBody.messages.some((message) => message.role === "error")).toBe(false);

    const visibleErrors = state.chatItems.filter((item) => item.kind === "error");
    expect(visibleErrors).toHaveLength(conversation.expectedVisibleErrorCount);
    expect(visibleErrors.map((item) => item.text)).toEqual(
      conversation.history.filter(({ role }) => role === "error").map(({ content }) => content)
    );
  });
});
