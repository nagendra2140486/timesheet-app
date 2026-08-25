import { defineConfig, devices } from '@playwright/test';

/**
 * URLs are supplied by the impacted-test runner.
 * Local fallbacks allow developers to execute tests locally.
 */
export const API_URL =
  process.env.TIMESHEET_API_URL ||
  'http://localhost:3001';

/** Recording the impact coverage map needs every test in one pass. */
const recordingCoverage =
  process.env.TIMESHEET_COVERAGE === '1';

export default defineConfig({
  testDir: './e2e',

  timeout: 60_000,

  expect: {
    timeout: 15_000
  },

  fullyParallel: !recordingCoverage,

  workers:
    recordingCoverage
      ? 1
      : undefined,

  forbidOnly: !!process.env.CI,

  retries:
    process.env.CI
      ? 1
      : 0,

  reporter: recordingCoverage
    ? [['list'], ['./reporters/coverage-map.ts']]
    : process.env.CI
      ? [['list'], ['html', { open: 'never' }]]
      : 'list',

  use: {
    baseURL:
      process.env.TIMESHEET_BASE_URL ||
      'https://qea-timesheet-uat-ayfch9f0ehhwg6fp.canadacentral-01.azurewebsites.net',

    trace: 'retain-on-failure',

    screenshot: 'only-on-failure',

    video: 'off'
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome']
      }
    }
  ]
});
