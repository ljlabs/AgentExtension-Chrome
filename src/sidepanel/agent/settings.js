import { ensureLeadingSlash } from "./urls.js";

export const DEFAULT_SETTINGS = {
  baseUrl: "http://localhost:8000/v1",
  modelsPath: "/models",
  chatPath: "/chat/completions",
  apiKey: "",
  model: "",
  temperature: 0.2,
  maxTokens: 2048,
  maxToolSteps: 12,
  maxToolResultChars: 20000,
  requestTimeoutMs: 120000,
  toolTimeoutMs: 60000,
  modelSupportsVision: true,
  autoAllowLocalhostNetwork: true,
  networkAllowlist: [],
  systemPrompt: "",
  safeMode: false,
  planMode: false
};

export function normalizeSettings(input) {
  const networkAllowlist = Array.isArray(input.networkAllowlist)
    ? input.networkAllowlist
    : String(input.networkAllowlist || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

  return {
    ...DEFAULT_SETTINGS,
    ...input,
    baseUrl: String(input.baseUrl || DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ""),
    modelsPath: ensureLeadingSlash(input.modelsPath || DEFAULT_SETTINGS.modelsPath),
    chatPath: ensureLeadingSlash(input.chatPath || DEFAULT_SETTINGS.chatPath),
    apiKey: String(input.apiKey || ""),
    model: String(input.model || ""),
    temperature: Number(input.temperature),
    maxTokens: Number.parseInt(input.maxTokens, 10),
    maxToolSteps: Number.parseInt(input.maxToolSteps, 10),
    maxToolResultChars: Number.parseInt(input.maxToolResultChars, 10),
    requestTimeoutMs: Number.parseInt(input.requestTimeoutMs, 10),
    toolTimeoutMs: Number.parseInt(input.toolTimeoutMs, 10),
    modelSupportsVision: Boolean(input.modelSupportsVision),
    autoAllowLocalhostNetwork: Boolean(input.autoAllowLocalhostNetwork),
    networkAllowlist,
    systemPrompt: String(input.systemPrompt || ""),
    safeMode: Boolean(input.safeMode),
    planMode: Boolean(input.planMode)
  };
}
