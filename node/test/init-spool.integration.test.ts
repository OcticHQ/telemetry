/**
 * `init()` with nothing but a service name and an endpoint: the defaults.
 *
 * Spool-only, no credential, content off, traces only. The directory comes from
 * `OCTIC_SPOOL_DIR`, which is how the reader's host tells the SDK where to
 * write. This asserts that `init()` returns normally, makes no HTTP request
 * even with a live endpoint to make one to, writes a manifest and a traces
 * segment, and writes no logs segment — a log record emitted by
 * instrumentation reaches the global no-op logger instead.
 *
 * A file to itself because init.ts latches on the first call and never re-runs
 * `setup()` — one effective `init()` per process is the budget.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
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

  process.env.OCTIC_SPOOL_DIR = dir;
  /** What Airlock sets on a workload, plus a service name ours must beat. */
  process.env.OTEL_RESOURCE_ATTRIBUTES = 'airlock.run.id=run-123,service.name=from-env';
  telemetry = init({
    /** Live, so that a request to it would be counted rather than refused. */
    endpoint: collector.url,
    serviceName: 'init-spool',
    environment: 'test',
  });
});

after(async () => {
  await telemetry.shutdown();
  await collector.close();
  await rm(dir, { recursive: true, force: true });
});

describe('init() with the defaults', () => {
  it('returns a working Telemetry whose spool is the only sink', () => {
    assert.equal(typeof telemetry.forceFlush, 'function');
    assert.ok(telemetry.spool, 'the spool is on the handle');
    assert.equal(telemetry.spool.mode, 'only');
  });

  it('spools traces only, and sends nothing', async () => {
    await withWorkflow({ name: 'chat-turn' }, async () => {
      logs
        .getLogger('@vendor/instrumentation-openai')
        .emit({ body: 'a model call written to the logs signal' });
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
      !names.some(name => name.startsWith('logs-')),
      `a log segment among ${names.join(', ')}`,
    );
    assert.match(await segmentBytes(dir), /chat-turn/);

    assert.equal(collector.requestCount(), 0, 'a request was made under spool-only');
    assert.equal(telemetry.spool?.directory(), dir, 'OCTIC_SPOOL_DIR was not used');
  });

  it('carries OTEL_RESOURCE_ATTRIBUTES on the resource, under the options', async () => {
    const first = (await segments(dir)).find(name => name.startsWith('traces-')) ?? '';
    const body = JSON.parse(await readFile(join(dir, first), 'utf8')) as {
      resourceSpans: {
        resource: { attributes: { key: string; value: { stringValue?: string } }[] };
      }[];
    };
    const attributes = Object.fromEntries(
      (body.resourceSpans[0]?.resource.attributes ?? []).map(kv => [kv.key, kv.value.stringValue]),
    );
    assert.equal(attributes['airlock.run.id'], 'run-123');
    assert.equal(attributes['service.name'], 'init-spool');
  });

  it('records the endpoint and content capture none in the manifest', async () => {
    const manifests = (await readdir(dir)).filter(name => name.startsWith('manifest-'));
    assert.equal(manifests.length, 1, `manifests: ${manifests.join(', ') || '(none)'}`);
    const manifest = JSON.parse(await readFile(join(dir, manifests[0] ?? ''), 'utf8')) as {
      endpoint: string;
      contentCapture: string;
    };
    assert.equal(manifest.endpoint, collector.url.replace(/\/$/, ''));
    assert.equal(manifest.contentCapture, 'none');
  });
});
