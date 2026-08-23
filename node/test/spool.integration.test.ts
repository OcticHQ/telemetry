/**
 * What reaches disk when the endpoint will not take it.
 *
 * The unit file covers where and how the spool writes. This one covers the
 * decision in front of it: a real `OTLPTraceExporter` against a collector
 * behaving badly, wrapped exactly the way `init()` wraps it, asserting that the
 * batch ends up in the spool directory instead of in the global error handler —
 * and, in the case that matters most, that what lands there has already been
 * through the content policy.
 *
 * That last one is the disk mirror of the "redaction happens before the
 * transport" case in exporter-failure.integration.test.ts, and it is the reason
 * the spool is composed *inside* `RedactingSpanExporter` rather than outside
 * it. Inverted, the customer's prompts sit unredacted in a file at
 * `capture: 'none'` — the one setting whose entire purpose is that they do not
 * leave the process.
 *
 * Composed over the real exporters rather than through `init()`, because the
 * init latch runs `setup()` at most once per process and this file needs
 * several arrangements.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExportResultCode } from '@opentelemetry/core';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import { withWorkflow } from '../src/annotations.ts';
import { resolvePolicy } from '../src/content.ts';
import { RedactingSpanExporter } from '../src/redacting-exporter.ts';
import { isSpoolable, SpoolingSpanExporter } from '../src/spool-exporter.ts';
import { resolveSpoolOptions, Spool } from '../src/spool.ts';
import {
  CONTENT,
  fakeCollector,
  installContextManager,
  segmentBytes,
  segments,
  withGlobalTracerProvider,
  withPolicy,
  withSpoolDir,
} from './support/harness.ts';

installContextManager();

const unhandled: unknown[] = [];
process.on('unhandledRejection', reason => unhandled.push(reason));
after(() => {
  assert.deepEqual(unhandled, [], 'spooling must not raise an unhandled rejection');
});

const CARD = CONTENT['gen_ai.input.messages'];

const MANIFEST = {
  signalPaths: { traces: '/v1/traces', logs: '/v1/logs' },
  contentType: 'application/json',
  contentEncoding: 'identity',
  serviceName: 'test',
  octicSchemaVersion: '1',
  sdkName: 'octic-node',
  sdkVersion: '0.0.0',
};

/**
 * The composition `init()` builds: redaction outermost, then the spool, then
 * the transport. `url: undefined` is the `mode: 'only'` arrangement, where no
 * transport is constructed at all.
 */
const pipeline = ({
  url,
  dir,
  capture = 'none',
}: {
  url?: string;
  dir: string;
  capture?: 'none' | 'full';
}) => {
  const policy = resolvePolicy({ capture });
  const spool = new Spool(resolveSpoolOptions({ enabled: true, dir }), {
    ...MANIFEST,
    endpoint: url ?? 'spool-only',
    contentCapture: capture,
  });

  const exporter = new RedactingSpanExporter(
    new SpoolingSpanExporter({
      ...(url === undefined
        ? {}
        : {
            /**
             * The default concurrency limit, deliberately: at 1 the delegate
             * rejects the second of two simultaneous exports with "Concurrent
             * export limit reached", which the classifier correctly spools — and
             * which would then show up in the cases below asserting that a
             * *healthy* collector produces no files.
             */
            inner: new OTLPTraceExporter({ url: `${url}/v1/traces`, timeoutMillis: 300 }),
          }),
      spool,
    }),
    policy,
  );

  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  return { provider, exporter, spool };
};

/** One workflow, plus one foreign span carrying planted content. */
const run = async (
  provider: NodeTracerProvider,
  capture: 'none' | 'full',
): Promise<{ reply: string }> =>
  withPolicy({ capture }, () =>
    withGlobalTracerProvider(provider, () =>
      withWorkflow({ name: 'chat-turn' }, async () => {
        const { trace } = await import('@opentelemetry/api');
        trace
          .getTracer('@vendor/instrumentation-openai')
          .startSpan('chat gpt-5', { attributes: { 'gen_ai.input.messages': CARD } })
          .end();
        return { reply: 'the application still got its answer' };
      }),
    ),
  );

describe('a collector answering 503', () => {
  it('puts the batch on disk instead of losing it, and the app never notices', async () => {
    await withSpoolDir(async dir => {
      const collector = await fakeCollector();
      collector.setStatus(503);
      try {
        const { provider, exporter, spool } = pipeline({ url: collector.url, dir });
        const result = await run(provider, 'none');
        await exporter.forceFlush();
        await spool.forceFlush();

        assert.deepEqual(result, { reply: 'the application still got its answer' });
        const names = await segments(dir);
        assert.ok(names.length > 0, 'the undeliverable batch was spooled');
        assert.match(await segmentBytes(dir), /chat gpt-5/);
        assert.equal(spool.stats().dropped, 0);

        await provider.shutdown();
      } finally {
        await collector.close();
      }
    });
  });
});

/**
 * The security property, and the reason for the composition order. A spool
 * outside the redactor would pass this test's sibling — the span is there —
 * while writing the card number to disk.
 */
describe('what a spooled file contains', () => {
  it('has been through the content policy before it reaches disk', async () => {
    await withSpoolDir(async dir => {
      const collector = await fakeCollector();
      collector.setStatus(503);
      try {
        const { provider, exporter, spool } = pipeline({ url: collector.url, dir });
        await run(provider, 'none');
        await exporter.forceFlush();
        await spool.forceFlush();

        const onDisk = await segmentBytes(dir);
        assert.match(onDisk, /chat gpt-5/, 'the span did reach the spool');
        assert.ok(!onDisk.includes('4111'), 'but never with content on it');
        assert.ok(
          !onDisk.includes('gen_ai.input.messages'),
          'the key is gone too, not just the value',
        );

        await provider.shutdown();
      } finally {
        await collector.close();
      }
    });
  });
});

describe('a collector that is not there at all', () => {
  it('spools the connection-refused batch rather than dropping it', async () => {
    await withSpoolDir(async dir => {
      /** Bound and closed, so the port is almost certainly free and refusing. */
      const collector = await fakeCollector();
      const dead = collector.url;
      await collector.close();

      const { provider, exporter, spool } = pipeline({ url: dead, dir });
      const result = await run(provider, 'none');
      await exporter.forceFlush();
      await spool.forceFlush();

      assert.deepEqual(result, { reply: 'the application still got its answer' });
      assert.ok((await segments(dir)).length > 0);
      await provider.shutdown();
    });
  });
});

describe('spool-only mode', () => {
  it('makes no HTTP request at all, which is the point of it', async () => {
    await withSpoolDir(async dir => {
      const collector = await fakeCollector();
      try {
        /** The collector is up and healthy; the pipeline is simply not pointed at it. */
        const { provider, exporter, spool } = pipeline({ dir });
        await run(provider, 'none');
        await exporter.forceFlush();
        await spool.forceFlush();

        assert.equal(collector.requestCount(), 0);
        assert.ok((await segments(dir)).length > 0);
        await provider.shutdown();
      } finally {
        await collector.close();
      }
    });
  });
});

describe('a healthy collector', () => {
  it('writes nothing to disk', async () => {
    await withSpoolDir(async dir => {
      const collector = await fakeCollector();
      try {
        const { provider, exporter, spool } = pipeline({ url: collector.url, dir });
        await run(provider, 'none');
        await exporter.forceFlush();
        await spool.forceFlush();
        await collector.waitFor(1);

        assert.deepEqual(await segments(dir), []);
        assert.equal(spool.stats().written, 0);
        await provider.shutdown();
      } finally {
        await collector.close();
      }
    });
  });
});

/**
 * A body ingest refuses on its merits will be refused again by the reader, for
 * as long as the file exists. Disk is bounded and shared; spending it on a
 * batch that can never be delivered costs the batches that could.
 */
describe('the classifier', () => {
  it('spools transport and credential failures', () => {
    assert.equal(isSpoolable(new Error('connect ECONNREFUSED')), true);
    assert.equal(isSpoolable(Object.assign(new Error('unauthorized'), { code: 401 })), true);
    assert.equal(isSpoolable(Object.assign(new Error('unavailable'), { code: 503 })), true);
    assert.equal(isSpoolable(Object.assign(new Error('too many'), { code: 429 })), true);
    assert.equal(isSpoolable(undefined), true, 'an unexplained failure fails durable');
  });

  it('refuses to spend disk on a body ingest will never accept', () => {
    assert.equal(isSpoolable(Object.assign(new Error('bad request'), { code: 400 })), false);
    assert.equal(isSpoolable(Object.assign(new Error('too large'), { code: 413 })), false);
    assert.equal(isSpoolable(Object.assign(new Error('unsupported'), { code: 415 })), false);
  });

  it('leaves the directory empty when the collector answers 400', async () => {
    await withSpoolDir(async dir => {
      const collector = await fakeCollector();
      collector.setStatus(400);
      try {
        const { provider, exporter, spool } = pipeline({ url: collector.url, dir });
        await run(provider, 'none');
        await exporter.forceFlush();
        await spool.forceFlush();

        assert.deepEqual(await segments(dir), []);
        await provider.shutdown();
      } finally {
        await collector.close();
      }
    });
  });
});

/**
 * Custody, not optimism: the wrapper reports SUCCESS once the batch is the
 * spool's problem, and keeps the failure when the spool would not take it.
 * `SimpleSpanProcessor` turns a FAILED result into a global error-handler call,
 * which is the noise this removes — and which has to come back the moment the
 * spool cannot help.
 */
describe('what the wrapper reports upstream', () => {
  it('is SUCCESS once the batch is spooled', async () => {
    await withSpoolDir(async dir => {
      const spool = new Spool(resolveSpoolOptions({ enabled: true, dir }), {
        ...MANIFEST,
        endpoint: 'http://127.0.0.1:1',
        contentCapture: 'none',
      });
      const exporter = new SpoolingSpanExporter({
        inner: {
          export: (_spans, done) =>
            done({ code: ExportResultCode.FAILED, error: new Error('ECONNREFUSED') }),
          shutdown: async () => undefined,
        },
        spool,
      });

      const result = await new Promise<{ code: number }>(resolve => {
        exporter.export([], resolve);
      });
      assert.equal(result.code, ExportResultCode.SUCCESS);
      await spool.shutdown();
    });
  });

  it('stays FAILED when the spool refuses the batch', async () => {
    await withSpoolDir(async dir => {
      const spool = new Spool(resolveSpoolOptions({ enabled: false, dir }), {
        ...MANIFEST,
        endpoint: 'http://127.0.0.1:1',
        contentCapture: 'none',
      });
      const exporter = new SpoolingSpanExporter({
        inner: {
          export: (_spans, done) =>
            done({ code: ExportResultCode.FAILED, error: new Error('ECONNREFUSED') }),
          shutdown: async () => undefined,
        },
        spool,
      });

      const result = await new Promise<{ code: number }>(resolve => {
        exporter.export([], resolve);
      });
      assert.equal(result.code, ExportResultCode.FAILED);
      await spool.shutdown();
    });
  });
});
