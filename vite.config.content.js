import { defineConfig } from "vite";
import { resolve } from "path";

// Builds the content script as a classic IIFE at dist/content.js.
// chrome.scripting.executeScript({ files }) injects classic scripts,
// so the output must contain no import/export statements.
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    copyPublicDir: false,
    lib: {
      entry: resolve(__dirname, "src/content/index.js"),
      formats: ["iife"],
      name: "AgentContentScript",
      fileName: () => "content.js"
    }
  }
});
