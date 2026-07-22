import { useRef, useEffect } from "react";
import Editor from "@monaco-editor/react";
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";

// Configure Monaco to use local bundled version (not CDN)
// This is required for Chrome extension CSP compliance
loader.config({ monaco });

export default function MonacoEditor({ language, value, onChange }) {
  const editorRef = useRef(null);

  function handleEditorDidMount(editor, monacoInstance) {
    editorRef.current = editor;

    // Ctrl+S / Cmd+S to save
    const m = monacoInstance || monaco;
    if (m && m.KeyMod && m.KeyCode) {
      editor.addCommand(
        m.KeyMod.CtrlCmd | m.KeyCode.KeyS,
        () => {
          window.dispatchEvent(new CustomEvent("editor-save"));
        }
      );
    }
  }

  function handleChange(newValue) {
    if (onChange) onChange(newValue || "");
  }

  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.focus();
    }
  }, [value]);

  return (
    <div className="monaco-wrapper">
      <Editor
        language={language}
        value={value}
        onChange={handleChange}
        onMount={handleEditorDidMount}
        theme="vs"
        options={{
          minimap: { enabled: true },
          fontSize: 14,
          lineNumbers: "on",
          scrollBeyondLastLine: false,
          wordWrap: "on",
          automaticLayout: true,
          bracketPairColorization: { enabled: true },
          autoClosingBrackets: "always",
          autoClosingQuotes: "always",
          formatOnPaste: true,
          formatOnType: true,
          padding: { top: 12 }
        }}
        loading={
          <div className="monaco-loading">Loading editor...</div>
        }
      />
    </div>
  );
}
