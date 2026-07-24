import { state, emit } from "./store.js";

const STORAGE_KEY = "agent_sitemap";
const MAX_ENTRIES = 500;

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object" || typeof entry.url !== "string") return null;
  try {
    const parsed = new URL(entry.url);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    parsed.hash = "";
    return {
      url: parsed.href,
      title: typeof entry.title === "string" ? entry.title : "",
      tabId: Number.isInteger(entry.tabId) ? entry.tabId : null,
      firstVisitedAt: entry.firstVisitedAt || entry.lastVisitedAt || new Date().toISOString(),
      lastVisitedAt: entry.lastVisitedAt || entry.firstVisitedAt || new Date().toISOString(),
      visitCount: Math.max(1, Number.parseInt(entry.visitCount, 10) || 1)
    };
  } catch {
    return null;
  }
}

export async function loadSitemap() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    state.sitemap = Array.isArray(stored[STORAGE_KEY])
      ? stored[STORAGE_KEY].map(normalizeEntry).filter(Boolean).slice(0, MAX_ENTRIES)
      : [];
    emit();
  } catch {
    state.sitemap = [];
    emit();
  }
}

export async function recordVisitedUrl(url, metadata = {}) {
  let normalized;
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return;
    parsed.hash = "";
    normalized = parsed.href;
  } catch {
    return;
  }

  const now = new Date().toISOString();
  const existing = state.sitemap.find((entry) => entry.url === normalized);
  const entry = existing
    ? {
        ...existing,
        title: metadata.title || existing.title,
        tabId: Number.isInteger(metadata.tabId) ? metadata.tabId : existing.tabId,
        lastVisitedAt: now,
        visitCount: existing.visitCount + 1
      }
    : {
        url: normalized,
        title: metadata.title || "",
        tabId: Number.isInteger(metadata.tabId) ? metadata.tabId : null,
        firstVisitedAt: now,
        lastVisitedAt: now,
        visitCount: 1
      };

  state.sitemap = [entry, ...state.sitemap.filter((item) => item.url !== normalized)].slice(0, MAX_ENTRIES);
  emit();

  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: state.sitemap });
  } catch {
    // Sitemap display remains useful if storage is temporarily unavailable.
  }
}

export async function clearSitemap() {
  state.sitemap = [];
  emit();
  try {
    await chrome.storage.local.remove(STORAGE_KEY);
  } catch {
    // Ignore storage errors; the in-memory list has still been cleared.
  }
}
