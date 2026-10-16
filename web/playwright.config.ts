import { defineConfig, devices } from "@playwright/test";

const previewPort = Number(process.env.BUZZ_WEB_E2E_PORT || 4173);

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  use: {
    baseURL: `http://127.0.0.1:${previewPort}`,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "smoke",
      testMatch: ["**/smoke.spec.ts", "**/markdown-math.spec.ts"],
      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],
  webServer: [
    {
      command: `pnpm exec vite preview --port ${previewPort} --strictPort --host 127.0.0.1`,
      cwd: ".",
      reuseExistingServer: !process.env.CI,
      url: `http://127.0.0.1:${previewPort}`,
    },
    {
      command: `pnpm exec vite --config tests/vite-math-preview.config.ts --port ${previewPort + 1} --strictPort --host 127.0.0.1`,
      cwd: ".",
      reuseExistingServer: !process.env.CI,
      url: `http://127.0.0.1:${previewPort + 1}`,
    },
  ],
});
