import type { APIRequestContext } from '@playwright/test';
import { API_URL } from '../playwright.config';

export const apiUrl = (path: string): string => `${API_URL.replace(/\/$/, '')}${path}`;

export const asUser = (email: string) => ({ 'x-user-email': email });

/**
 * A 429 is an environment problem, not a defect: the backend rate-limits per IP, and a whole
 * suite runs from one. Naming it keeps a throttled run from being reported as a regression —
 * raise `RATE_LIMIT_MAX` on the target instead.
 */
const describeFailure = (status: number, body: string): string =>
  status === 429 ? 'rate limited by the target (raise RATE_LIMIT_MAX)' : `${status} ${body}`;

export interface CreatedClient {
  id: number;
  name: string;
}

/**
 * Seeds data through the API rather than the UI. A journey that asserts reporting should fail
 * when reporting breaks, not when the client dialog does, so only the behaviour under test is
 * driven through the browser.
 */
export const createClient = async (
  request: APIRequestContext,
  email: string,
  fields: { name: string; department?: string; email?: string; description?: string },
): Promise<CreatedClient> => {
  const response = await request.post(apiUrl('/api/clients'), { headers: asUser(email), data: fields });
  if (!response.ok()) throw new Error(`client setup failed: ${describeFailure(response.status(), await response.text())}`);
  const { client } = (await response.json()) as { client: CreatedClient };
  return client;
};

export const createWorkEntry = async (
  request: APIRequestContext,
  email: string,
  fields: { clientId: number; hours: number; date: string; description?: string },
): Promise<{ id: number }> => {
  const response = await request.post(apiUrl('/api/work-entries'), { headers: asUser(email), data: fields });
  if (!response.ok()) {
    throw new Error(`work entry setup failed: ${describeFailure(response.status(), await response.text())}`);
  }
  const { workEntry } = (await response.json()) as { workEntry: { id: number } };
  return workEntry;
};

/** `2026-07-30` — the date input's format and the API's `date` field agree on ISO dates. */
export const isoDate = (daysAgo = 0): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
};

/**
 * MUI's DatePicker renders one input per date section rather than a single fillable textbox, so a
 * date is entered by typing digits into the focused field: `MMDDYYYY`.
 */
export const pickerDigits = (iso: string): string => {
  const [year, month, day] = iso.split('-');
  return `${month}${day}${year}`;
};

/** How the app renders a stored ISO date in a table cell: `toLocaleDateString()` under en-US. */
export const displayedDate = (iso: string): string => {
  const [year, month, day] = iso.split('-').map(Number);
  return `${month}/${day}/${year}`;
};
