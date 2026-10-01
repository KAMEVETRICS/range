import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * `pnpm dev:live` serves the dashboard against the public deployment's read-only API, to work on the UI with live data.
 * Plain `pnpm dev` has no API behind it: the Playwright tests mock every call.
 */
const LIVE_API = "https://range.datatides.xyz";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: mode === "live" ? { proxy: { "/v1": { target: LIVE_API, changeOrigin: true } } } : {},
  test: {
    environment: "jsdom",
    setupFiles: "./src/test-setup.ts",
  },
}));
