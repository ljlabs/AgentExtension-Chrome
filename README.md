# Local LLM Browser Agent

Chrome Manifest V3 extension that adds a neobrutalist pastel chat side panel. It connects to a local OpenAI-compatible LLM server, sends page HTML when enabled, validates tool calls, returns validation errors to the model, asks permission before sending images, and can interact with the bound tab.

## Load the extension

1. Create a folder and add all files.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Click Load unpacked.
5. Select the folder.

## Use

1. Open the tab you want the agent to control.
2. Click the extension icon.
3. The side panel opens and binds to the currently active tab.
4. When you switch tabs, the side panel saves the current tab's chat context and automatically binds to the newly active tab.
5. When you switch back to a previous tab, its saved chat context is loaded into the side panel.
6. Use Rebind if you need to manually reattach or refresh the binding for the active tab.

## Local LLM settings

Default:

- Base URL: `http://localhost:8000/v1`
- Models path: `/models`
- Chat path: `/chat/completions`

If your server uses `/v1/models` and `/v1/chat/completions`, change those in Settings.

## Permissions and safety

- The extension uses broad host permissions because it must inject into arbitrary pages and make network requests on behalf of the agent.
- Image tools require explicit user permission before image pixels are sent to the LLM.
- Network requests to non-localhost origins prompt for permission unless allowlisted.
- Chrome system pages, extension pages, and the Chrome Web Store are blocked.
- File URLs are blocked by default.

## Tools

- `get_page_info`
- `get_html`
- `get_text`
- `get_interactive_snapshot`
- `click`
- `type_text`
- `set_value`
- `press_key`
- `scroll_to`
- `wait`
- `http_request`
- `screenshot`
- `get_images`

## Notes

- Screenshots use the Chrome Debugger API. Chrome may show a debugging banner.
- If the bound tab is not visible, screenshots still attempt to capture that bound tab via debugger.
- Some sites use trusted-event-only handlers. The extension uses synthetic DOM events and `element.click()`, which works for many but not all sites.
- Full-page HTML can be very large. The Attach page HTML toggle truncates HTML to the configured max character limit.


## Expected Behaviour

1. When the side panel opens, it attaches to the active tab.
2. When tabs are switched, the side panel saves the current tab's chat, attaches to the new active tab, and loads that tab's chat context.
3. When switching back to a previous tab, that tab's saved chat context is restored in the side panel.