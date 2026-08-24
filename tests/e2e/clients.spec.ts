import { test, expect, signIn, uniqueEmail } from './fixtures';
import { apiUrl, asUser, createClient } from './helpers';

test.describe('client management', () => {
  test('a client created in the dialog appears in the list', async ({ page }) => {
    const email = uniqueEmail('client-create');
    const name = `Acme Industries ${Date.now()}`;
    await signIn(page, email);

    await page.goto('/clients');
    await expect(page.getByText('No clients found. Create your first client to get started.')).toBeVisible();

    await page.getByRole('button', { name: 'Add Client' }).click();
    await page.getByRole('dialog').getByLabel('Client Name').fill(name);
    await page.getByRole('dialog').getByLabel('Department').fill('Engineering');
    await page.getByRole('dialog').getByLabel('Email').fill('billing@acme.com');
    await page.getByRole('dialog').getByLabel('Description').fill('Platform retainer');
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();

    await expect(page.getByRole('dialog')).toBeHidden();
    const row = page.getByRole('row').filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Engineering');
    await expect(row).toContainText('billing@acme.com');
    await expect(row).toContainText('Platform retainer');
  });

  test('a client survives a reload, so it was persisted and not just rendered', async ({ page }) => {
    const email = uniqueEmail('client-persist');
    const name = `Persisted Client ${Date.now()}`;
    await signIn(page, email);

    await page.goto('/clients');
    await page.getByRole('button', { name: 'Add Client' }).click();
    await page.getByRole('dialog').getByLabel('Client Name').fill(name);
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('row').filter({ hasText: name })).toBeVisible();

    await page.reload();

    await expect(page.getByRole('row').filter({ hasText: name })).toBeVisible();
  });

  test('editing a client updates the row', async ({ page, request }) => {
    const email = uniqueEmail('client-edit');
    const client = await createClient(request, email, { name: `Before Rename ${Date.now()}`, department: 'Sales' });
    const renamed = `After Rename ${Date.now()}`;
    await signIn(page, email);

    await page.goto('/clients');
    const row = page.getByRole('row').filter({ hasText: client.name });
    await row.getByRole('button').first().click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Edit Client');
    // The dialog must arrive populated, or an edit silently becomes a rewrite.
    await expect(dialog.getByLabel('Client Name')).toHaveValue(client.name);
    await dialog.getByLabel('Client Name').fill(renamed);
    await dialog.getByLabel('Department').fill('Marketing');
    await dialog.getByRole('button', { name: 'Update' }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByRole('row').filter({ hasText: renamed })).toContainText('Marketing');
    await expect(page.getByRole('row').filter({ hasText: client.name })).toHaveCount(0);
  });

  test('deleting a client removes it after the confirmation', async ({ page, request }) => {
    const email = uniqueEmail('client-delete');
    const client = await createClient(request, email, { name: `Doomed Client ${Date.now()}` });
    await signIn(page, email);

    await page.goto('/clients');
    await expect(page.getByRole('row').filter({ hasText: client.name })).toBeVisible();

    page.once('dialog', (confirmation) => {
      expect(confirmation.message()).toContain(client.name);
      confirmation.accept();
    });
    await page.getByRole('row').filter({ hasText: client.name }).getByRole('button').last().click();

    await expect(page.getByRole('row').filter({ hasText: client.name })).toHaveCount(0);
    const remaining = await request.get(apiUrl('/api/clients'), { headers: asUser(email) });
    const { clients } = (await remaining.json()) as { clients: { id: number }[] };
    expect(clients.map((item) => item.id)).not.toContain(client.id);
  });

  test('dismissing the delete confirmation keeps the client', async ({ page, request }) => {
    const email = uniqueEmail('client-keep');
    const client = await createClient(request, email, { name: `Spared Client ${Date.now()}` });
    await signIn(page, email);

    await page.goto('/clients');
    page.once('dialog', (confirmation) => confirmation.dismiss());
    await page.getByRole('row').filter({ hasText: client.name }).getByRole('button').last().click();

    await expect(page.getByRole('row').filter({ hasText: client.name })).toBeVisible();
  });

  test('clearing every client requires the intent to be stated', async ({ request }) => {
    const email = uniqueEmail('client-clear');
    const client = await createClient(request, email, { name: `Bulk Client ${Date.now()}` });

    // A DELETE that lost its id must not be read as "delete everything".
    const unconfirmed = await request.delete(apiUrl('/api/clients'), { headers: asUser(email) });
    expect(unconfirmed.status()).toBe(400);
    const survived = await request.get(apiUrl(`/api/clients/${client.id}`), { headers: asUser(email) });
    expect(survived.status()).toBe(200);

    const confirmed = await request.delete(apiUrl('/api/clients?confirm=all'), { headers: asUser(email) });
    expect(confirmed.status()).toBe(200);
    const gone = await request.get(apiUrl(`/api/clients/${client.id}`), { headers: asUser(email) });
    expect(gone.status()).toBe(404);
  });

  test('the API rejects a client with no name', async ({ request }) => {
    const email = uniqueEmail('client-invalid');

    const response = await request.post(apiUrl('/api/clients'), { headers: asUser(email), data: { name: '' } });

    expect(response.status()).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'Validation error' });
  });

  test('the API rejects a malformed client email', async ({ request }) => {
    const email = uniqueEmail('client-bademail');

    const response = await request.post(apiUrl('/api/clients'), {
      headers: asUser(email),
      data: { name: 'Bad Email Client', email: 'nope' },
    });

    expect(response.status()).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'Validation error' });
  });
});
