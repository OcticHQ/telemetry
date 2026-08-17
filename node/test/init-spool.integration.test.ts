/**
 * `init()` with no credential — the arrangement a consumer lands in by
 * accident, and the one the spool exists for.
 *
 * A container whose secret was not mounted, or a token exchange that has not
 * succeeded yet, leaves `apiKey` undefined. The old behaviour was to send
 * `Bearer undefined`, collect a 401 per batch, and lose everything with only a
 * global-error-handler line to show for it. This asserts the replacement:
 * `init()` returns normally, the process makes no HTTP request it cannot
 * authenticate, every batch is on disk, and the handle says where.
 *
 * A file to itself because `initialized` in init.ts is module state that never
 * resets — one `init()` per process is the budget.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { logs } from '@opentelemetry/api-logs';

import { withWorkflow } from '../src/annotations.ts';
import { init, type Telemetry } from '../src/index.ts';
import { fakeCollector, installContextManager, segmentBytes, segments } from './support/harness.ts';

installContextManager();

let collector: Awaited<ReturnType<typeof fakeCollector>>;
let telemetry: Telemetry;
let dir: string;

before(async () => {
  collector = await fakeCollector();
  dir = await mkdtemp(join(tmpdir(), 'octic-spool-init-'));

  telemetry = init({
    endpoint: collector.url,
    /** No apiKey, and auth is not 'none' — the accidental case, not a chosen one. */
    serviceName: 'init-spool',
    environment: 'test',
    content: { capture: 'none' },
    spool: { dir },
  });
});

after(async () => {
  await telemetry.shutdown();
  await collector.close();
  await rm(dir, { recursive: true, force: true });
});

describe('init() without a credential', () => {
  it('returns a working Telemetry rather than throwing on the consumer', () => {
    assert.equal(typeof telemetry.forceFlush, 'function');
    assert.ok(telemetry.spool, 'the spool is on the handle');
    assert.equal(telemetry.spool.mode, 'only', 'there is nothing to fall back from');
  });

  it('spools both signals and sends nothing it could not have authenticated', async () => {
    await withWorkflow({ name: 'chat-turn' }, async () => {
      logs
        .getLogger('@vendor/instrumentation-openai')
        .emit({ body: 'a model call the SDK could not deliver' });
      return undefined;
    });

    await telemetry.forceFlush();
    await telemetry.spool?.flush();

    const names = await segments(dir);
    assert.ok(
      names.some(name => name.startsWith('traces-')),
      `no trace segment among ${names.join(', ') || '(none)'}`,
    );
    assert.ok(
      names.some(name => name.startsWith('logs-')),
      `no log segment among ${names.join(', ') || '(none)'}`,
    );
    assert.match(await segmentBytes(dir), /chat-turn/);

    assert.equal(collector.requestCount(), 0, 'no request was made without a credential');
    assert.equal(telemetry.spool?.directory(), dir);
    assert.ok((telemetry.spool?.stats().written ?? 0) >= 2);
  });
});
