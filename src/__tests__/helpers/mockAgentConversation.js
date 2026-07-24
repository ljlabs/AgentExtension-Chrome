import { expect } from "vitest";
import { state } from "../../sidepanel/agent/store.js";
import {
  executeToolWithPermissions,
  resolveInteraction
} from "../../sidepanel/agent/controller.js";
import { DEFAULT_SETTINGS } from "../../sidepanel/agent/settings.js";

export function resetAgentConversationState(initialState = {}) {
  state.boundTabId = initialState.boundTabId ?? 1;
  state.boundTab = { id: state.boundTabId, url: "https://www.google.com", title: "Google" };
  state.messages = [];
  state.chatItems = [];
  state.isRunning = false;
  state.stopped = false;
  state.abortController = null;
  state.activePermission = null;
  state.planMode = initialState.planMode === true;
  state.safeMode = initialState.safeMode === true;
  state.currentPlan = null;
  state.currentApproval = null;
  state.planTurnAuthorized = false;
  state.autoApproveActions = false;
  state.settings = { ...DEFAULT_SETTINGS };
}

export function pendingApprovalCards() {
  return state.chatItems.filter((item) => (
    item.kind === "interactive" && item.uiType === "request_approval" && item.pending
  ));
}

function lastPendingInteraction() {
  return [...state.chatItems].reverse().find((item) => item.kind === "interactive" && item.pending);
}

export async function runMockConversation(fixture) {
  const results = [];
  for (const turn of fixture.turns) {
    if (!turn.tool) continue;

    const promise = executeToolWithPermissions(turn.tool, turn.args || {});
    const interaction = lastPendingInteraction();
    if (interaction) {
      expect(turn.userResponse, `${turn.tool} requires a fixture response`).toBeDefined();
      resolveInteraction(interaction.id, turn.userResponse);
    }

    const result = await promise;
    results.push({ turn, result });

    for (const [key, expected] of Object.entries(turn.expect || {})) {
      if (key === "pendingApprovalCards") {
        expect(pendingApprovalCards(), `${turn.tool} created an approval card`).toHaveLength(expected);
      } else if (key === "autoApproveActions") {
        expect(state.autoApproveActions).toBe(expected);
      } else if (key === "autoApproved") {
        expect(result.data.autoApproved).toBe(expected);
      } else {
        expect(result[key]).toBe(expected);
      }
    }
  }
  return results;
}
