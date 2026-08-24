import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_URL } from '../playwright.config';

/**
 * Observation fixtures for test-impact analysis. Every test records, at runtime:
 *   - the app routes it visited
 *   - the API endpoints it called (through the browser or the `request` fixture)
 *   - the frontend source files it actually executed (V8 coverage)
 *
 * Nothing is inferred from test names or source parsing, so the resulting map stays
 * correct when tests are refactored. Enabled only when TIMESHEET_COVERAGE=1, so normal
 * runs pay no overhead.
 */
export const COVERAGE_ENABLED = process.env.TIMESHEET_COVERAGE === '1';

export interface TestObservation {
  routes: string[];
  endpoints: string[];
  sourceFiles: string[];
}

const apiOrigin = new URL(API_URL).origin;

/**
 * Every row in this app is scoped to `user_email`, and both the login route and the auth
 * middleware create a user on first sight. A unique email per test therefore gives each test
 * a private dataset: no seeding, no cleanup, and no interference between parallel workers or
 * between runs against a database that persists.
 *
 * The domain must be `example.com`: login validates with Joi, which checks the TLD against the
 * IANA list and rejects `@example.test`, while the auth middleware's regex accepts it.
 */
export const uniqueEmail = (label: string): string =>
  `pw-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}@example.com`;

/**
 * Puts the browser in the signed-in state the app itself produces: the API client reads
 * `userEmail` from localStorage on every request, so seeding it before the first paint skips
 * the login form for tests that are not about logging in.
 */
export const signIn = async (page: Page, email: string): Promise<void> => {
  await page.addInitScript((value) => window.localStorage.setItem('userEmail', value), email);
};

/** `/api/clients/12` -> `GET /api/clients/{id}`: query strings and ids are noise here. */
const normalizeEndpoint = (method: string, rawUrl: string): string | null => {
  const url = new URL(rawUrl, apiOrigin);
  // Vite dev-serves the app from the UI origin; only API calls count as endpoints, and
  // static assets never do.
  if (!url.pathname.startsWith('/api/')) return null;
  if (/\.(js|mjs|css|map|png|jpe?g|svg|ico|woff2?)$/.test(url.pathname)) return null;
  const path = url.pathname.replace(/\/\d+(?=\/|$)/g, '/{id}').replace(/\/$/, '');
  return `${method.toUpperCase()} ${path || '/'}`;
};

/** Vite dev-serves unbundled modules, so `/src/pages/ClientsPage.tsx` maps straight to a source file. */
const toSourceFile = (rawUrl: string): string | null => {
  const { pathname } = new URL(rawUrl);
  if (!pathname.startsWith('/src/')) return null;
  return `frontend${pathname}`;
};

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'fetch'] as const;

/** Records calls made through the `request` fixture, which emits no events of its own. */
const observeRequestContext = (context: APIRequestContext, record: (endpoint: string) => void): APIRequestContext =>
  new Proxy(context, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      const method = METHODS.find((candidate) => candidate === property);
      if (typeof value !== 'function' || !method) {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (url: string, options?: { method?: string }) => {
        const verb = method === 'fetch' ? options?.method ?? 'GET' : method;
        const endpoint = normalizeEndpoint(verb, url);
        if (endpoint) record(endpoint);
        return (value as (...args: unknown[]) => unknown).call(target, url, options);
      };
    },
  }) as APIRequestContext;

export const test = base.extend<{ observe: void }>({
  request: async ({ request }, use) => {
    if (!COVERAGE_ENABLED) {
      await use(request);
      return;
    }
    await use(observeRequestContext(request, (endpoint) => observed.endpoints.add(endpoint)));
  },

  observe: [
    async ({ page }, use, testInfo) => {
      if (!COVERAGE_ENABLED) {
        await use();
        return;
      }

      observed = { routes: new Set<string>(), endpoints: new Set<string>(), sourceFiles: new Set<string>() };

      page.on('request', (request) => {
        const endpoint = normalizeEndpoint(request.method(), request.url());
        if (endpoint) observed.endpoints.add(endpoint);
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          const { pathname } = new URL(request.url());
          observed.routes.add(pathname.replace(/\/\d+$/, '/{id}'));
        }
      });

      await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false });

      await use();

      for (const entry of await page.coverage.stopJSCoverage()) {
        // The unnamed top-level range covers module evaluation, which happens for every
        // statically imported module. Only a named function running proves the code was used:
        // App.tsx imports all pages, so without this every test would claim every page.
        const executed = entry.functions.some(
          (fn) => fn.functionName !== '' && fn.ranges.some((range) => range.count > 0),
        );
        const sourceFile = executed ? toSourceFile(entry.url) : null;
        if (sourceFile) observed.sourceFiles.add(sourceFile);
      }

      const observation: TestObservation = {
        routes: [...observed.routes].sort(),
        endpoints: [...observed.endpoints].sort(),
        sourceFiles: [...observed.sourceFiles].sort(),
      };
      await testInfo.attach('impact-observation', {
        body: JSON.stringify(observation),
        contentType: 'application/json',
      });
    },
    { auto: true },
  ],
});

/** Per-worker scratch space; the `request` fixture cannot reach the `observe` fixture's scope. */
let observed = { routes: new Set<string>(), endpoints: new Set<string>(), sourceFiles: new Set<string>() };

export { expect };
