import { describe, it, expect } from "vitest";
import { buildSystemMessage, DEFAULT_SYSTEM_PROMPT } from "../sidepanel/agent/systemPrompt.js";

const baseSettings = { systemPrompt: "" };

describe("buildSystemMessage — default (no modes)", () => {
  it("is action-first and does not force clarify/plan/approve when modes are off", () => {
    const msg = buildSystemMessage(
      { planMode: false, safeMode: false, boundTab: { title: "T", url: "https://x.test" }, boundTabId: 1 },
      baseSettings
    );

    // No guardrail addendum when both modes are off.
    expect(msg.content).not.toContain("PLAN MODE IS ACTIVE");
    expect(msg.content).not.toContain("SAFE MODE IS ACTIVE");
    // Action-first framing.
    expect(msg.content).toContain("Bias toward ACTION");
    expect(msg.content).toContain("get_interactive_snapshot");
  });

  it("uses a custom system prompt when provided", () => {
    const msg = buildSystemMessage(
      { planMode: false, safeMode: false, boundTab: {}, boundTabId: 1 },
      { systemPrompt: "Custom instructions here." }
    );
    expect(msg.content).toContain("Custom instructions here.");
    expect(msg.content).not.toContain(DEFAULT_SYSTEM_PROMPT.slice(0, 40));
  });
});

describe("buildSystemMessage — plan mode", () => {
  it("appends the plan-mode addendum and lets the model continue after approval", () => {
    const msg = buildSystemMessage(
      { planMode: true, safeMode: false, boundTab: {}, boundTabId: 1 },
      baseSettings
    );
    expect(msg.content).toContain("PLAN MODE IS ACTIVE");
    expect(msg.content).toContain("submit_plan");
    expect(msg.content).toContain("do NOT need to ask again for each step");
  });
});

describe("buildSystemMessage — safe mode", () => {
  it("appends the safe-mode addendum listing blocked actions", () => {
    const msg = buildSystemMessage(
      { planMode: true, safeMode: true, boundTab: {}, boundTabId: 1 },
      baseSettings
    );
    expect(msg.content).toContain("SAFE MODE IS ACTIVE");
    expect(msg.content).toContain("request_approval");
    expect(msg.content).toContain("BLOCKED until you obtain approval");
    // Safe mode takes precedence over plan-mode-only text.
    expect(msg.content).not.toContain("PLAN MODE IS ACTIVE");
  });

  it("reports active modes in the context footer", () => {
    const msg = buildSystemMessage(
      { planMode: true, safeMode: true, boundTab: { title: "T", url: "u" }, boundTabId: 9 },
      baseSettings
    );
    expect(msg.content).toContain("Plan Mode=ON, Safe Mode=ON");
  });
});
