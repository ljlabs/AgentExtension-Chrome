import { useEffect, useState } from "react";
import { useAgentStore } from "./agent/store.js";
import {
  initController,
  handleTabActivated,
  handleBoundTabUpdated,
  handleTabRemoved
} from "./agent/controller.js";
import Header from "./components/Header.jsx";
import SettingsDrawer from "./components/SettingsDrawer.jsx";
import ChatLog from "./components/ChatLog.jsx";
import StatusBar from "./components/StatusBar.jsx";
import Composer from "./components/Composer.jsx";
import PermissionModal from "./components/PermissionModal.jsx";

export default function SidePanelApp() {
  const snapshot = useAgentStore();
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.tabs) return undefined;

    initController();

    const onUpdated = (tabId, changeInfo) => handleBoundTabUpdated(tabId, changeInfo);
    const onRemoved = (tabId) => handleTabRemoved(tabId);
    const onActivated = (activeInfo) => {
      handleTabActivated(activeInfo.tabId).catch(() => {});
    };
    // When focus moves between windows, follow the active tab of the newly
    // focused window.
    const onFocusChanged = (windowId) => {
      if (windowId === chrome.windows.WINDOW_ID_NONE) return;
      chrome.tabs.query({ active: true, windowId }).then((tabs) => {
        if (tabs[0] && tabs[0].id) {
          handleTabActivated(tabs[0].id).catch(() => {});
        }
      }).catch(() => {});
    };
    const onMessage = (message) => {
      if (message && message.type === "tabActivated") {
        handleTabActivated(message.tabId, message.url || "", message.title || "").catch(() => {});
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.windows.onFocusChanged.addListener(onFocusChanged);
    chrome.runtime.onMessage.addListener(onMessage);

    return () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.windows.onFocusChanged.removeListener(onFocusChanged);
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, []);

  if (!snapshot.settings) {
    return null;
  }

  return (
    <>
      <Header
        snapshot={snapshot}
        onToggleSettings={() => setSettingsOpen((open) => !open)}
      />
      {settingsOpen && <SettingsDrawer snapshot={snapshot} />}
      <ChatLog items={snapshot.chatItems} />
      <StatusBar text={snapshot.statusText} />
      <Composer isRunning={snapshot.isRunning} />
      <PermissionModal permission={snapshot.activePermission} />
    </>
  );
}
