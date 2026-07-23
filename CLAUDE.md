# CLAUDE.md — Local LLM Browser Agent

Chrome MV3 extension: a side-panel chat agent driven by a local OpenAI-compatible LLM that automates the active browser tab, plus a Monaco editor tab for the agent's persistent Memories/Skills/Rules. Everything is React + ES modules built by Vite into `dist/`; the only static file is `public/manifest.json`.

## Commands

```bash
npm run build   # 3-stage build → dist/ (load dist/ unpacked in Chrome)
npm test        # vitest run (all tests in src/__tests__/)
npm run dev     # vite dev server (editor page only; extension APIs unavailable)
```

`.npmrc` pins the public npm registry (overrides the machine-level CodeArtifact registry, which 401s here).

## Build pipeline (3 sequential Vite builds — order matters)

| Stage | Config | Output | Format | Why separate |
|---|---|---|---|---|
| 1 | `vite.config.js` | `dist/{sidepanel,editor}.html` + `dist/assets/*` | ES modules | HTML entries; `emptyOutDir: true` wipes dist first; copies `public/manifest.json` |
| 2 | `vite.config.background.js` | `dist/background.js` | single ES module | MV3 module service worker (`"type": "module"` in manifest); no importScripts allowed |
| 3 | `vite.config.content.js` | `dist/content.js` | IIFE | `chrome.scripting.executeScript({files})` injects **classic** scripts — output must contain zero import/export |

Asset names are unhashed (`assets/[name].js`) — the extension needs stable paths. Base is `"./"` for `chrome-extension://` URLs. CSP is `script-src 'self' 'wasm-unsafe-eval'` — no CDN scripts, which is why Monaco is bundled locally (`loader.config({ monaco })` in `src/components/MonacoEditor.jsx`).

## Source layout

```
public/manifest.json         MV3 manifest (only non-built artifact)
sidepanel.html, editor.html  Vite entry shells (root <div> + module script)
src/
  lib/                       Shared ES modules (used by sidepanel AND background)
    toolsSchema.js           AGENT_TOOLS defs, getOpenAiTools(), validateToolCall()
    validator.js             normalizeAndValidate(): JSON-Schema-ish validation + coercion + defaults
    network.js               performHttpRequest(), isLocalOrigin(), originMatchesPattern()
    markdown.js              renderMarkdown() → DocumentFragment (textContent-only, no innerHTML)
  background/index.js        Service worker: message router + privileged tool handlers
  content/index.js           Content script: PAGE_TOOL executor (self-contained, no imports)
  sidepanel/
    main.jsx                 Entry: createRoot + styles import
    SidePanelApp.jsx         Layout + one-time chrome event wiring (useEffect)
    agent/                   THE ENGINE — plain ES modules, no React
      store.js               Mutable `state` + emit() → snapshot for useSyncExternalStore
      controller.js          runAgent loop, executeToolWithPermissions, tab binding/switching,
                             per-tab persistence, settings, models, interactive cards, permissions
      llm.js                 llmChat(), fetchModels(), parseModelsJson()
      parsing.js             parseAssistantResponse(), extractJson() (salvages JSON tool calls from text)
      images.js              extractImages/stripImages/containsImages/looksLikeImageError
      settings.js            DEFAULT_SETTINGS, normalizeSettings()
      systemPrompt.js        DEFAULT_SYSTEM_PROMPT (action-first) + buildSystemMessage() (mode addendums)
      gating.js              PLAN_GATED_TOOLS / SAFE_MODE_APPROVAL_TOOLS + predicates
      messaging.js           sendMessageWithTimeout() wrapper
    components/              Header, SettingsDrawer, ChatLog, MessageItem, Markdown,
                             QuestionCard, ApprovalCard, PlanCard, Composer, StatusBar, PermissionModal
  App.jsx + components/ + hooks/useStorage.js   Editor tab app (Memories/Skills/Rules + Monaco)
  styles/{sidepanel,editor}.css                 Plain CSS classes, neobrutalist tokens in :root
  __tests__/                 Vitest + RTL; setup.jsx mocks chrome.* and monaco
test/                        Manual E2E: mock-llm-server.mjs + sidepanel-test.js (DevTools paste)
```

## Architecture: how a tool call flows

```
LLM response
  → parsing.js parseAssistantResponse (native tool_calls OR JSON salvaged from text)
  → toolsSchema.js validateToolCall (schema validation, arg coercion, defaults)
  → controller.js executeToolWithPermissions:
      1. Plan/Safe mode gates (blocked → {ok:false, error:{code, instruction}} so model self-corrects)
      2. Sidepanel-local interactive tools (ask_user_question / request_approval / submit_plan)
         → pushInteractive() renders a card, returns a Promise resolved by resolveInteraction()
      3. Image permission gate (screenshot / get_images+includeBase64) → PermissionModal promise
      4. http_request → origin allowlist / network permission → performHttpRequest IN THE PANEL
      5. everything else → executePrivilegedTool → chrome.runtime.sendMessage
  → background/index.js handleExecuteTool:
      - http_request/screenshot/wait/storage/risk/memories/skills/rules handled in worker
      - page tools → ensureContentScript (inject content.js) → tabs.sendMessage {type:"PAGE_TOOL"}
  → content/index.js executeContentTool → DOM operations → {ok, data} back up the chain
  → result stringified (ui key stripped, truncated to maxToolResultChars) into a role:"tool" message;
    extracted _images become a user message with image_url parts when vision is on
```

## Message protocol (do not change one side without the other)

Sidepanel → background (`chrome.runtime.sendMessage`):
`executeTool {tool, args, tabId}` · `ensureContentScript {tabId}` · `openEditor` · `exportRiskPatterns` · `importRiskPatterns {jsonString}` · `getTabInfo {tabId}`
Background → sidepanel: `tabActivated {tabId, url, title}` relay.
Background → content: `PAGE_TOOL {tool, args}` via `tabs.sendMessage`.
Editor → background: `executeTool {tool: memories|skills|rules, args}` (no tabId needed).
All responses are `{ok: true, data} | {ok: false, error}` — errors are values, never throws across boundaries.

## Storage keys

| Key | Area | Contents |
|---|---|---|
| `settings` | local | normalized settings incl. planMode/safeMode (persist across restarts) |
| `chat_<tabId>` | session | `{messages, imagePermission}` per-tab transcript |
| `pendingBindTabId` | session | written by background on action click; consumed once by sidepanel init |
| `agent_memories` / `agent_skills` / `agent_rules` | local | `{<plural>: [{id, title, content, created, updated}]}` (skills embed YAML front matter) |
| `agent_risk_patterns` | local | learned risk patterns (exportable JSON) |

## State model (sidepanel)

Two parallel lists, deliberately:
- **`state.messages`** — the OpenAI transcript (persisted per tab; source of truth for the LLM).
- **`state.chatItems`** — display items React renders (`kind`: user/assistant/system/error/tool-result/interactive). Rebuilt from `messages` on tab switch (`rebuildChatItems`); appended live during a run.

The engine mutates `state` freely outside render; every mutation site calls `emit()`, which rebuilds an immutable snapshot for `useSyncExternalStore`. **If you add a field React must see, add it to `buildSnapshot()` in store.js** — otherwise the UI goes stale.

Promise-bridged UI: interactive cards and the permission modal are Promises created in the engine (`pushInteractive`, `requestPermission`) and resolved from React (`resolveInteraction`, `closePermission`). `onStop()` must cancel all of these (abort LLM fetch, deny modal, `cancelPendingInteractions()`) or `requestTabSwitch`'s `await state.runPromise` deadlocks.

Tab switching is serialized through `tabSwitchQueue` (promise chain). `state.runPromise` is set in `onSend` — that's what lets a switch await a mid-flight run.

## Safeguards system

- **Modes** (persisted in settings; ☰ menu): Plan Mode gates `click/type_text/set_value/press_key/write_browser_storage` behind an approved `submit_plan` (one approval covers the plan). Safe Mode (forces Plan on) additionally requires a fresh single-use `request_approval` before each gated action. `scroll_to` and all read tools are never gated.
- Gate rejections carry `error.instruction` telling the model the exact next call — critical for OSS models.
- The default system prompt is **action-first**; clarify/plan/approve language lives only in the mode addendums appended by `buildSystemMessage`. Don't re-add mandatory guardrails to the base prompt — that's what previously made OSS models refuse to act.
- Permissions: image (screenshot/get_images pixels) and network (http_request to non-allowlisted origins) prompt Allow once / Allow for session / Deny. Session grants live in `state` (network) or per-tab persisted `imagePermission`.

## Open-source model constraints (learned the hard way)

1. **No top-level `anyOf`/`oneOf` in tool parameter schemas** — breaks grammar-constrained decoding (llama.cpp/vLLM/Ollama). Target requirements ("one of ref/selector/xpath") are stated in descriptions and enforced by runtime errors that tell the model how to fix the call.
2. `parseAssistantResponse` salvages JSON tool calls embedded in text and accepts `arguments` as object or string.
3. Validation failures loop back to the model as structured `invalid_tool_call` errors — the loop never silently drops a bad call.
4. Vision fallback: on an image-shaped LLM error, strip images and retry once (`visionFailed`).

## Conventions

- Components: function components, default export, `.jsx`. Hooks/utils/engine: named exports, `.js`. No TypeScript.
- Plain CSS classes (BEM-ish), design tokens in `:root`. The vanilla-era DOM ids (`chatLog`, `userInput`, `sendBtn`, `modalBackdrop`, …) are kept on React elements so `test/sidepanel-test.js` still works — don't remove them.
- chrome.* is always guarded (`typeof chrome !== "undefined"`) in code that runs under jsdom.
- Tests mock chrome in `src/__tests__/setup.jsx` (includes event stubs because background/controller register listeners at import time). Background is tested by importing `src/background/index.js` directly with the mocked chrome.
- `initController()` is idempotent (`initialized` flag) because React StrictMode double-invokes effects.

## Gotchas

- content.js must stay self-contained — a shared import would produce an ES chunk that breaks classic-script injection. If you need shared logic there, duplicate it or inline it.
- `emptyOutDir` only in stage 1; stages 2–3 write into the same dist.
- `chrome.storage.session` evaporates on browser restart — per-tab chats are session-scoped by design.
- Restricted URLs (`chrome:`, `chrome-extension:`, Web Store, `file:`) are refused by `ensureContentScript` (RESTRICTED_URL_RE in background).
- Screenshots: Debugger API first (shows Chrome's debugging banner), `captureVisibleTab` fallback only when the tab is active.
- The editor and side panel sync via `chrome.storage.onChanged` — writes from either side appear live in the other.
