import http from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Load .env from project root
const envPath = resolve(import.meta.dirname, "..", ".env");
let PORT = 8001;
try {
  const env = readFileSync(envPath, "utf-8");
  for (const line of env.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key === "TEST_PORT") PORT = Number(val) || 8001;
  }
} catch {
  // .env not found, use default
}

const TEST_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agent Test Page</title>
  <style>
    :root {
      --ink: #111;
      --pink: #ffd6e8;
      --green: #c7f9cc;
      --blue: #bde0fe;
      --yellow: #fff3b0;
    }

    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: linear-gradient(135deg, var(--pink), var(--blue), var(--green));
      font-family: system-ui, sans-serif;
      color: var(--ink);
    }

    main {
      width: min(680px, calc(100vw - 32px));
      background: white;
      border: 4px solid var(--ink);
      box-shadow: 10px 10px 0 var(--ink);
      padding: 24px;
    }

    h1 {
      margin-top: 0;
      text-transform: uppercase;
    }

    .card {
      border: 3px solid var(--ink);
      box-shadow: 6px 6px 0 var(--ink);
      padding: 16px;
      margin: 16px 0;
      background: var(--yellow);
      font-weight: 800;
    }

    button {
      appearance: none;
      border: 3px solid var(--ink);
      box-shadow: 6px 6px 0 var(--ink);
      background: var(--green);
      font-weight: 900;
      text-transform: uppercase;
      padding: 12px 18px;
      cursor: pointer;
    }

    button:active {
      transform: translate(6px, 6px);
      box-shadow: none;
    }

    label {
      display: block;
      font-weight: 800;
      margin: 16px 0 8px;
    }

    input {
      width: 100%;
      padding: 12px;
      border: 3px solid var(--ink);
      box-shadow: inset 3px 3px 0 rgba(17, 17, 17, 0.1);
      font: inherit;
      font-weight: 700;
    }
  </style>
</head>
<body>
  <main>
    <h1>Agent Test Page</h1>

    <div class="card" id="test-status">Button clicked count: 0</div>

    <button id="test-button" type="button">Click me</button>

    <label for="test-input">Test input</label>
    <input id="test-input" type="text" placeholder="Agent should type here" />

    <div class="card" id="test-input-status">Input value: (empty)</div>
  </main>

  <script>
    let count = 0;

    const status = document.getElementById("test-status");
    const input = document.getElementById("test-input");
    const inputStatus = document.getElementById("test-input-status");
    const button = document.getElementById("test-button");

    button.addEventListener("click", () => {
      count += 1;
      status.textContent = "Button clicked count: " + count;
    });

    input.addEventListener("input", () => {
      inputStatus.textContent = input.value
        ? "Input value: " + input.value
        : "Input value: (empty)";
    });
  </script>
</body>
</html>`;

function toolCall(name, args, id) {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args)
    }
  };
}

function assistantToolResponse(toolCalls, content = "") {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content,
          tool_calls: toolCalls
        }
      }
    ]
  };
}

function assistantFinalResponse(content) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content
        }
      }
    ]
  };
}

function nextCompletion(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const toolMessages = messages.filter((message) => message && message.role === "tool");

  const toolText = toolMessages
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
    .join("\n");

  const count = toolMessages.length;

  const invalidRecovered = toolText.includes("invalid_tool_call");
  const networkOk = toolText.includes("/test-api") && toolText.includes("200");
  const networkDenied = toolText.includes("Permission denied: network request");
  const screenshotOk = toolText.includes("Screenshot captured");
  const screenshotDenied = toolText.includes("Permission denied: image reading");

  // Step 0:
  // Intentionally return an invalid tool call.
  // The extension should validate it, refuse execution, and send the error back.
  if (count === 0) {
    return assistantToolResponse(
      [toolCall("wait", { ms: -100 }, "call_test_invalid")],
      "Testing tool schema validation."
    );
  }

  // Step 1:
  // Recover from invalid tool call and read page info.
  if (count === 1) {
    return assistantToolResponse([toolCall("get_page_info", {}, "call_page_info")]);
  }

  // Step 2:
  // Get interactive elements.
  if (count === 2) {
    return assistantToolResponse([
      toolCall("get_interactive_snapshot", { maxElements: 25 }, "call_snapshot")
    ]);
  }

  // Step 3:
  // Wait. This gives you time to switch tabs and verify the agent stays bound.
  if (count === 3) {
    return assistantToolResponse(
      [toolCall("wait", { ms: 3000 }, "call_wait")],
      "Switch tabs now if you want to test bound-tab behavior."
    );
  }

  // Step 4:
  // Click the test button.
  if (count === 4) {
    return assistantToolResponse([
      toolCall(
        "click",
        {
          selector: "#test-button",
          waitAfterMs: 700
        },
        "call_click"
      )
    ]);
  }

  // Step 5:
  // Type into the test input.
  if (count === 5) {
    return assistantToolResponse([
      toolCall(
        "type_text",
        {
          selector: "#test-input",
          text: "Hello agent",
          clear: true
        },
        "call_type"
      )
    ]);
  }

  // Step 6:
  // Make a localhost network request.
  if (count === 6) {
    return assistantToolResponse([
      toolCall(
        "http_request",
        {
          url: `http://localhost:${PORT}/test-api`,
          method: "GET"
        },
        "call_network"
      )
    ]);
  }

  // Step 7:
  // Request a screenshot. This should trigger the image permission modal.
  if (count === 7) {
    return assistantToolResponse([
      toolCall(
        "screenshot",
        {
          format: "jpeg",
          quality: 60
        },
        "call_screenshot"
      )
    ]);
  }

  // Step 8:
  // Final answer.
  const finalText = [
    "FULL SIDE PANEL TEST COMPLETE",
    "",
    `Schema validation recovery: ${invalidRecovered ? "PASS" : "UNKNOWN"}`,
    "Button click: expected test page status to show count >= 1",
    "Typed text: expected test input value Hello agent",
    `Network: ${
      networkOk
        ? "PASS (/test-api returned 200)"
        : networkDenied
          ? "DENIED"
          : "CHECK SIDE PANEL TOOL RESULT"
    }`,
    `Screenshot: ${
      screenshotOk
        ? "PASS"
        : screenshotDenied
          ? "DENIED BY USER"
          : "UNKNOWN"
    }`
  ].join("\n");

  return assistantFinalResponse(finalText);
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);

  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  });

  res.end(body);
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;

      // Safety limit for screenshots/base64 payloads.
      if (body.length > 50_000_000) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });

    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    });
    res.end();
    return;
  }

  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(302, {
      Location: "/test-page"
    });
    res.end();
    return;
  }

  if (url.pathname === "/test-page" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    });
    res.end(TEST_PAGE);
    return;
  }

  if (url.pathname === "/test-config" && req.method === "GET") {
    sendJson(res, 200, {
      port: PORT,
      testPage: `http://localhost:${PORT}/test-page`,
      models: `http://localhost:${PORT}/models`,
      chat: `http://localhost:${PORT}/chat/completions`
    });
    return;
  }

  if (url.pathname === "/models" && req.method === "GET") {
    sendJson(res, 200, {
      object: "list",
      data: [
        {
          id: "mock-agent"
        }
      ]
    });
    return;
  }

  if (url.pathname === "/test-api" && req.method === "GET") {
    console.log("TEST API CALLED");

    sendJson(res, 200, {
      ok: true,
      message: "network works",
      time: new Date().toISOString()
    });
    return;
  }

  if (url.pathname === "/chat/completions" && req.method === "POST") {
    const payload = await readJson(req);

    const toolMessageCount = Array.isArray(payload.messages)
      ? payload.messages.filter((message) => message && message.role === "tool").length
      : 0;

    const completion = nextCompletion(payload);

    const toolCalls = completion.choices?.[0]?.message?.tool_calls;

    console.log(
      `[chat/completions] toolMessages=${toolMessageCount} responding=${
        toolCalls ? toolCalls.map((toolCall) => toolCall.function.name).join(", ") : "final"
      }`
    );

    sendJson(res, 200, completion);
    return;
  }

  sendJson(res, 404, {
    error: "Not found."
  });
});

server.listen(PORT, () => {
  console.log(`Mock LLM server running at http://localhost:${PORT}`);
  console.log(`Test page: http://localhost:${PORT}/test-page`);
  console.log(`Models endpoint: http://localhost:${PORT}/models`);
  console.log(`Chat endpoint: http://localhost:${PORT}/chat/completions`);
});
