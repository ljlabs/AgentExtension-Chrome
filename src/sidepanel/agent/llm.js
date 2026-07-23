import { getOpenAiTools } from "../../lib/toolsSchema.js";
import { joinUrl } from "./urls.js";
import { truncate } from "./util.js";

/**
 * POST an OpenAI-style chat completion. `onAbortController` receives the
 * AbortController so the caller (store/controller) can cancel via Stop.
 */
export async function llmChat(messages, settings, onAbortController) {
  if (!settings.model) {
    throw new Error("No model selected. Open Settings and choose a model.");
  }

  const controller = new AbortController();
  if (onAbortController) onAbortController(controller);

  const timer = setTimeout(() => controller.abort(), settings.requestTimeoutMs);

  try {
    const headers = {
      "Content-Type": "application/json"
    };

    if (settings.apiKey) {
      headers.Authorization = `Bearer ${settings.apiKey}`;
    }

    const body = {
      model: settings.model,
      messages,
      tools: getOpenAiTools(),
      tool_choice: "auto",
      stream: false
    };

    if (Number.isFinite(settings.temperature)) {
      body.temperature = settings.temperature;
    }

    if (Number.isFinite(settings.maxTokens) && settings.maxTokens > 0) {
      body.max_tokens = settings.maxTokens;
    }

    const response = await fetch(joinUrl(settings.baseUrl, settings.chatPath), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM HTTP ${response.status}: ${truncate(errorText, 800)}`);
    }

    return await response.json();
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("LLM request timed out or was stopped.");
    }

    throw err;
  } finally {
    clearTimeout(timer);
    if (onAbortController) onAbortController(null);
  }
}

export async function fetchModels(settings) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const headers = {};
    if (settings.apiKey) {
      headers.Authorization = `Bearer ${settings.apiKey}`;
    }

    const response = await fetch(joinUrl(settings.baseUrl, settings.modelsPath), {
      headers,
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Models endpoint returned HTTP ${response.status}.`);
    }

    const text = await response.text();

    try {
      const json = JSON.parse(text);
      return parseModelsJson(json);
    } catch {
      return text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    }
  } finally {
    clearTimeout(timer);
  }
}

export function parseModelsJson(json) {
  const out = [];

  const addItem = (item) => {
    if (!item) return;

    if (typeof item === "string") {
      out.push(item);
      return;
    }

    if (typeof item === "object") {
      const id = item.id || item.name || item.model || item.slug || item.title;
      if (id) out.push(String(id));
    }
  };

  if (Array.isArray(json)) {
    json.forEach(addItem);
  } else if (json && typeof json === "object") {
    if (Array.isArray(json.data)) {
      json.data.forEach(addItem);
    } else if (Array.isArray(json.models)) {
      json.models.forEach(addItem);
    } else if (Array.isArray(json.results)) {
      json.results.forEach(addItem);
    } else {
      for (const value of Object.values(json)) {
        if (Array.isArray(value)) {
          value.forEach(addItem);
        } else {
          addItem(value);
        }
      }
    }
  }

  return [...new Set(out)];
}
