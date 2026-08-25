const fs = require('fs');
const { execSync } = require('child_process');

const payload = JSON.parse(
  fs.readFileSync('payload.json', 'utf8')
);

console.log(
  `Running impacted suite for ${payload.appname}`
);

/*
 * Timesheet UAT deployment
 */
process.env.TIMESHEET_BASE_URL =
  'https://qea-timesheet-uat-ayfch9f0ehhwg6fp.canadacentral-01.azurewebsites.net';

process.env.TIMESHEET_API_URL =
  'https://qea-timesheet-uat-ayfch9f0ehhwg6fp.canadacentral-01.azurewebsites.net';

console.log(
  `TIMESHEET_BASE_URL=${process.env.TIMESHEET_BASE_URL}`
);

console.log(
  `TIMESHEET_API_URL=${process.env.TIMESHEET_API_URL}`
);

const testCases = payload.test_cases || [];

if (!testCases.length) {
  throw new Error(
    'No test_cases found in payload'
  );
}

/*
 * Impacted specs
 */
const specs = [
  ...new Set(
    testCases.map(tc =>
      tc.spec
        .replace(/^tests\/e2e\//, '')
        .replace(/^e2e\//, '')
    )
  )
];

console.log('Selected specs:');
console.log(specs);

/*
 * Extract test title
 *
 * Example:
 * authentication > login
 * ->
 * login
 */
const impactedTitles = testCases.map(tc => {
  const parts = tc.title.split('>');
  return parts[parts.length - 1].trim();
});

console.log('Impacted test titles:');
console.log(impactedTitles);

/*
 * Build grep pattern
 */
const grepPattern = impactedTitles
  .map(title =>
    title.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&'
    )
  )
  .join('|');

console.log(
  'Generated grep pattern:'
);
console.log(grepPattern);

/*
 * Execute only impacted tests
 */
const command =
  `npx playwright test ${specs.join(' ')} --grep "${grepPattern}" --reporter=json > results.json`;

console.log('Executing command:');
console.log(command);

try {

  execSync(command, {
    stdio: 'inherit',
    shell: true,
    env: process.env
  });

} catch (err) {

  console.error(
    'Playwright execution completed with failures'
  );

  console.error(err.message);

}

/*
 * Read results
 */
let results = {};

try {

  if (fs.existsSync('results.json')) {

    results = JSON.parse(
      fs.readFileSync(
        'results.json',
        'utf8'
      )
    );

  }

} catch (err) {

  console.error(
    'Unable to parse results.json'
  );

  console.error(err.message);

}

const stats =
  results.stats || {
    expected: 0,
    unexpected: 0,
    skipped: 0,
    flaky: 0
  };

const actualExecuted =
  (stats.expected || 0) +
  (stats.unexpected || 0) +
  (stats.skipped || 0) +
  (stats.flaky || 0);

/*
 * Failure collection
 */
const failures = [];

if (Array.isArray(results.suites)) {

  const walkSuites = suites => {

    for (const suite of suites) {

      if (suite.specs) {

        for (const spec of suite.specs) {

          const failed =
            spec.tests?.some(
              test =>
                test.status ===
                'unexpected'
            );

          if (failed) {

            failures.push({
              test: spec.title,
              attribution:
                'test_failure'
            });

          }

        }

      }

      if (suite.suites) {
        walkSuites(suite.suites);
      }

    }

  };

  walkSuites(results.suites);

}

const analysisJson = {
  stage: 'functional',

  pr_id: payload.pr_id,

  runner: 'playwright',

  impacted_analysis: {
    total_impacted:
      payload.total_impacted ||
      testCases.length,

    suite_size:
      payload.total_in_suite,

    selection_mode:
      payload.selection_mode,

    selection_reason:
      payload.selection_reason
  },

  deployed: {
    target:
      process.env.TIMESHEET_BASE_URL,

    executed:
      actualExecuted,

    passed:
      stats.expected || 0,

    failed:
      stats.unexpected || 0
  },

  executed_tests:
    testCases.map(tc => ({
      title: tc.title,
      spec: tc.spec
    })),

  failures
};

const analysisMarkdown = `
# Functional Execution — ${payload.appname} PR #${payload.pr_id}

The Impact Gap Analyzer selected ${
  payload.total_impacted ||
  testCases.length
} impacted test cases from a regression suite containing ${
  payload.total_in_suite || 'N/A'
} total tests.

## Execution Summary

| Metric | Result |
| --- | --- |
| Impacted Tests Selected | ${
  payload.total_impacted ||
  testCases.length
} |
| Tests Executed | ${actualExecuted} |
| Passed | ${stats.expected || 0} |
| Failed | ${stats.unexpected || 0} |

## Impact Selection

Selection Mode:
${payload.selection_mode}

Selection Reason:
${payload.selection_reason}

## Executed Impacted Tests

${testCases
  .map(tc => `- ${tc.title}`)
  .join('\n')}

${
failures.length
? `
## Failures

| Test | Attribution |
| --- | --- |
${failures
  .map(
    f =>
      `| ${f.test} | ${f.attribution} |`
  )
  .join('\n')}
`
: `
## Functional Findings

All impacted test cases completed successfully.

No impacted test failures were observed.
`
}

## Conclusion

Only impacted test cases identified by the Impact Gap Analyzer were executed.

Execution completed with:

- Executed: ${actualExecuted}
- Passed: ${stats.expected || 0}
- Failed: ${stats.unexpected || 0}

${
(stats.unexpected || 0) > 0
? 'One or more impacted tests failed and require investigation.'
: 'No functional regressions were detected within the impacted scope.'
}
`;

const regressionReport = {
  id:
    payload.id ||
    `${payload.appname}_regression-report_${payload.pr_id}`,

  appname:
    payload.appname,

  reporttype:
    'regression-report',

  repository:
    payload.repository,

  pr_id:
    payload.pr_id,

  analysis_markdown:
    analysisMarkdown,

  analysis_json:
    analysisJson,

  created_at:
    payload.generated_at ||
    new Date().toISOString()
};

fs.writeFileSync(
  'regression-report.json',
  JSON.stringify(
    regressionReport,
    null,
    2
  )
);

console.log(
  'regression-report.json generated successfully'
);
