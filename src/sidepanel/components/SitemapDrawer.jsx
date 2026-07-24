import { clearSitemap } from "../agent/sitemap.js";

function formatVisitedAt(value) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "short",
      timeStyle: "short"
    }).format(new Date(value));
  } catch {
    return value || "Unknown time";
  }
}

function displayTitle(entry) {
  if (entry.title) return entry.title;
  try {
    return new URL(entry.url).hostname;
  } catch {
    return entry.url;
  }
}

function openUrl(url) {
  if (typeof chrome !== "undefined" && chrome.tabs?.create) {
    chrome.tabs.create({ url }).catch(() => {});
  }
}

export default function SitemapDrawer({ snapshot }) {
  const entries = snapshot.sitemap || [];

  const onClear = () => {
    if (!entries.length || !window.confirm("Clear the agent sitemap?")) return;
    clearSitemap();
  };

  return (
    <section id="sitemapDrawer" className="settings sitemap-drawer">
      <div className="sitemap-heading">
        <div>
          <h2>Agent Sitemap</h2>
          <p className="sitemap-summary">
            {entries.length} {entries.length === 1 ? "URL" : "URLs"} visited by the agent
          </p>
        </div>
        <button id="clearSitemapBtn" className="btn small danger" type="button" disabled={!entries.length} onClick={onClear}>
          Clear
        </button>
      </div>

      {!entries.length ? (
        <div className="sitemap-empty">URLs the agent reads or navigates to will appear here.</div>
      ) : (
        <ol className="sitemap-list">
          {entries.map((entry) => (
            <li className="sitemap-entry" key={entry.url}>
              <div className="sitemap-entry-main">
                <button className="sitemap-title" type="button" title={`Open ${entry.url}`} onClick={() => openUrl(entry.url)}>
                  {displayTitle(entry)}
                </button>
                <div className="sitemap-url" title={entry.url}>{entry.url}</div>
              </div>
              <div className="sitemap-entry-meta">
                <span>Visited {formatVisitedAt(entry.lastVisitedAt)}</span>
                <span>{entry.visitCount} {entry.visitCount === 1 ? "visit" : "visits"}</span>
                {entry.tabId !== null && <span>Tab {entry.tabId}</span>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
