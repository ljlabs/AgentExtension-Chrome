export default function Sidebar({ items, selectedId, onSelect, onNew, label }) {
  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">{label}</span>
        <button className="btn small primary" onClick={onNew}>
          + New
        </button>
      </div>
      <div className="sidebar-list">
        {items.length === 0 && (
          <div className="sidebar-empty">No {label.toLowerCase()} yet</div>
        )}
        {items.map((item) => (
          <div
            key={item.id}
            className={`sidebar-item ${selectedId === item.id ? "active" : ""}`}
            onClick={() => onSelect(item.id)}
          >
            <div className="sidebar-item-title">
              {item.title || item.frontmatter?.name || "Untitled"}
            </div>
            {item.updated && (
              <div className="sidebar-item-date">
                {new Date(item.updated).toLocaleDateString()}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
