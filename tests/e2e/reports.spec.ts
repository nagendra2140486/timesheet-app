import { test, expect, signIn, uniqueEmail } from './fixtures';
import { apiUrl, asUser, createClient, createWorkEntry, isoDate } from './helpers';

test.describe('reporting', () => {
  test('the dashboard totals reflect the entries just logged', async ({ page, request }) => {
    const email = uniqueEmail('dashboard');
    const client = await createClient(request, email, { name: `Summary Client ${Date.now()}` });
    await createWorkEntry(request, email, { clientId: client.id, hours: 5, date: isoDate(1) });
    await createWorkEntry(request, email, { clientId: client.id, hours: 2.5, date: isoDate() });
    await signIn(page, email);

    await page.goto('/dashboard');

    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
    // Totals are computed, so assert the arithmetic rather than the mere presence of a number.
    await expect(page.getByText('Total Clients').locator('..')).toContainText('1');
    await expect(page.getByText('Total Work Entries').locator('..')).toContainText('2');
    await expect(page.getByText('Total Hours').locator('..')).toContainText('7.5');
  });

  test("a client's report totals its hours and lists its entries", async ({ page, request }) => {
    const email = uniqueEmail('report');
    const client = await createClient(request, email, { name: `Report Client ${Date.now()}` });
    await createWorkEntry(request, email, { clientId: client.id, hours: 4, date: isoDate(3), description: 'Discovery' });
    await createWorkEntry(request, email, { clientId: client.id, hours: 1.5, date: isoDate(), description: 'Handover' });
    await signIn(page, email);

    await page.goto('/reports');
    await page.getByRole('combobox').click();
    await page.getByRole('option', { name: client.name }).click();

    await expect(page.getByText('Total Hours').locator('..')).toContainText('5.50');
    await expect(page.getByText('Total Entries').locator('..')).toContainText('2');
    await expect(page.getByText('Average Hours per Entry').locator('..')).toContainText('2.75');
    await expect(page.getByRole('row').filter({ hasText: 'Discovery' })).toContainText('4 hours');
    await expect(page.getByRole('row').filter({ hasText: 'Handover' })).toContainText('1.5 hours');
  });

  test('the report shows only the selected client, not every client', async ({ page, request }) => {
    const email = uniqueEmail('report-scope');
    const stamp = Date.now();
    const selected = await createClient(request, email, { name: `Selected ${stamp}` });
    const other = await createClient(request, email, { name: `Excluded ${stamp}` });
    await createWorkEntry(request, email, { clientId: selected.id, hours: 3, date: isoDate(), description: 'Counted' });
    await createWorkEntry(request, email, { clientId: other.id, hours: 8, date: isoDate(), description: 'Uncounted' });
    await signIn(page, email);

    await page.goto('/reports');
    await page.getByRole('combobox').click();
    await page.getByRole('option', { name: selected.name }).click();

    await expect(page.getByText('Total Hours').locator('..')).toContainText('3.00');
    await expect(page.getByRole('row').filter({ hasText: 'Uncounted' })).toHaveCount(0);
  });

  test('a client with no entries reports an empty state, not an error', async ({ page, request }) => {
    const email = uniqueEmail('report-empty');
    const client = await createClient(request, email, { name: `Idle Client ${Date.now()}` });
    await signIn(page, email);

    await page.goto('/reports');
    await page.getByRole('combobox').click();
    await page.getByRole('option', { name: client.name }).click();

    await expect(page.getByText('No work entries found for this client.')).toBeVisible();
    await expect(page.getByText('Total Hours').locator('..')).toContainText('0.00');
  });

  test('a user with no clients is prompted to create one', async ({ page }) => {
    const email = uniqueEmail('report-noclients');
    await signIn(page, email);

    await page.goto('/reports');

    await expect(page.getByText('You need to create at least one client before generating reports.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create Client' })).toBeVisible();
  });

  test('the CSV export downloads the entries as a file', async ({ page, request }) => {
    const email = uniqueEmail('csv');
    const client = await createClient(request, email, { name: `CsvClient${Date.now()}` });
    await createWorkEntry(request, email, { clientId: client.id, hours: 6, date: isoDate(), description: 'Exported' });
    await signIn(page, email);

    await page.goto('/reports');
    await page.getByRole('combobox').click();
    await page.getByRole('option', { name: client.name }).click();
    await expect(page.getByText('Total Hours').locator('..')).toContainText('6.00');

    const download = await Promise.race([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export as CSV' }).click().then(() => page.waitForEvent('download')),
    ]);

    expect(download.suggestedFilename()).toMatch(/\.csv$/);
  });

  test('the report API refuses a client the caller does not own', async ({ request }) => {
    const owner = uniqueEmail('report-owner');
    const stranger = uniqueEmail('report-stranger');
    const client = await createClient(request, owner, { name: `Private Client ${Date.now()}` });

    const response = await request.get(apiUrl(`/api/reports/client/${client.id}`), { headers: asUser(stranger) });

    expect(response.status()).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'Client not found' });
  });

  test('the report API rejects a non-numeric client id', async ({ request }) => {
    const email = uniqueEmail('report-badid');

    const response = await request.get(apiUrl('/api/reports/client/not-a-number'), { headers: asUser(email) });

    expect(response.status()).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'Invalid client ID' });
  });
});
