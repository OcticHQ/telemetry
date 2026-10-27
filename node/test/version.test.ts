import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { SDK_NAME, SDK_VERSION } from '../src/index.ts';

const manifest = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
) as { version: string };

/**
 * release-please bumps `package.json` and stamps `src/version.ts` in the same
 * commit, but nothing makes it do both — the `extra-files` entry is a line in a
 * config file and a typo there fails silently. This is the test that notices.
 *
 * It is worth more than it looks: the version travels on every span as
 * `octic.sdk.version`, so the two drifting apart means every customer's
 * telemetry reports a version that was never released.
 */
test('SDK_VERSION matches the package manifest', () => {
  assert.equal(SDK_VERSION, manifest.version);
});

test('SDK_VERSION is a plain semver triple', () => {
  assert.match(SDK_VERSION, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
});

test('SDK_NAME is the value the contract expects on the wire', () => {
  assert.equal(SDK_NAME, 'octichq-airlock-sdk-node');
});
