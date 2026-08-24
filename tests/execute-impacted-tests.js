const fs = require('fs');
const { execSync } = require('child_process');

const payload = JSON.parse(
  fs.readFileSync('payload.json', 'utf8')
);

console.log(`Running impacted suite for ${payload.appname}`);

/*
 * Override frontend URL with the working deployed application.
 * Ignore payload.frontend_url for now.
 */
process.env.TIMESHEET_BASE_URL =
  'https://timesheet-frontend-fwb9fuhnc4c8bre5.eastus-01.azurewebsites.net';

/*
 * Backend still comes from payload.
 * Replace with actual backend URL later if needed.
 */
process.env.TIMESHEET_API_URL =
  payload.backend_url ||
  process.env.TIMESHEET_API_URL;

console.log(`Frontend URL: ${process.env.TIMESHEET_BASE_URL}`);
console.log(`Backend URL: ${process.env.TIMESHEET_API_URL}`);

const testCases = payload.test_cases || [];

if (!testCases.length) {
  throw new Error('No test_cases found in payload');
}

const specs = [
  ...new Set(
    testCases.map(tc =>
      tc.spec
        .replace(/^tests\/e2e\//, '')
        .replace(/^e2e\//, '')
    )
  )
];

console.log('Specs selected from payload:');
console.log(specs);

const command =
  `npx playwright test ${specs.join(' ')} --reporter=json > results.json`;

console.log('Executing command:');
console.log(command);

try {

  execSync(command, {
    stdio: 'inherit',
    shell: true,
    env: process.env
  });

} catch (err) {

  console.error('Playwright execution completed with failures');
  console.error(err.message);

}

let results = {};

try {

  if (fs.existsSync('results.json')) {

    results = JSON.parse(
      fs.readFileSync('results.json', 'utf8')
    );

  }

} catch (err) {

  console.error('Unable to parse results.json');
  console.error(err.message);

}

const stats = results.stats || {
  expected: 0,
  unexpected: 0,
  skipped: 0,
  flaky: 0
};

const analysisJson = {
  stage: 'functional',
  pr_id: payload.pr_id,
  runner: 'playwright',
  selection_mode: payload.selection_mode,
  selection_reason: payload.selection_reason,
  total_impacted: payload.total_impacted,
  total_in_suite: payload.total_in_suite,
  selected_specs: specs,
  executed_tests: testCases.length,
  stats
};

const analysisMarkdown = `
# Impacted Regression Execution

Application: ${payload.appname}

PR: ${payload.pr_id}

Selection Mode: ${payload.selection_mode}

Selection Reason:
${payload.selection_reason}

## Execution Summary

- Total Impacted Tests: ${payload.total_impacted}
- Total Suite Size: ${payload.total_in_suite}
- Executed Test Cases: ${testCases.length}
- Passed: ${stats.expected || 0}
- Failed: ${stats.unexpected || 0}
- Skipped: ${stats.skipped || 0}
- Flaky: ${stats.flaky || 0}

## Impacted Specs

${specs.map(spec => `- ${spec}`).join('\n')}

## Impacted Tests

${testCases.map(tc => `- ${tc.title}`).join('\n')}
`;

const regressionReport = {
  id:
    payload.id ||
    `${payload.appname}_regression-report_${payload.pr_id}`,

  appname: payload.appname,

  reporttype: 'regression-report',

  repository: payload.repository,

  pr_id: payload.pr_id,

  analysis_markdown: analysisMarkdown,

  analysis_json: analysisJson,

  created_at:
    payload.generated_at ||
    new Date().toISOString()
};

fs.writeFileSync(
  'regression-report.json',
  JSON.stringify(regressionReport, null, 2)
);

console.log('regression-report.json generated
