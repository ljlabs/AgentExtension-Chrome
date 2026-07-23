import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        editor: resolve(__dirname, "editor.html"),
        sidepanel: resolve(__dirname, "sidepanel.html")
      },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name].[ext]"
      }
    }
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/__tests__/setup.jsx"],
    alias: {
      "monaco-editor": resolve(__dirname, "node_modules/monaco-editor/esm/vs/editor/editor.main.js"),
      "@monaco-editor/react": resolve(__dirname, "node_modules/@monaco-editor/react/dist/index.mjs")
    }
  }
});

