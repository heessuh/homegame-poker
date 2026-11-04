import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  // The engine index re-exports shuffle.js (node:crypto); the browser only needs cards/variants/protocol.
  resolve: { alias: { "@homegame/engine": fileURLToPath(new URL("./src/engine-browser.ts", import.meta.url)) } },
  server: { proxy: { "/socket.io": { target: "http://localhost:3000", ws: true } } },
});
