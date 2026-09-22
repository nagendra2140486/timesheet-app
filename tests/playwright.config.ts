import { defineConfig, devices } from '@playwright/test';

/**
 * Both URLs come from the PRQE trigger payload at run time (functional.env in devin/config.yaml)
 * and fall back to the local stack, so `npx playwright test` works with no environment set up.
 * A deployment that serves the API and the UI from one origin passes the same value for both.
 */
export const API_URL = process.env.TIMESHEET_API_URL || 'http://localhost:3001';

/** Recording the impact coverage map needs every test in one pass, not sharded across workers. */
const recordingCoverage = process.env.TIMESHEET_COVERAGE === '1';

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
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
    // Only TIMESHEET_API_URL is supplied by the pipeline (via the PAT
    // Library group) - TIMESHEET_BASE_URL is not set anywhere on purpose.
    // This UAT deployment serves the API and the UI from one origin
    // (TIMESHEET_API_URL already points at it), so baseURL falls back to
    // API_URL before ever reaching the local dev default.
    baseURL: process.env.TIMESHEET_BASE_URL || API_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
