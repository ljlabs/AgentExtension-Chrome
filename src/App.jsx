import { useState, useCallback } from "react";
import { useStorage } from "./hooks/useStorage";
import Sidebar from "./components/Sidebar";
import MonacoEditor from "./components/MonacoEditor";
import SplitPane from "./components/SplitPane";
import EditorToolbar from "./components/EditorToolbar";
import EmptyState from "./components/EmptyState";

const TABS = [
  { id: "memories", label: "Memories", storageKey: "memories" },
  { id: "skills", label: "Skills", storageKey: "skills" },
  { id: "rules", label: "Rules", storageKey: "rules" }
];

function getLanguage(tabId) {
  return tabId === "skills" ? "yaml" : "markdown";
}

function getItemContent(tabId, item) {
  if (!item) return "";
  if (tabId === "skills") return item.fullContent || "";
  return item.content || "";
}

function parseItemForWrite(tabId, content, existingItem) {
  if (tabId === "skills") {
    const parsed = parseFrontMatter(content);
    return {
      name: parsed.meta.name || existingItem?.frontmatter?.name || "untitled",
      description: parsed.meta.description || existingItem?.frontmatter?.description || "",
      tags: parsed.meta.tags || existingItem?.frontmatter?.tags || [],
      content: parsed.body
    };
  }
  return {
    title: existingItem?.title || "Untitled",
    content
  };
}

function parseFrontMatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: text };

  const meta = {};
  const lines = match[1].split("\n");
  for (const line of lines) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) {
      let val = kv[2].trim();
      if (val.startsWith("[") && val.endsWith("]")) {
        val = val.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
      }
      meta[kv[1]] = val;
    }
  }

  return { meta, body: match[2] };
}

export default function App() {
  const [activeTab, setActiveTab] = useState("memories");
  const [selectedId, setSelectedId] = useState(null);
  const [selectedItem, setSelectedItem] = useState(null);
  const [editorContent, setEditorContent] = useState("");
  const [dirty, setDirty] = useState(false);

  const storage = useStorage(activeTab);

  const handleTabChange = useCallback((tabId) => {
    setActiveTab(tabId);
    setSelectedId(null);
    setSelectedItem(null);
    setEditorContent("");
    setDirty(false);
  }, []);

  const handleSelectItem = useCallback(async (id) => {
    const item = await storage.readItem(id);
    if (item) {
      setSelectedId(id);
      setSelectedItem(item);
      setEditorContent(getItemContent(activeTab, item));
      setDirty(false);
    }
  }, [activeTab, storage]);

  const handleContentChange = useCallback((value) => {
    setEditorContent(value);
    setDirty(true);
  }, []);

  const handleSave = useCallback(async () => {
    if (!selectedId) return;

    const writeArgs = parseItemForWrite(activeTab, editorContent, selectedItem);
    const result = await storage.writeItem({ id: selectedId, ...writeArgs });

    if (result.ok) {
      setDirty(false);
      // Reload the item to get updated timestamps
      const updated = await storage.readItem(selectedId);
      if (updated) setSelectedItem(updated);
    }

    return result;
  }, [activeTab, selectedId, editorContent, selectedItem, storage]);

  const handleDelete = useCallback(async () => {
    if (!selectedId) return;

    const result = await storage.deleteItem(selectedId);
    if (result.ok) {
      setSelectedId(null);
      setSelectedItem(null);
      setEditorContent("");
      setDirty(false);
    }
    return result;
  }, [selectedId, storage]);

  const handleNew = useCallback(async () => {
    const title = prompt(`Enter title for new ${activeTab.slice(0, -1)}:`);
    if (!title) return;

    const result = await storage.writeItem({ title, content: "" });
    if (result.ok) {
      await handleSelectItem(result.data.id);
    }
    return result;
  }, [activeTab, storage, handleSelectItem]);

  const tab = TABS.find((t) => t.id === activeTab);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">Agent Editor</div>
        <nav className="tab-bar">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`tab ${activeTab === t.id ? "active" : ""}`}
              onClick={() => handleTabChange(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <SplitPane
        left={
          <Sidebar
            items={storage.items}
            selectedId={selectedId}
            onSelect={handleSelectItem}
            onNew={handleNew}
            label={tab?.label || ""}
          />
        }
        right={
          selectedId ? (
            <div className="editor-area">
              <EditorToolbar
                title={selectedItem?.title || selectedItem?.frontmatter?.name || "Untitled"}
                dirty={dirty}
                onSave={handleSave}
                onDelete={handleDelete}
              />
              <MonacoEditor
                language={getLanguage(activeTab)}
                value={editorContent}
                onChange={handleContentChange}
              />
            </div>
          ) : (
            <EmptyState label={tab?.label || ""} />
          )
        }
      />
    </div>
  );
}
