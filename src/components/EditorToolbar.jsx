import { useEffect } from "react";

export default function EditorToolbar({ title, dirty, onSave, onDelete }) {
  useEffect(() => {
    const handleSaveShortcut = () => onSave();
    window.addEventListener("editor-save", handleSaveShortcut);
    return () => window.removeEventListener("editor-save", handleSaveShortcut);
  }, [onSave]);

  return (
    <div className="editor-toolbar">
      <span className="editor-item-title">
        {title}
        {dirty && <span className="dirty-indicator"> (modified)</span>}
      </span>
      <div className="editor-toolbar-actions">
        <button className="btn small danger" onClick={onDelete}>
          Delete
        </button>
        <button className="btn small primary" onClick={onSave} disabled={!dirty}>
          Save
        </button>
      </div>
    </div>
  );
}
