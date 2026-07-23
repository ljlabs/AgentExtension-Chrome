import { defineConfig } from "vite";
import { resolve } from "path";

// Builds the MV3 service worker as a single ES module at dist/background.js.
// Runs after the main HTML build (emptyOutDir: false keeps its output).
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    copyPublicDir: false,
    lib: {
      entry: resolve(__dirname, "src/background/index.js"),
      formats: ["es"],
      fileName: () => "background.js"
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true
      }
    }
  }
});
