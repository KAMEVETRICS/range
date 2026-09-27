import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:4173",
    channel: "chrome",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm --filter @range/web dev --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
  },
});
