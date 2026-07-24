import { state, emit } from "./store.js";

const STORAGE_KEY = "agent_sitemap";
const MAX_ENTRIES = 500;
const MAX_VISITS_PER_URL = 100;

function normalizeVisit(visit, fallback = {}) {
  if (!visit || typeof visit !== "object") return null;
  return {
    visitedAt: visit.visitedAt || fallback.visitedAt || new Date().toISOString(),
    title: typeof visit.title === "string" ? visit.title : (fallback.title || ""),
    tabId: Number.isInteger(visit.tabId) ? visit.tabId : (fallback.tabId ?? null),
    source: typeof visit.source === "string" ? visit.source : "page tool"
  };
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object" || typeof entry.url !== "string") return null;
  try {
    const parsed = new URL(entry.url);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    parsed.hash = "";

    const fallback = {
      visitedAt: entry.lastVisitedAt || entry.firstVisitedAt,
      title: typeof entry.title === "string" ? entry.title : "",
      tabId: Number.isInteger(entry.tabId) ? entry.tabId : null
    };
    const visits = Array.isArray(entry.visits)
      ? entry.visits.map((visit) => normalizeVisit(visit, fallback)).filter(Boolean).slice(-MAX_VISITS_PER_URL)
      : [];

    return {
      url: parsed.href,
      title: fallback.title,
      tabId: fallback.tabId,
      firstVisitedAt: entry.firstVisitedAt || visits[0]?.visitedAt || new Date().toISOString(),
      lastVisitedAt: entry.lastVisitedAt || visits[visits.length - 1]?.visitedAt || new Date().toISOString(),
      visitCount: Math.max(1, Number.parseInt(entry.visitCount, 10) || visits.length || 1),
      visits
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
  const visit = {
    visitedAt: now,
    title: metadata.title || "",
    tabId: Number.isInteger(metadata.tabId) ? metadata.tabId : null,
    source: metadata.source || "page tool"
  };
  const existing = state.sitemap.find((entry) => entry.url === normalized);
  const entry = existing
    ? {
        ...existing,
        title: visit.title || existing.title,
        tabId: visit.tabId ?? existing.tabId,
        lastVisitedAt: now,
        visitCount: existing.visitCount + 1,
        visits: [...(existing.visits || []), visit].slice(-MAX_VISITS_PER_URL)
      }
    : {
        url: normalized,
        title: visit.title,
        tabId: visit.tabId,
        firstVisitedAt: now,
        lastVisitedAt: now,
        visitCount: 1,
        visits: [visit]
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
