/**
 * Side Panel Automated Test
 *
 * Paste this into the side panel DevTools console while the mock LLM server
 * is running and the test page is open in a bound tab.
 *
 * The mock server reads TEST_PORT from .env (default 8001).
 * Configure the side panel base URL to match.
 */
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const finalMarker = "FULL SIDE PANEL TEST COMPLETE";

  const chatLog = document.getElementById("chatLog");
  const modalBackdrop = document.getElementById("modalBackdrop");
  const allowOnce = document.getElementById("modalAllowOnce");
  const userInput = document.getElementById("userInput");
  const sendBtn = document.getElementById("sendBtn");
  const clearBtn = document.getElementById("clearBtn");
  const modelSelect = document.getElementById("modelSelect");

  if (!chatLog || !sendBtn || !userInput) {
    throw new Error(
      "Run this in the extension side panel DevTools console, not the web page console."
    );
  }

  // Allow the Clear button to work without a blocking confirm dialog.
  window.confirm = () => true;

  console.log("Clearing previous chat state...");
  clearBtn.click();
  await sleep(300);

  if (!modelSelect.value) {
    throw new Error(
      "No model selected. Open Settings, refresh models, choose mock-agent, and save settings."
    );
  }

  // Make sure the side panel state knows the selected model.
  modelSelect.dispatchEvent(new Event("change"));

  console.log("Starting full side panel test...");

  // Automatically approve permission modals.
  const observer = new MutationObserver(() => {
    if (!modalBackdrop.classList.contains("hidden")) {
      console.log("Permission modal detected. Clicking Allow once.");
      allowOnce.click();
    }
  });

  observer.observe(document.body, {
    attributes: true,
    subtree: true,
    attributeFilter: ["class"]
  });

  userInput.value = "Run full side panel test";
  sendBtn.click();

  const deadline = Date.now() + 120000;

  while (Date.now() < deadline) {
    if (chatLog.textContent.includes(finalMarker)) {
      observer.disconnect();

      console.log("Final marker found. Verifying side panel output...");

      if (!chatLog.textContent.includes("invalid_tool_call")) {
        throw new Error(
          "Expected invalid_tool_call validation error to appear in the side panel."
        );
      }

      if (!chatLog.textContent.includes("network works")) {
        throw new Error(
          "Expected network tool result containing 'network works' in the side panel."
        );
      }

      console.log("Finding test page tab...");

      // Read the base URL from the side panel's stored settings to derive the port.
      const stored = await new Promise((resolve) => {
        chrome.storage.local.get("settings", (data) => resolve(data?.settings || {}));
      });
      const baseUrl = stored.baseUrl || "http://localhost:8001";
      const origin = baseUrl.replace(/\/+$/, "");

      const tabs = await chrome.tabs.query({
        url: `${origin}/*`
      });

      const testTab = tabs.find((tab) => (tab.url || "").includes("/test-page"));

      if (!testTab) {
        throw new Error(
          `Test page tab not found. Make sure ${origin}/test-page is open.`
        );
      }

      console.log("Verifying bound test page DOM...");

      const results = await chrome.scripting.executeScript({
        target: {
          tabId: testTab.id
        },
        func: () => ({
          status: document.querySelector("#test-status")?.textContent || "",
          input: document.querySelector("#test-input")?.value || ""
        })
      });

      const pageState = results?.[0]?.result || {};

      console.log("PAGE STATE:", pageState);

      const match = String(pageState.status).match(/(\d+)/);
      const clickCount = match ? Number(match[1]) : 0;

      if (clickCount < 1) {
        throw new Error(
          "Button click did not update the bound test page. Expected count >= 1."
        );
      }

      if (pageState.input !== "Hello agent") {
        throw new Error(
          `Type text failed. Expected input value "Hello agent", received "${pageState.input}".`
        );
      }

      console.log(
        "%cFULL SIDE PANEL TEST PASSED",
        "color: #0a0; font-weight: bold; font-size: 16px;"
      );

      return {
        passed: true,
        clickCount,
        input: pageState.input
      };
    }

    await sleep(500);
  }

  observer.disconnect();

  throw new Error(
    "Timed out waiting for mock agent final message. Check side panel errors and mock server logs."
  );
})();
