// scroll_to is intentionally NOT gated: it cannot modify page data, and the
// system prompt tells the model scrolling is always allowed for inspection.
export const PLAN_GATED_TOOLS = new Set([
  "click",
  "type_text",
  "set_value",
  "press_key",
  "write_browser_storage"
]);

export const SAFE_MODE_APPROVAL_TOOLS = new Set([
  "click",
  "type_text",
  "set_value",
  "press_key",
  "write_browser_storage"
]);

export function isExplorationClick(name, args, { planMode, safeMode, currentPlan }) {
  return name === "click" &&
    args?.exploration === true &&
    planMode === true &&
    safeMode !== true &&
    currentPlan?.approved !== true;
}

export function requiresApprovedPlan(name, { planMode, safeMode }) {
  return (planMode || safeMode) && PLAN_GATED_TOOLS.has(name);
}

export function requiresFreshApproval(name, { safeMode, autoApproveActions }) {
  return safeMode && !autoApproveActions && SAFE_MODE_APPROVAL_TOOLS.has(name);
}
