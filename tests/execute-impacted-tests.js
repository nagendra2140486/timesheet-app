const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const payload = JSON.parse(
  fs.readFileSync('payload.json', 'utf8')
);

console.log(`Running impacted suite for ${payload.appname}`);

const testCases = payload.test_cases || [];

if (!testCases.length) {
  throw new Error('No test_cases found in payload');
}

/*
 * Ensure attachments folder exists
 */
fs.mkdirSync('attachments', {
  recursive: true
});

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
 * Extract Playwright test titles
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
    title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  )
  .join('|');

console.log('Generated grep pattern:');
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
 * Read Playwright results
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
 * Copy all failure screenshots
 */
const screenshotMap = {};

try {

  const screenshots = execSync(
    'find test-results -name "*.png" -type f',
    {
      encoding: 'utf8',
      shell: true
    }
  )
    .split('\n')
    .filter(Boolean);

  screenshots.forEach(file => {

    const folder =
      path.basename(
        path.dirname(file)
      );

    const targetFile =
      `${folder}.png`;

    const targetPath =
      path.join(
        'attachments',
        targetFile
      );

    fs.copyFileSync(
      file,
      targetPath
    );

    screenshotMap[folder] =
      targetPath.replace(/\\/g, '/');
  });

} catch (err) {

  console.log(
    'No screenshots available'
  );

}

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
                test.status === 'unexpected'
            );

          if (failed) {

            let screenshot = null;

            const possible =
              Object.values(
                screenshotMap
              );

            if (possible.length) {
              screenshot =
                possible.shift();
            }

            failures.push({
              test: spec.title,
              attribution:
                'test_failure',
              screenshot
            });

          }
        }
      }

      if (suite.suites) {
        walkSuites(
          suite.suites
        );
      }
    }
  };

  walkSuites(results.suites);

}

/*
 * Analysis JSON
 */
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

/*
 * Markdown
 */
const analysisMarkdown = `
# Functional Execution — ${payload.appname} PR #${payload.pr_id}

The Impact Gap Analyzer identified ${
payload.total_impacted || testCases.length
}
impacted test cases from a regression suite containing
${
payload.total_in_suite || 'N/A'
}
total automated tests.

## Execution Summary

| Metric | Result |
| --- | --- |
| Impacted Tests Selected | ${
payload.total_impacted || testCases.length
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
## Failures, and what each is attributable to

| Test | Attribution | Screenshot |
| --- | --- | --- |
${failures
.map(
f =>
`| ${f.test} | ${f.attribution} | ${f.screenshot || 'N/A'} |`
)
.join('\n')}

The impacted failures should be reviewed to determine whether they represent application regressions, environment issues, deployment differences, or data setup problems.
`
: `
## Functional Findings

All impacted test cases completed successfully.

No impacted test failures were observed during execution.
`
}

## Conclusion

Only impacted test cases selected by the impact analysis engine were executed.

Execution completed with:

- Executed: ${actualExecuted}
- Passed: ${stats.expected || 0}
- Failed: ${stats.unexpected || 0}

${
(stats.unexpected || 0) > 0
? 'One or more impacted test cases failed and require investigation.'
: 'No functional regressions were detected within the impacted scope.'
}

<!-- prqe-verdict
${JSON.stringify({
stage: 'functional',
deployed: {
executed: actualExecuted,
passed: stats.expected || 0,
failed: stats.unexpected || 0
}
})}
-->
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
