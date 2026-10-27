/**
 * `init()` handed a credential under the default `spool: { mode: 'only' }`.
 *
 * Nothing is sent in that mode, so the credential is unused. That is almost
 * always a consumer who meant to export over HTTP and did not know the default
 * changed, so it warns once, naming the option that would use it, and sends
 * nothing — not even a token exchange.
 *
 * A file to itself because init.ts latches on the first call and never re-runs
 * `setup()` — one effective `init()` per process is the budget.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { diag, DiagLogLevel, type DiagLogger } from '@opentelemetry/api';

import { withWorkflow } from '../src/annotations.ts';
import { init, type Telemetry } from '../src/index.ts';
import { fakeCollector, fakeTokenEndpoint, installContextManager } from './support/harness.ts';

installContextManager();

const warnings: string[] = [];
const capture: DiagLogger = {
  error: () => {},
  warn: (message, ...args) => warnings.push([message, ...args.map(String)].join(' ')),
  info: () => {},
  debug: () => {},
  verbose: () => {},
};

let collector: Awaited<ReturnType<typeof fakeCollector>>;
let issuer: Awaited<ReturnType<typeof fakeTokenEndpoint>>;
let telemetry: Telemetry;
let dir: string;

before(async () => {
  diag.setLogger(capture, DiagLogLevel.WARN);
  collector = await fakeCollector();
  issuer = await fakeTokenEndpoint();
  dir = await mkdtemp(join(tmpdir(), 'octic-spool-unused-auth-'));
  telemetry = init({
    endpoint: collector.url,
    auth: { kind: 'enrollmentToken', enrollmentToken: 'octic_et_test', tokenUrl: issuer.url },
    serviceName: 'init-unused-auth',
    spool: { dir },
  });
});

after(async () => {
  await telemetry.shutdown();
  await collector.close();
  await issuer.close();
  await rm(dir, { recursive: true, force: true });
  diag.disable();
});

describe('init() with a credential under spool-only', () => {
  it('warns once that the credential is unused', () => {
    const unused = warnings.filter(message => message.includes('`auth` is unused'));
    assert.equal(unused.length, 1, `warnings: ${warnings.join(' | ') || '(none)'}`);
    assert.match(unused[0] ?? '', /mode: 'fallback'/);
  });

  it('sends nothing, and exchanges no token', async () => {
    await withWorkflow({ name: 'chat-turn' }, async () => undefined);
    await telemetry.forceFlush();

    assert.equal(telemetry.spool?.mode, 'only');
    assert.equal(collector.requestCount(), 0, 'a span was sent');
    assert.equal(issuer.requestCount(), 0, 'a token was exchanged');
  });
});
