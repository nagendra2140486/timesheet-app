import { test, expect, signIn, uniqueEmail } from './fixtures';
import { apiUrl, asUser } from './helpers';

/**
 * The mandatory spec: listed in `impact.mandatory_specs`, so it runs on every PR regardless of
 * what changed. Authentication is the only control standing between an anonymous caller and
 * every tenant's timesheet data, so it is never selected out of a run.
 */
test.describe('authentication', () => {
  test('a new user can log in and lands on the dashboard', async ({ page }) => {
    const email = uniqueEmail('login');

    await page.goto('/login');
    await page.getByLabel('Email Address').fill(email);
    await page.getByRole('button', { name: 'Log In' }).click();

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
    // The API client reads this on every request; without it the session does not survive a reload.
    expect(await page.evaluate(() => window.localStorage.getItem('userEmail'))).toBe(email);
  });

  test('the session survives a reload', async ({ page }) => {
    const email = uniqueEmail('session');
    await signIn(page, email);

    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
    await expect(page).not.toHaveURL(/\/login$/);
  });

  test('an anonymous visitor to a protected route is sent to login', async ({ page }) => {
    await page.goto('/clients');

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('button', { name: 'Log In' })).toBeVisible();
    // The client list must not render behind the redirect.
    await expect(page.getByRole('heading', { name: 'Clients' })).toHaveCount(0);
  });

  test('logging out clears the session and protects the route again', async ({ page }) => {
    const email = uniqueEmail('logout');
    await signIn(page, email);
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();

    await page.getByRole('button', { name: /logout/i }).click();

    await expect(page).toHaveURL(/\/login$/);
    expect(await page.evaluate(() => window.localStorage.getItem('userEmail'))).toBeNull();
  });

  test('the login form reports a rejected email instead of failing silently', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email Address').fill('not-an-email');
    await page.getByRole('button', { name: 'Log In' }).click();

    await expect(page.getByRole('alert').filter({ hasText: /validation error|failed/i })).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });
});

/**
 * Asserted at the API rather than through the browser: these are the responses the server owes
 * a caller that never loads the app, which is exactly how the data would be attacked.
 */
test.describe('api access control', () => {
  const protectedEndpoints = ['/api/clients', '/api/work-entries', '/api/auth/me'];

  for (const path of protectedEndpoints) {
    test(`GET ${path} rejects a caller with no identity`, async ({ request }) => {
      const response = await request.get(apiUrl(path));

      expect(response.status()).toBe(401);
      expect(await response.json()).toMatchObject({ error: 'User email required in x-user-email header' });
    });
  }

  test('a malformed identity header is rejected, not trusted', async ({ request }) => {
    const response = await request.get(apiUrl('/api/clients'), { headers: asUser('not-an-email') });

    expect(response.status()).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'Invalid email format' });
  });

  test('login validates the email before touching the database', async ({ request }) => {
    const response = await request.post(apiUrl('/api/auth/login'), { data: { email: 'not-an-email' } });

    expect(response.status()).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'Validation error' });
  });

  test("one user cannot read another user's clients", async ({ request }) => {
    const owner = uniqueEmail('owner');
    const stranger = uniqueEmail('stranger');
    const created = await request.post(apiUrl('/api/clients'), {
      headers: asUser(owner),
      data: { name: `Tenant isolation ${Date.now()}` },
    });
    expect(created.status()).toBe(201);
    const { client } = (await created.json()) as { client: { id: number } };

    const listed = await request.get(apiUrl('/api/clients'), { headers: asUser(stranger) });
    expect(listed.status()).toBe(200);
    const { clients } = (await listed.json()) as { clients: { id: number }[] };
    expect(clients.map((item) => item.id)).not.toContain(client.id);

    // Nor by guessing the id directly.
    const direct = await request.get(apiUrl(`/api/clients/${client.id}`), { headers: asUser(stranger) });
    expect(direct.status()).toBe(404);
  });
});
