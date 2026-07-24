import { useEffect, useMemo, useRef } from "react";
import { clearSitemap } from "../agent/sitemap.js";

const MAX_ROUTE_EVENTS = 60;
const NODE_HEIGHT = 84;
const NODE_GAP = 16;

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

function shorten(value, length) {
  const text = String(value || "");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function entryVisits(entry) {
  if (Array.isArray(entry.visits) && entry.visits.length) {
    return entry.visits.map((visit, index) => ({
      ...visit,
      url: entry.url,
      title: visit.title || entry.title,
      visitNumber: index + 1
    }));
  }

  return [{
    url: entry.url,
    title: entry.title,
    visitedAt: entry.lastVisitedAt,
    tabId: entry.tabId,
    source: "page tool",
    visitNumber: 1
  }];
}

function colorForUrl(url) {
  let hash = 0;
  for (let index = 0; index < url.length; index += 1) {
    hash = ((hash << 5) - hash + url.charCodeAt(index)) | 0;
  }
  const colors = ["#2554a6", "#3776c9", "#3b8f78", "#b05b32", "#7446a8", "#9a6b16"];
  return colors[Math.abs(hash) % colors.length];
}

function roundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

function layoutNodes(events, width) {
  const columns = width < 520 ? 2 : 3;
  const nodeWidth = Math.max(120, Math.floor((width - 32 - (columns - 1) * NODE_GAP) / columns));
  const rows = Math.max(1, Math.ceil(events.length / columns));

  return {
    height: rows * (NODE_HEIGHT + 24) + 34,
    nodes: events.map((event, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      return {
        event,
        index,
        x: 16 + column * (nodeWidth + NODE_GAP),
        y: 26 + row * (NODE_HEIGHT + 24),
        width: nodeWidth,
        height: NODE_HEIGHT
      };
    })
  };
}

function drawArrow(context, from, to) {
  const sameRow = from.y === to.y;
  const startX = sameRow ? from.x + from.width : from.x + from.width / 2;
  const startY = sameRow ? from.y + from.height / 2 : from.y + from.height;
  const endX = sameRow ? to.x : to.x + to.width / 2;
  const endY = sameRow ? to.y + to.height / 2 : to.y;

  context.strokeStyle = "#8c8c8c";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(startX, startY);
  if (sameRow) {
    context.lineTo(endX, endY);
  } else {
    const middleY = (startY + endY) / 2;
    context.lineTo(startX, middleY);
    context.lineTo(endX, middleY);
    context.lineTo(endX, endY);
  }
  context.stroke();

  const angle = Math.atan2(endY - startY, endX - startX);
  context.fillStyle = "#8c8c8c";
  context.beginPath();
  context.moveTo(endX, endY);
  context.lineTo(endX - 8 * Math.cos(angle - Math.PI / 6), endY - 8 * Math.sin(angle - Math.PI / 6));
  context.lineTo(endX - 8 * Math.cos(angle + Math.PI / 6), endY - 8 * Math.sin(angle + Math.PI / 6));
  context.closePath();
  context.fill();
}

function drawRoute(canvas, events) {
  let context;
  try {
    context = canvas.getContext("2d");
  } catch {
    return null;
  }
  if (!context) return null;

  const width = canvas.clientWidth || 680;
  const layout = layoutNodes(events, width);
  const pixelRatio = window.devicePixelRatio || 1;
  canvas.width = width * pixelRatio;
  canvas.height = layout.height * pixelRatio;
  canvas.style.height = `${layout.height}px`;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, width, layout.height);
  context.fillStyle = "#fffdf8";
  context.fillRect(0, 0, width, layout.height);

  context.fillStyle = "#111111";
  context.font = "900 11px system-ui, sans-serif";
  context.fillText("OLDEST", 16, 15);
  context.textAlign = "right";
  context.fillText("NEWEST", width - 16, 15);
  context.textAlign = "left";

  for (let index = 1; index < layout.nodes.length; index += 1) {
    drawArrow(context, layout.nodes[index - 1], layout.nodes[index]);
  }

  for (const node of layout.nodes) {
    const { event } = node;
    roundedRect(context, node.x, node.y, node.width, node.height, 8);
    context.fillStyle = colorForUrl(event.url);
    context.fill();
    context.strokeStyle = "#111111";
    context.lineWidth = 2;
    context.stroke();

    context.fillStyle = "#ffffff";
    context.font = "900 11px system-ui, sans-serif";
    context.fillText(`#${node.index + 1} ${shorten(event.title || event.url, 24)}`, node.x + 9, node.y + 20);
    context.font = "600 10px ui-monospace, monospace";
    context.fillText(shorten(event.url, 30), node.x + 9, node.y + 39);
    context.font = "700 10px system-ui, sans-serif";
    context.fillText(formatVisitedAt(event.visitedAt), node.x + 9, node.y + 61);
  }

  return layout;
}

function RouteCanvas({ events, onOpen }) {
  const canvasRef = useRef(null);
  const layoutRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const draw = () => {
      layoutRef.current = drawRoute(canvas, events);
    };
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [events]);

  const onClick = (event) => {
    const canvas = canvasRef.current;
    const layout = layoutRef.current;
    if (!canvas || !layout) return;

    const bounds = canvas.getBoundingClientRect();
    const scaleX = (bounds.width || canvas.clientWidth || 680) / (canvas.clientWidth || 680);
    const x = (event.clientX - bounds.left) / scaleX;
    const y = event.clientY - bounds.top;
    const node = layout.nodes.find((item) => x >= item.x && x <= item.x + item.width && y >= item.y && y <= item.y + item.height);
    if (node) onOpen(node.event.url);
  };

  return (
    <canvas
      ref={canvasRef}
      className="sitemap-canvas"
      role="img"
      aria-label="Chronological route of pages visited by the agent"
      onClick={onClick}
    />
  );
}

function openUrl(url) {
  if (typeof chrome !== "undefined" && chrome.tabs?.create) {
    Promise.resolve(chrome.tabs.create({ url })).catch(() => {});
  }
}

export default function SitemapDrawer({ snapshot }) {
  const entries = snapshot.sitemap || [];
  const allVisits = useMemo(
    () => entries.flatMap((entry) => entryVisits(entry)).sort((a, b) => new Date(a.visitedAt) - new Date(b.visitedAt)),
    [entries]
  );
  const routeVisits = allVisits.slice(-MAX_ROUTE_EVENTS);

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
            {allVisits.length} recorded {allVisits.length === 1 ? "visit" : "visits"} across {entries.length} {entries.length === 1 ? "page" : "pages"}
          </p>
        </div>
        <button id="clearSitemapBtn" className="btn small danger" type="button" disabled={!entries.length} onClick={onClear}>
          Clear
        </button>
      </div>

      {!entries.length ? (
        <div className="sitemap-empty">The agent’s page path will appear here as it reads and navigates the web.</div>
      ) : (
        <>
          <div className="sitemap-section-heading">
            <h3>Visit path</h3>
            <span>{routeVisits.length < allVisits.length ? `Showing the latest ${routeVisits.length}` : "Oldest → newest"}</span>
          </div>
          <RouteCanvas events={routeVisits} onOpen={openUrl} />

          <div className="sitemap-section-heading">
            <h3>Page history</h3>
            <span>Repeated visits keep their timestamps</span>
          </div>
          <div className="sitemap-history">
            {[...entries].sort((a, b) => new Date(b.lastVisitedAt) - new Date(a.lastVisitedAt)).map((entry) => (
              <details className="sitemap-history-entry" key={entry.url} open>
                <summary>
                  <span className="sitemap-history-title">{displayTitle(entry)}</span>
                  <span className="sitemap-history-count">{entry.visitCount}×</span>
                </summary>
                <button className="sitemap-url sitemap-url-button" type="button" title={`Open ${entry.url}`} onClick={() => openUrl(entry.url)}>
                  {entry.url}
                </button>
                <div className="sitemap-times">
                  {entryVisits(entry).slice().reverse().map((visit) => (
                    <div className="sitemap-time" key={`${entry.url}-${visit.visitedAt}-${visit.visitNumber}`}>
                      <span>{formatVisitedAt(visit.visitedAt)}</span>
                      {visit.tabId !== null && <span>Tab {visit.tabId}</span>}
                      <span>{visit.source}</span>
                    </div>
                  ))}
                </div>
              </details>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
