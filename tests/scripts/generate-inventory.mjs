/**
 * Regenerates spec-inventory.json — the closed vocabulary of test names that automated
 * test-selection reads. Run `npm run inventory` after adding, renaming or tagging a test.
 *
 * Uses `playwright test --list`, so no services or browsers need to be running.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(testsDir, 'spec-inventory.json');

const listed = JSON.parse(
  execFileSync('npx', ['playwright', 'test', '--list', '--reporter=json'], {
    cwd: testsDir,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  }),
);

/** Playwright nests describe blocks, so collect specs depth-first. */
const collectSpecs = (suite, describePath = []) => {
  const nested = describePath.concat(suite.title && suite.title !== suite.file ? [suite.title] : []);
  return [
    ...(suite.specs ?? []).map((spec) => ({
      title: spec.title,
      describe: nested.join(' > '),
      line: spec.line,
      tags: spec.tags ?? [],
    })),
    ...(suite.suites ?? []).flatMap((child) => collectSpecs(child, nested)),
  ];
};

const specs = (listed.suites ?? [])
  .map((suite) => ({
    file: suite.file,
    tests: collectSpecs(suite).sort((a, b) => a.line - b.line),
  }))
  .sort((a, b) => a.file.localeCompare(b.file));

const inventory = {
  schemaVersion: 1,
  // Intentionally no timestamp: the file must only change when the tests do, so a
  // regenerate-and-diff check can detect staleness.
  playwrightVersion: listed.config?.version ?? null,
  projects: (listed.config?.projects ?? []).map((project) => project.name),
  totalTests: specs.reduce((total, spec) => total + spec.tests.length, 0),
  specs,
};

writeFileSync(outputPath, `${JSON.stringify(inventory, null, 2)}\n`);
console.log(`spec-inventory.json: ${inventory.totalTests} tests across ${specs.length} spec files`);
