import { check, group, sleep } from 'k6';
import http from 'k6/http';
import { API_URL, headers, newUserEmail, trends, uniqueSuffix } from './lib/config.js';

/**
 * Critical-path performance run for the timesheet app: auto-provisioned login, client
 * management, work-entry logging, and report generation/export, ending on cleanup.
 *
 * Deliberately a single virtual user for five minutes — this is a latency baseline for the app,
 * not a stress test.
 *
 * Rate limiting: the backend's default limiter is 100 requests / 15 min per IP
 * (backend/src/server.js), shared across every VU hitting it from the same address. Each
 * iteration below makes ~13 requests, so raising VUs or duration meaningfully requires the
 * target to run with a higher RATE_LIMIT_MAX — devin/config.yaml already sets this to 100000 for
 * the functional Playwright suite for the same reason. Without it you'll see 429s reported as
 * failed checks, not as a real latency regression.
 */
export const options = {
  vus: 1,
  duration: '5m',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    'journey_auth_ms': ['p(95)<300'],
    'journey_clients_list_ms': ['p(95)<300'],
    'journey_client_create_ms': ['p(95)<400'],
    'journey_client_detail_ms': ['p(95)<300'],
    'journey_work_entry_create_ms': ['p(95)<400'],
    'journey_work_entries_list_ms': ['p(95)<400'],
    'journey_work_entry_update_ms': ['p(95)<400'],
    'journey_report_ms': ['p(95)<500'],
    // CSV/PDF export writes a temp file (CSV) or streams a generated document (PDF) — sized
    // above the plain CRUD paths above.
    'journey_export_csv_ms': ['p(95)<800'],
    'journey_export_pdf_ms': ['p(95)<1000'],
    'journey_cleanup_ms': ['p(95)<400'],
  },
};

// Fails the run fast if the target isn't up, instead of reporting a dead environment as a wall
// of latency failures.
export function setup() {
  const health = http.get(`${API_URL}/health`, { tags: { name: 'GET /health' } });
  if (health.status !== 200) {
    throw new Error(`Environment not reachable: GET /health returned ${health.status}`);
  }
}

const ok = (response, name, expected = [200]) =>
  check(response, {
    [`${name} -> ${expected.join('/')}`]: (r) => expected.includes(r.status),
  });

export default function () {
  const email = newUserEmail();
  const params = { headers: headers(email) };
  let clientId;
  let workEntryId;

  group('01 authenticate', () => {
    // A fresh email is always a 201 (user created) here; /login also doubles as the app's own
    // "sign in or sign up" entry point.
    const login = http.post(
      `${API_URL}/api/auth/login`,
      JSON.stringify({ email }),
      { ...params, tags: { name: 'POST /api/auth/login' } },
    );
    ok(login, 'login', [200, 201]);
    trends.auth.add(login.timings.duration);

    const me = http.get(`${API_URL}/api/auth/me`, { ...params, tags: { name: 'GET /api/auth/me' } });
    ok(me, 'current user');
    trends.auth.add(me.timings.duration);
  });
  sleep(1);

  group('02 browse clients', () => {
    const list = http.get(`${API_URL}/api/clients`, { ...params, tags: { name: 'GET /api/clients' } });
    ok(list, 'clients list');
    trends.clientsList.add(list.timings.duration);
  });
  sleep(1);

  group('03 create client', () => {
    const created = http.post(
      `${API_URL}/api/clients`,
      JSON.stringify({
        name: `k6 Client ${uniqueSuffix()}`,
        description: 'Created during a k6 performance baseline run.',
        department: 'QA',
        email: `client-${uniqueSuffix()}@example.com`,
      }),
      { ...params, tags: { name: 'POST /api/clients' } },
    );
    ok(created, 'create client', [201]);
    trends.clientCreate.add(created.timings.duration);
    clientId = created.json('client.id');

    if (clientId) {
      const detail = http.get(`${API_URL}/api/clients/${clientId}`, {
        ...params,
        tags: { name: 'GET /api/clients/:id' },
      });
      ok(detail, 'client detail');
      trends.clientDetail.add(detail.timings.duration);
    }
  });
  sleep(1);

  group('04 log work entries', () => {
    if (!clientId) return;

    const today = new Date().toISOString().slice(0, 10);
    const created = http.post(
      `${API_URL}/api/work-entries`,
      JSON.stringify({
        clientId,
        hours: 2.5,
        description: `k6 baseline entry ${uniqueSuffix()}`,
        date: today,
      }),
      { ...params, tags: { name: 'POST /api/work-entries' } },
    );
    ok(created, 'create work entry', [201]);
    trends.workEntryCreate.add(created.timings.duration);
    workEntryId = created.json('workEntry.id');

    const list = http.get(`${API_URL}/api/work-entries`, {
      ...params,
      tags: { name: 'GET /api/work-entries' },
    });
    ok(list, 'work entries list');
    trends.workEntriesList.add(list.timings.duration);

    const byClient = http.get(`${API_URL}/api/work-entries?clientId=${clientId}`, {
      ...params,
      tags: { name: 'GET /api/work-entries?clientId' },
    });
    ok(byClient, 'work entries by client');
    trends.workEntriesList.add(byClient.timings.duration);
  });
  sleep(1);

  group('05 update work entry', () => {
    if (!workEntryId) return;

    const updated = http.put(
      `${API_URL}/api/work-entries/${workEntryId}`,
      JSON.stringify({ hours: 3, description: `k6 baseline entry (revised) ${uniqueSuffix()}` }),
      { ...params, tags: { name: 'PUT /api/work-entries/:id' } },
    );
    ok(updated, 'update work entry');
    trends.workEntryUpdate.add(updated.timings.duration);
  });
  sleep(1);

  group('06 client report', () => {
    if (!clientId) return;

    const report = http.get(`${API_URL}/api/reports/client/${clientId}`, {
      ...params,
      tags: { name: 'GET /api/reports/client/:id' },
    });
    ok(report, 'client report');
    trends.report.add(report.timings.duration);
  });
  sleep(1);

  group('07 report exports', () => {
    if (!clientId) return;

    const csv = http.get(`${API_URL}/api/reports/export/csv/${clientId}`, {
      ...params,
      tags: { name: 'GET /api/reports/export/csv/:id' },
    });
    ok(csv, 'csv export');
    trends.exportCsv.add(csv.timings.duration);

    const pdf = http.get(`${API_URL}/api/reports/export/pdf/${clientId}`, {
      ...params,
      tags: { name: 'GET /api/reports/export/pdf/:id' },
    });
    ok(pdf, 'pdf export');
    trends.exportPdf.add(pdf.timings.duration);
  });
  sleep(1);

  group('08 cleanup', () => {
    // Each iteration's tenant is unique anyway, but there's no reason to leave garbage behind
    // in a long run against the in-memory database.
    if (workEntryId) {
      const deletedEntry = http.del(`${API_URL}/api/work-entries/${workEntryId}`, null, {
        ...params,
        tags: { name: 'DELETE /api/work-entries/:id' },
      });
      ok(deletedEntry, 'delete work entry');
      trends.cleanup.add(deletedEntry.timings.duration);
    }

    if (clientId) {
      const deletedClient = http.del(`${API_URL}/api/clients/${clientId}`, null, {
        ...params,
        tags: { name: 'DELETE /api/clients/:id' },
      });
      ok(deletedClient, 'delete client');
      trends.cleanup.add(deletedClient.timings.duration);
    }
  });
  sleep(1);
}
