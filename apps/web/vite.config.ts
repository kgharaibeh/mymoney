import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The web client talks to the API over HTTP. In dev, proxy /v1 to the API so
// there is no CORS to configure. @mymoney/money-core resolves to its built
// dist (run `pnpm -r build` or build money-core once before `pnpm dev`).
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // bind 0.0.0.0 so the dev server is reachable in containers
    port: 5173,
    proxy: {
      "/v1": { target: "http://127.0.0.1:3000", changeOrigin: true },
    },
  },
});
