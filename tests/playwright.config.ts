import { defineConfig, devices } from '@playwright/test';

export const API_URL =
  process.env.VOYAGENIE_API_URL ||
  'http://localhost:4000';

/** Recording the impact coverage map needs every test in one pass, not sharded across workers. */
const recordingCoverage = process.env.VOYAGENIE_COVERAGE === '1';

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: !recordingCoverage,
  workers: recordingCoverage ? 1 : undefined,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,

  reporter: recordingCoverage
    ? [['list'], ['./reporters/coverage-map.ts']]
    : process.env.CI
      ? [['list'], ['html', { open: 'never' }]]
      : 'list',

  use: {
    baseURL:
      process.env.VOYAGENIE_BASE_URL ||
      'https://voyagenie-app.azurewebsites.net',

    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
