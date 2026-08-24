import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import type { TestObservation } from '../e2e/fixtures';

interface MappedTest extends TestObservation {
  file: string;
  title: string;
  status: TestResult['status'];
}

const REPO_ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.resolve(__dirname, '../coverage-map.json');

/**
 * Derives which backend source file serves which URL prefix by reading the mounts in
 * `backend/src/server.js`, so the mapping updates itself when a router is added or moved.
 *
 *   app.use('/api/clients', clientRoutes)  ->  /api/clients -> backend/src/routes/clients.js
 */
const backendOwners = (): Record<string, string> => {
  const serverPath = path.join(REPO_ROOT, 'backend/src/server.js');
  const source = readFileSync(serverPath, 'utf8');

  const imports = new Map<string, string>();
  for (const match of source.matchAll(/const (\w+) = require\('(\.[^']+)'\)/g)) {
    imports.set(match[1], `backend/src/${match[2].replace(/^\.\//, '')}.js`);
  }

  const owners: Record<string, string> = {};
  for (const match of source.matchAll(/app\.use\('([^']+)', (\w+)\)/g)) {
    const file = imports.get(match[2]);
    if (file) owners[match[1]] = file;
  }
  return owners;
};

/**
 * Writes `coverage-map.json`: for every test, the routes, endpoints and frontend source
 * files it exercised at runtime. Impact analysis joins a diff against this map.
 */
export default class CoverageMapReporter implements Reporter {
  private readonly tests: MappedTest[] = [];

  onTestEnd(test: TestCase, result: TestResult): void {
    const attachment = result.attachments.find((item) => item.name === 'impact-observation');
    if (!attachment?.body) return;
    const observation = JSON.parse(attachment.body.toString()) as TestObservation;
    this.tests.push({
      file: path.relative(path.resolve(__dirname, '../e2e'), test.location.file),
      title: test.titlePath().slice(3).join(' > '),
      status: result.status,
      ...observation,
    });
  }

  onEnd(result: FullResult): void {
    if (!this.tests.length) return;

    const tests = this.tests.sort((a, b) => `${a.file}${a.title}`.localeCompare(`${b.file}${b.title}`));
    const index = (key: 'routes' | 'endpoints' | 'sourceFiles'): Record<string, string[]> => {
      const reversed: Record<string, string[]> = {};
      for (const test of tests) {
        for (const value of test[key]) {
          (reversed[value] ??= []).push(`${test.file} > ${test.title}`);
        }
      }
      return Object.fromEntries(Object.entries(reversed).sort(([a], [b]) => a.localeCompare(b)));
    };

    writeFileSync(
      OUTPUT,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          // Recorded from a full run; a partial run would produce a misleadingly sparse map.
          complete: result.status === 'passed',
          totalTests: tests.length,
          backendOwners: backendOwners(),
          tests,
          byEndpoint: index('endpoints'),
          bySourceFile: index('sourceFiles'),
          byRoute: index('routes'),
        },
        null,
        2,
      )}\n`,
    );
    console.log(`coverage-map.json: ${tests.length} tests observed`);
  }
}
