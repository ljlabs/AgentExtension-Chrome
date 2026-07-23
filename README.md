# Local LLM Browser Agent

Chrome Manifest V3 extension with two React UIs:

1. **Side panel chat agent** — connects to a local OpenAI-compatible LLM server, validates tool calls, and automates the currently active browser tab (read pages, click, type, fill forms).
2. **Editor tab** — a Monaco-based editor for the agent's persistent Memories, Skills, and Rules.

Everything is built by Vite into `dist/`; the only hand-maintained static file is `public/manifest.json`.

## Build and load

```bash
npm install
npm run build      # builds dist/ (side panel + editor + service worker + content script)
npm test           # vitest suite
```

1. Open `chrome://extensions`, enable Developer mode.
2. Click **Load unpacked** and select the **`dist/`** folder.
3. Click the extension icon on any normal tab — the side panel opens and binds to that tab.

## Local LLM settings

Defaults (change in the ☰ → Settings drawer):

- Base URL: `http://localhost:8000/v1`
- Models path: `/models`
- Chat path: `/chat/completions`
- Optional API key (sent as `Authorization: Bearer ...`)

Use **Refresh models** to populate the model dropdown from the server. The extension speaks the OpenAI chat-completions protocol with `tools` / `tool_calls`, and also salvages JSON tool calls that smaller open-source models embed in plain text.

---

## Expected behavior

This section is the authoritative description of what the app is supposed to do. The Vitest suite in `src/__tests__/` covers the marked behaviors.

### Side panel lifecycle & tab binding

1. Opening the side panel binds it to the active tab (via `pendingBindTabId` handoff from the background worker, or by querying the active tab in the last-focused normal window). *(covered indirectly: controller init)*
2. Switching browser tabs saves the current tab's chat to `chrome.storage.session` (key `chat_<tabId>`), binds to the new tab, and loads that tab's saved chat. Switches are serialized through a queue; a mid-run agent is stopped and awaited before the swap.
3. Switching back to a previous tab restores its chat transcript, including completed question/approval/plan cards.
4. Activating the extension's own pages (e.g. the editor tab) does **not** steal the binding.
5. If the bound tab closes, the panel shows "Bound tab closed" and a system message; **Rebind** (☰ menu) reattaches to the active tab.
6. The header shows a status pill (bound hostname or `NO TAB`), plus Active/Bound tab labels that update on tab title/URL changes.

### Chat & agent loop

7. Send with the Send button or Ctrl/Cmd+Enter. Input and Send are disabled while the agent runs; a Stop button appears. *(covered: Composer tests)*
8. The agent loops up to **Max tool steps** (default 12): call LLM → validate each tool call against its JSON schema → execute → feed results back. Invalid calls return structured validation errors to the model so it can self-correct. *(covered: validateToolCall tests)*
9. Tool calls embedded as JSON in plain text (common with OSS models) are extracted and executed. *(covered: parsing tests)*
10. Assistant messages render as sanitized markdown (textContent only, no innerHTML); tool calls show as ok/invalid chips; tool results as truncated JSON blocks. *(covered: ChatLog/MessageItem tests)*
11. Stop aborts the in-flight LLM request, resolves any open permission modal as denied, and cancels pending interactive cards so the loop can unwind.
12. Clear (☰ menu, with confirm) wipes the tab's chat, permissions, and session network grants.
13. If the model errors on image content, images are stripped from the transcript and the request retries once without them (`visionFailed`). Screenshots taken while vision is off/failed note `imagePixelsOmitted`. *(covered: images tests)*
14. Chats persist per tab for the browser session (`chrome.storage.session`); settings persist across restarts (`chrome.storage.local`, key `settings`).

### Tools available to the model

Page (run in the content script of the bound tab): `get_page_info`, `get_html`, `get_text`, `get_interactive_snapshot` (assigns refs e1, e2, …), `click`, `type_text`, `set_value`, `press_key`, `scroll_to`, `get_images`, `assess_page_risk`.

Privileged (run in the background worker): `http_request`, `screenshot` (Debugger API with visible-tab fallback *(covered: screenshot tests)*), `wait`, `read_browser_storage`, `write_browser_storage`, `record_risk_assessment`, `memories`, `skills`, `rules` (each list/read/write/delete against `agent_*` storage keys).

Side-panel local (interactive, never leave the panel): `ask_user_question`, `request_approval`, `submit_plan`.

Action tools take one target: `ref` (preferred), `selector`, or `xpath`. The target requirement is enforced at runtime with a self-correcting error — deliberately **not** with JSON-Schema `anyOf`, which breaks grammar-constrained decoding on llama.cpp/vLLM/Ollama. *(covered: tools-schema tests)*

### Safeguards

15. **Image permission**: `screenshot` / `get_images(includeBase64)` prompt Allow once / Allow for session / Deny before pixels go to the LLM. Session grants persist per tab. *(covered: PermissionModal tests)*
16. **Network permission**: `http_request` to a non-allowlisted origin prompts the same modal. localhost is auto-allowed by default (toggle); the allowlist accepts origin patterns (`https://*.example.com`, `*`). Session denials block silently until Clear. Cloud-metadata hostnames are always blocked.
17. **Plan Mode** (☰ toggle, persisted): `click`, `type_text`, `set_value`, `press_key`, `write_browser_storage` are blocked until the model submits a plan (`submit_plan` card) and the user approves it. One approval covers the whole plan. Read-only tools (including `scroll_to`) are never gated. Rejections tell the model exactly what to do next. *(covered: gating + system-prompt tests)*
18. **Safe Mode** (☰ toggle, persisted; forces Plan Mode on): additionally every blocked action needs a fresh single-use `request_approval` immediately before it.
19. With both modes **off**, the agent acts directly without asking — the system prompt is action-first. *(covered: system-prompt tests)*
20. Interactive cards (question with radio/checkbox + free text, approval with Approve/Reject, plan with steps + feedback) render in-chat, block the loop until answered, then collapse to a summary and persist. *(covered: card component tests)*
21. `assess_page_risk` scans the page for payment/deletion/deployment indicators; `record_risk_assessment` persists learned patterns (`agent_risk_patterns`), which can be exported/imported as JSON in Settings.
22. Chrome system pages, extension pages, the Web Store, and `file:` URLs are never automated.

### Editor tab

23. ☰ → **Edit** opens `editor.html` in a new tab: Memories / Skills / Rules tabs, item sidebar, Monaco editor (bundled locally for CSP), front-matter parsing for skills. *(covered: App/Sidebar/EditorToolbar/useStorage/frontmatter tests)*
24. Saving writes through the background `executeTool` protocol; edits sync live between the editor and the agent via `chrome.storage.onChanged`.
25. Ctrl/Cmd+S saves the open item.

### Errors

26. Every failure path (LLM HTTP errors, timeouts, tool failures, content-script injection failures) surfaces as a structured `{ok:false, error}` result in the tool loop and/or a red error message in chat — the run loop never hangs on a tool failure.
27. LLM requests time out per **LLM timeout ms**; tool executions per **Tool timeout ms**.

## Notes

- Screenshots use the Chrome Debugger API; Chrome shows a debugging banner. If the debugger fails, capture falls back to `captureVisibleTab`.
- Some sites only respond to trusted events; the content script uses native `element.click()` where possible, then synthetic pointer/mouse events.
- The manual E2E harness lives in `test/`: `mock-llm-server.mjs` plus `sidepanel-test.js` (paste into the side-panel DevTools console).
