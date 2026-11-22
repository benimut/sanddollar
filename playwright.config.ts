import { defineConfig, devices } from '@playwright/test';

// 遠端 Linux 容器與 CI 環境通常未預裝系統 Chrome，自動退回使用 Playwright 內建 Chromium；
// 本機（Windows / macOS）預設沿用系統 Chrome，亦可透過 PLAYWRIGHT_CHANNEL 環境變數覆寫
const browserChannel =
  process.env.PLAYWRIGHT_CHANNEL ||
  (process.env.CI || process.platform === 'linux' ? undefined : 'chrome');

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: browserChannel ? 'Google Chrome' : 'Chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(browserChannel ? { channel: browserChannel } : {}),
      },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
  },
});
