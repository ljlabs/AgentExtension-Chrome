import { useState, useEffect, useCallback } from "react";

function sendMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, error: "No response from background." });
      });
    } catch (err) {
      resolve({ ok: false, error: err.message || String(err) });
    }
  });
}

export function useStorage(toolName) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadList = useCallback(async () => {
    setLoading(true);
    const result = await sendMessage({
      type: "executeTool",
      tool: toolName,
      args: { action: "list" }
    });

    if (result.ok) {
      const data = result.data;
      // The key matches the tool name (memories, skills, rules)
      setItems(data[toolName] || []);
    }

    setLoading(false);
  }, [toolName]);

  useEffect(() => {
    loadList();

    const storageKey = `agent_${toolName}`;
    const handleStorageChange = (changes, areaName) => {
      if (areaName === "local" && changes[storageKey]) {
        loadList();
      }
    };

    if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener(handleStorageChange);
      return () => {
        chrome.storage.onChanged.removeListener(handleStorageChange);
      };
    }
  }, [loadList, toolName]);

  const readItem = useCallback(async (id) => {
    const result = await sendMessage({
      type: "executeTool",
      tool: toolName,
      args: { action: "read", id }
    });
    return result.ok ? result.data : null;
  }, [toolName]);

  const writeItem = useCallback(async (args) => {
    const result = await sendMessage({
      type: "executeTool",
      tool: toolName,
      args: { action: "write", ...args }
    });
    if (result.ok) await loadList();
    return result;
  }, [toolName, loadList]);

  const deleteItem = useCallback(async (id) => {
    const result = await sendMessage({
      type: "executeTool",
      tool: toolName,
      args: { action: "delete", id }
    });
    if (result.ok) await loadList();
    return result;
  }, [toolName, loadList]);

  return { items, loading, loadList, readItem, writeItem, deleteItem };
}
