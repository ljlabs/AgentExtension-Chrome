# Chrome Extension Test Harness

Deterministic end-to-end test for the Local LLM Browser Agent side panel.

## Quick Start

```bash
# From project root
node test/mock-llm-server.mjs
```

Then in Chrome:

1. Open `http://localhost:8001/test-page`
2. Click the extension icon to bind the side panel
3. Open side panel Settings and set:
   - Base URL: `http://localhost:8001`
   - Models path: `/models`
   - Chat path: `/chat/completions`
   - Model: `mock-agent`
   - Max tool steps: `12`
   - Attach page HTML: enabled
   - Auto-allow localhost: enabled
4. Click **Refresh models**, confirm `mock-agent` appears
5. Click **Save settings**

## Running the Automated Test

1. Right-click inside the side panel → **Inspect** → open Console
2. Paste the script from `test/sidepanel-test.js` and press Enter
3. Wait for `FULL SIDE PANEL TEST PASSED` or an error message

## What the Test Covers

| Step | Tool tested | What it verifies |
|------|------------|-----------------|
| 0 | (invalid `wait`) | Schema validation catches bad args, sends error back |
| 1 | `get_page_info` | Page metadata retrieval |
| 2 | `get_interactive_snapshot` | DOM element discovery |
| 3 | `wait` | Timed delay (manual bound-tab test window) |
| 4 | `click` | Button click on test page |
| 5 | `type_text` | Text input |
| 6 | `http_request` | Localhost network fetch |
| 7 | `screenshot` | Image permission modal + capture |
| 8 | (final) | Summary with all results |

## Configuration

Edit `.env` in the project root:

```
TEST_PORT=8001
```

## Mock Server Endpoints

| Path | Method | Description |
|------|--------|-------------|
| `/` | GET | Redirects to `/test-page` |
| `/test-page` | GET | Serves the interactive test HTML page |
| `/models` | GET | Returns `mock-agent` model list |
| `/chat/completions` | POST | Mock LLM responses (scripted tool-call flow) |
| `/test-api` | GET | Network fetch test target |
