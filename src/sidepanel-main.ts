import "./styles/sidepanel.css";
import { initializeSidePanel } from "./sidepanel-logic";

console.log("[SidePanel] Entry point loaded");

// Initialize the side panel when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeSidePanel);
} else {
  initializeSidePanel();
}