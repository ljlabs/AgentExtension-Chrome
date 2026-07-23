// --- Dev console logging ---
const DEBUG = true;

export function devLog(label, ...args) {
  if (DEBUG) console.log(`%c[Agent]%c ${label}`, "color:#888;font-weight:bold", "color:inherit", ...args);
}

export function devGroup(label) {
  if (DEBUG) console.group(`%c[Agent]%c ${label}`, "color:#888;font-weight:bold", "color:inherit");
}

export function devGroupEnd() {
  if (DEBUG) console.groupEnd();
}

export function devWarn(label, ...args) {
  if (DEBUG) console.warn(`%c[Agent]%c ${label}`, "color:#f80;font-weight:bold", "color:inherit", ...args);
}

export function truncate(str, maxLen = 100) {
  if (typeof str !== "string") return "";
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen)}...`;
}
