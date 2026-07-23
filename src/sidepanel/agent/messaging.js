export function sendMessageWithTimeout(message, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve({ ok: false, error: "Extension message timed out." });
      }
    }, timeoutMs);

    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (done) return;

        done = true;
        clearTimeout(timer);

        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }

        resolve(response || { ok: false, error: "No response from background." });
      });
    } catch (err) {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, error: err.message || String(err) });
      }
    }
  });
}
