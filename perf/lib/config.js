import { Trend } from 'k6/metrics';

/**
 * Backend base URL. Named the same as the functional suite's env var (TIMESHEET_API_URL, see
 * devin/config.yaml) so the same deployed URL can be reused for both stages without translation.
 */
export const API_URL = (__ENV.TIMESHEET_API_URL || __ENV.API_URL || 'http://localhost:3001').replace(/\/$/, '');

/**
 * Auth here is a single `x-user-email` header — there's no login token or session cookie, and
 * the auth middleware auto-creates the user on first sight (backend/src/middleware/auth.js). A
 * fresh email per iteration gives every iteration its own tenant, isolated from every other
 * VU/iteration, the same way the Playwright e2e suite isolates itself.
 */
export const newUserEmail = () => `k6-${__VU}-${__ITER}-${Date.now()}@example.com`;

export const headers = (email) => ({
  'content-type': 'application/json',
  'x-user-email': email,
});

/** Unique-ish string for names/descriptions so repeated runs never collide on "uniqueness"
 *  constraints and so it's easy to spot which iteration's data you're looking at while debugging. */
export const uniqueSuffix = () => `${__VU}-${__ITER}-${Math.random().toString(36).slice(2, 8)}`;

export const trends = {
  auth: new Trend('journey_auth_ms', true),
  clientsList: new Trend('journey_clients_list_ms', true),
  clientCreate: new Trend('journey_client_create_ms', true),
  clientDetail: new Trend('journey_client_detail_ms', true),
  workEntryCreate: new Trend('journey_work_entry_create_ms', true),
  workEntriesList: new Trend('journey_work_entries_list_ms', true),
  workEntryUpdate: new Trend('journey_work_entry_update_ms', true),
  report: new Trend('journey_report_ms', true),
  exportCsv: new Trend('journey_export_csv_ms', true),
  exportPdf: new Trend('journey_export_pdf_ms', true),
  cleanup: new Trend('journey_cleanup_ms', true),
};
