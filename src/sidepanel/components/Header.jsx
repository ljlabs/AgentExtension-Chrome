import { useEffect, useRef, useState } from "react";
import {
  togglePlanMode,
  toggleSafeMode,
  openEditor,
  onRebind,
  onClear
} from "../agent/controller.js";
import { truncate } from "../agent/util.js";

function statusPillProps(boundTabId, boundTab) {
  if (!boundTabId || !boundTab) {
    return { text: "NO TAB", title: "No tab bound", className: "status-pill status-pill--none" };
  }

  const url = boundTab.url || "";
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = "unknown";
  }

  return {
    text: hostname || "unknown",
    title: `${boundTab.title || "Untitled"}\n${url}\nTab #${boundTab.id}`,
    className: "status-pill status-pill--active"
  };
}

function tabInfoLabel(tab, prefix, maxLen) {
  if (!tab) return `${prefix}: No tab`;
  const label = tab.title || tab.url || `Tab ${tab.id}`;
  return `${prefix}: ${truncate(label, maxLen)} (#${tab.id})`;
}

export default function Header({ snapshot, onToggleSettings }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return undefined;

    const onDocClick = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setMenuOpen(false);
      }
    };

    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [menuOpen]);

  const pill = statusPillProps(snapshot.boundTabId, snapshot.boundTab);
  const closeMenuAnd = (action) => () => {
    setMenuOpen(false);
    action();
  };

  return (
    <header className="app-header">
      <div className="brand">🤖 Local Agent</div>

      <div className="header-center">
        <div id="statusPill" className={pill.className} title={pill.title}>{pill.text}</div>
        <div
          className="tab-info active-tab-info"
          id="activeTabInfo"
          title={snapshot.activeTab ? `${snapshot.activeTab.title || "Untitled"}\n${snapshot.activeTab.url || ""}\nTab ID: ${snapshot.activeTab.id}` : "No active tab"}
        >
          {tabInfoLabel(snapshot.activeTab, "Active", 52)}
        </div>
        <div
          className="tab-info"
          id="tabInfo"
          title={snapshot.boundTab ? `${snapshot.boundTab.url || ""}\nTab ID: ${snapshot.boundTab.id}` : "Bound tab"}
        >
          {snapshot.boundTabId && !snapshot.boundTab
            ? "Bound: Tab closed"
            : tabInfoLabel(snapshot.boundTab, "Bound", 60)}
        </div>
      </div>

      <div className="header-actions" ref={menuRef}>
        <button
          id="menuToggleBtn"
          className="btn small menu-toggle"
          type="button"
          aria-label="Menu"
          title="Menu"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((open) => !open);
          }}
        >
          ☰
        </button>
        {menuOpen && (
          <div id="menuDropdown" className="menu-dropdown">
            <button
              id="planModeBtn"
              className={`btn small menu-item${snapshot.planMode ? " plan-active" : ""}`}
              type="button"
              title="Toggle Plan Mode: agent must submit a plan for tasks with 3+ steps"
              disabled={snapshot.safeMode}
              onClick={closeMenuAnd(togglePlanMode)}
            >
              Plan: {snapshot.planMode ? "ON" : "OFF"}
            </button>
            <button
              id="safeModeBtn"
              className={`btn small menu-item${snapshot.safeMode ? " safe-active" : ""}`}
              type="button"
              title="Toggle Safe Mode: enforces ALL guardrails — clarify, research, plan, and approve every action"
              onClick={closeMenuAnd(toggleSafeMode)}
            >
              Safe: {snapshot.safeMode ? "ON" : "OFF"}
            </button>
            <button id="editBtn" className="btn small menu-item" type="button" onClick={closeMenuAnd(openEditor)}>
              Edit
            </button>
            <button id="rebindBtn" className="btn small menu-item" type="button" onClick={closeMenuAnd(onRebind)}>
              Rebind
            </button>
            <button id="settingsBtn" className="btn small menu-item" type="button" onClick={closeMenuAnd(onToggleSettings)}>
              Settings
            </button>
            <button id="clearBtn" className="btn small danger menu-item" type="button" onClick={closeMenuAnd(onClear)}>
              Clear
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
