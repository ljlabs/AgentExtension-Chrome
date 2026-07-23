import { useRef, useState } from "react";
import {
  saveSettings,
  setModel,
  loadModels,
  exportRiskPatterns,
  importRiskPatterns
} from "../agent/controller.js";

export default function SettingsDrawer({ snapshot }) {
  const settings = snapshot.settings;
  const [form, setForm] = useState(() => ({
    baseUrl: settings.baseUrl,
    modelsPath: settings.modelsPath,
    chatPath: settings.chatPath,
    apiKey: settings.apiKey,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    maxToolSteps: settings.maxToolSteps,
    maxToolResultChars: settings.maxToolResultChars,
    requestTimeoutMs: settings.requestTimeoutMs,
    toolTimeoutMs: settings.toolTimeoutMs,
    modelSupportsVision: settings.modelSupportsVision,
    autoAllowLocalhostNetwork: settings.autoAllowLocalhostNetwork,
    networkAllowlist: (settings.networkAllowlist || []).join("\n"),
    systemPrompt: settings.systemPrompt
  }));
  const fileInputRef = useRef(null);

  const update = (key) => (event) => {
    const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  // Include the persisted model even if the models fetch hasn't returned it.
  const modelOptions = new Set(snapshot.models);
  if (settings.model) modelOptions.add(settings.model);

  const onImportFile = (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      importRiskPatterns(e.target.result);
    };
    reader.readAsText(file);
    event.target.value = "";
  };

  const onSave = () => {
    saveSettings({
      baseUrl: form.baseUrl.trim(),
      modelsPath: form.modelsPath.trim(),
      chatPath: form.chatPath.trim(),
      apiKey: form.apiKey.trim(),
      model: settings.model,
      temperature: form.temperature,
      maxTokens: form.maxTokens,
      maxToolSteps: form.maxToolSteps,
      maxToolResultChars: form.maxToolResultChars,
      requestTimeoutMs: form.requestTimeoutMs,
      toolTimeoutMs: form.toolTimeoutMs,
      modelSupportsVision: form.modelSupportsVision,
      autoAllowLocalhostNetwork: form.autoAllowLocalhostNetwork,
      networkAllowlist: form.networkAllowlist,
      systemPrompt: form.systemPrompt
    });
  };

  return (
    <section id="settingsDrawer" className="settings">
      <h2>Settings</h2>

      <label>
        Base URL
        <input id="baseUrlInput" type="text" placeholder="http://localhost:8000/v1" value={form.baseUrl} onChange={update("baseUrl")} />
      </label>

      <label>
        Models path
        <input id="modelsPathInput" type="text" placeholder="/models" value={form.modelsPath} onChange={update("modelsPath")} />
      </label>

      <label>
        Chat path
        <input id="chatPathInput" type="text" placeholder="/chat/completions" value={form.chatPath} onChange={update("chatPath")} />
      </label>

      <label>
        API key, optional
        <input id="apiKeyInput" type="password" placeholder="Bearer token if required" value={form.apiKey} onChange={update("apiKey")} />
      </label>

      <label>
        Model
        <select
          id="modelSelect"
          value={settings.model || ""}
          onChange={(event) => setModel(event.target.value)}
        >
          {modelOptions.size === 0 && <option value="">No models found</option>}
          {[...modelOptions].map((model) => (
            <option key={model} value={model}>{model}</option>
          ))}
        </select>
      </label>

      <div className="row">
        <button id="refreshModelsBtn" className="btn" type="button" disabled={snapshot.modelsLoading} onClick={loadModels}>
          Refresh models
        </button>
      </div>

      <div className="grid">
        <label>
          Temperature
          <input id="temperatureInput" type="number" step="0.1" min="0" max="2" value={form.temperature} onChange={update("temperature")} />
        </label>

        <label>
          Max tokens
          <input id="maxTokensInput" type="number" min="1" max="32768" value={form.maxTokens} onChange={update("maxTokens")} />
        </label>

        <label>
          Max tool steps
          <input id="maxToolStepsInput" type="number" min="1" max="50" value={form.maxToolSteps} onChange={update("maxToolSteps")} />
        </label>

        <label>
          Max tool result chars
          <input id="maxToolResultCharsInput" type="number" min="1000" max="1000000" value={form.maxToolResultChars} onChange={update("maxToolResultChars")} />
        </label>

        <label>
          LLM timeout ms
          <input id="requestTimeoutInput" type="number" min="5000" max="600000" value={form.requestTimeoutMs} onChange={update("requestTimeoutMs")} />
        </label>

        <label>
          Tool timeout ms
          <input id="toolTimeoutInput" type="number" min="5000" max="300000" value={form.toolTimeoutMs} onChange={update("toolTimeoutMs")} />
        </label>
      </div>

      <div className="toggles">
        <label className="toggle">
          <input id="modelVisionToggle" type="checkbox" checked={form.modelSupportsVision} onChange={update("modelSupportsVision")} />
          Model supports vision/images
        </label>

        <label className="toggle">
          <input id="autoLocalhostToggle" type="checkbox" checked={form.autoAllowLocalhostNetwork} onChange={update("autoAllowLocalhostNetwork")} />
          Auto-allow localhost network requests
        </label>
      </div>

      <label>
        Network allowlist, one origin pattern per line
        <textarea
          id="networkAllowlistInput"
          rows={4}
          placeholder={"https://api.example.com\nhttps://*.example.com\n*"}
          value={form.networkAllowlist}
          onChange={update("networkAllowlist")}
        />
      </label>

      <label>
        Extra system prompt (appended to defaults, or replaces if filled)
        <textarea
          id="systemPromptInput"
          rows={6}
          placeholder="Optional extra instructions for the agent (leave blank to use built-in guardrail prompt)"
          value={form.systemPrompt}
          onChange={update("systemPrompt")}
        />
      </label>

      <hr style={{ border: "1px solid var(--ink)", margin: "15px 0" }} />
      <h3>Agent Risk Patterns</h3>
      <div className="row" style={{ gap: 8 }}>
        <button id="exportRiskPatternsBtn" className="btn small" type="button" onClick={exportRiskPatterns}>
          Export Patterns
        </button>
        <button id="importRiskPatternsBtn" className="btn small" type="button" onClick={() => fileInputRef.current?.click()}>
          Import Patterns
        </button>
        <input id="importRiskFileInput" ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={onImportFile} />
      </div>

      <div className="row" style={{ marginTop: 15 }}>
        <button id="saveSettingsBtn" className="btn primary" type="button" onClick={onSave}>
          Save settings
        </button>
      </div>
    </section>
  );
}
