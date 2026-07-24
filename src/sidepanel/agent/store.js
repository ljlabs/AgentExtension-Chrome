import { useSyncExternalStore } from "react";

/**
 * Mutable agent state (ported from the sidepanel.js `state` object), exposed
 * to React through an immutable snapshot + subscribe, so the run loop can
 * mutate freely outside of render and components stay in sync via
 * useSyncExternalStore.
 */
export const state = {
  boundTabId: null,
  boundTab: null,
  activeTabId: null,
  activeTab: null,
  messages: [],
  chatItems: [],
  models: [],
  modelsLoading: false,
  isRunning: false,
  stopped: false,
  abortController: null,
  imagePermission: "prompt",
  sessionAllowedNetworkOrigins: new Set(),
  sessionDeniedNetworkOrigins: new Set(),
  visionFailed: false,
  activePermission: null,
  planMode: false,
  safeMode: false,
  currentPlan: null,
  currentApproval: null,
  planTurnAuthorized: false,
  planApproved: false,
  autoApproveActions: false,
  paused: false,
  pausedTabId: null,
  restoredPendingInteractions: [],
  runPromise: null,
  statusText: "",
  settings: null,
  sitemap: []
};

const listeners = new Set();
let snapshot = buildSnapshot();

function buildSnapshot() {
  return {
    boundTabId: state.boundTabId,
    boundTab: state.boundTab,
    activeTabId: state.activeTabId,
    activeTab: state.activeTab,
    chatItems: [...state.chatItems],
    models: [...state.models],
    modelsLoading: state.modelsLoading,
    isRunning: state.isRunning,
    activePermission: state.activePermission,
    planMode: state.planMode,
    safeMode: state.safeMode,
    currentPlan: state.currentPlan,
    planTurnAuthorized: state.planTurnAuthorized,
    planApproved: state.planApproved,
    autoApproveActions: state.autoApproveActions,
    paused: state.paused,
    pausedTabId: state.pausedTabId,
    statusText: state.statusText,
    settings: state.settings,
    sitemap: [...state.sitemap]
  };
}

/** Notify React that the mutable state changed. */
export function emit() {
  snapshot = buildSnapshot();
  for (const listener of listeners) listener();
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return snapshot;
}

export function useAgentStore() {
  return useSyncExternalStore(subscribe, getSnapshot);
}
