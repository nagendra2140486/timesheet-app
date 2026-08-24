import { test, expect, signIn, uniqueEmail } from './fixtures';
import { apiUrl, asUser, createClient, createWorkEntry, displayedDate, isoDate, pickerDigits } from './helpers';

test.describe('work entry logging', () => {
  test('an entry logged against a client appears with its hours', async ({ page, request }) => {
    const email = uniqueEmail('entry-create');
    const client = await createClient(request, email, { name: `Logging Client ${Date.now()}` });
    const date = isoDate(2);
    await signIn(page, email);

    await page.goto('/work-entries');
    await page.getByRole('button', { name: 'Add Work Entry' }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('combobox').click();
    await page.getByRole('option', { name: client.name }).click();
    await dialog.getByLabel('Hours').fill('7.5');
    // Typed rather than filled, and deliberately not today's date, so a broken picker cannot pass
    // on the value it defaults to.
    await dialog.getByRole('group', { name: 'Date' }).click();
    await page.keyboard.type(pickerDigits(date));
    await dialog.getByLabel('Description').fill('Sprint planning and reviews');
    await dialog.getByRole('button', { name: 'Create' }).click();

    await expect(dialog).toBeHidden();
    const row = page.getByRole('row').filter({ hasText: client.name });
    await expect(row).toContainText('7.5 hours');
    await expect(row).toContainText('Sprint planning and reviews');
    await expect(row).toContainText(displayedDate(date));
  });

  test('editing an entry updates its hours', async ({ page, request }) => {
    const email = uniqueEmail('entry-edit');
    const client = await createClient(request, email, { name: `Correction Client ${Date.now()}` });
    await createWorkEntry(request, email, { clientId: client.id, hours: 3, date: isoDate(1) });
    await signIn(page, email);

    await page.goto('/work-entries');
    const row = page.getByRole('row').filter({ hasText: client.name });
    await expect(row).toContainText('3 hours');
    await row.getByRole('button').first().click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Edit Work Entry');
    await expect(dialog.getByLabel('Hours')).toHaveValue('3');
    await dialog.getByLabel('Hours').fill('6.25');
    await dialog.getByRole('button', { name: 'Update' }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByRole('row').filter({ hasText: client.name })).toContainText('6.25 hours');
  });

  test('deleting an entry removes it from the list and the API', async ({ page, request }) => {
    const email = uniqueEmail('entry-delete');
    const client = await createClient(request, email, { name: `Deletion Client ${Date.now()}` });
    const entry = await createWorkEntry(request, email, { clientId: client.id, hours: 2, date: isoDate() });
    await signIn(page, email);

    await page.goto('/work-entries');
    const row = page.getByRole('row').filter({ hasText: client.name });
    await expect(row).toBeVisible();

    page.once('dialog', (confirmation) => confirmation.accept());
    await row.getByRole('button').last().click();

    await expect(page.getByRole('row').filter({ hasText: client.name })).toHaveCount(0);
    const check = await request.get(apiUrl(`/api/work-entries/${entry.id}`), { headers: asUser(email) });
    expect(check.status()).toBe(404);
  });

  test('entries for several clients are listed together', async ({ page, request }) => {
    const email = uniqueEmail('entry-multi');
    const stamp = Date.now();
    const first = await createClient(request, email, { name: `Multi One ${stamp}` });
    const second = await createClient(request, email, { name: `Multi Two ${stamp}` });
    await createWorkEntry(request, email, { clientId: first.id, hours: 4, date: isoDate(2) });
    await createWorkEntry(request, email, { clientId: second.id, hours: 1.5, date: isoDate() });
    await signIn(page, email);

    await page.goto('/work-entries');

    await expect(page.getByRole('row').filter({ hasText: first.name })).toContainText('4 hours');
    await expect(page.getByRole('row').filter({ hasText: second.name })).toContainText('1.5 hours');
  });

  test('the API rejects more hours than exist in a day', async ({ request }) => {
    const email = uniqueEmail('entry-hours');
    const client = await createClient(request, email, { name: `Overtime Client ${Date.now()}` });

    const response = await request.post(apiUrl('/api/work-entries'), {
      headers: asUser(email),
      data: { clientId: client.id, hours: 25, date: isoDate() },
    });

    expect(response.status()).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'Validation error' });
  });

  test('the API rejects zero or negative hours', async ({ request }) => {
    const email = uniqueEmail('entry-zero');
    const client = await createClient(request, email, { name: `Zero Client ${Date.now()}` });

    for (const hours of [0, -3]) {
      const response = await request.post(apiUrl('/api/work-entries'), {
        headers: asUser(email),
        data: { clientId: client.id, hours, date: isoDate() },
      });
      expect(response.status(), `hours=${hours}`).toBe(400);
    }
  });

  test('the API rejects a malformed date', async ({ request }) => {
    const email = uniqueEmail('entry-date');
    const client = await createClient(request, email, { name: `Bad Date Client ${Date.now()}` });

    const response = await request.post(apiUrl('/api/work-entries'), {
      headers: asUser(email),
      data: { clientId: client.id, hours: 2, date: 'yesterday' },
    });

    expect(response.status()).toBe(400);
  });

  test("an entry cannot be logged against another user's client", async ({ request }) => {
    const owner = uniqueEmail('entry-owner');
    const stranger = uniqueEmail('entry-stranger');
    const client = await createClient(request, owner, { name: `Guarded Client ${Date.now()}` });

    const response = await request.post(apiUrl('/api/work-entries'), {
      headers: asUser(stranger),
      data: { clientId: client.id, hours: 2, date: isoDate() },
    });

    expect(response.status()).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'Client not found or does not belong to user' });
  });
});
