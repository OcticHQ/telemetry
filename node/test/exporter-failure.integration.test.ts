/**
 * What a broken collector does to the application.
 *
 * The answer has to be "nothing". Telemetry that takes the request down with it
 * when the endpoint is having a bad day is worse than no telemetry, and this is
 * the failure a consumer cannot test for themselves before they depend on us.
 *
 * Composed over a real `OTLPTraceExporter` rather than through `init()`, both
 * because the transport is the thing under test and because it leaves the
 * process-wide init latch free — so this file can exercise four different
 * broken collectors instead of one.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import { withWorkflow } from '../src/annotations.ts';
import { resolvePolicy } from '../src/content.ts';
import { resetCounters, snapshot } from '../src/counters.ts';
import { RedactingSpanExporter } from '../src/redacting-exporter.ts';
import { SafeSpanExporter } from '../src/safe-exporter.ts';
import {
  CONTENT,
  fakeCollector,
  installContextManager,
  withGlobalTracerProvider,
  withPolicy,
} from './support/harness.ts';

installContextManager();

const CARD = CONTENT['gen_ai.input.messages'];

/**
 * Unhandled rejections are the specific way a telemetry bug takes a process
 * down in Node — the export happens off the request's promise chain, so a
 * rejection there has nobody to catch it and becomes a crash.
 */
const unhandled: unknown[] = [];
process.on('unhandledRejection', reason => unhandled.push(reason));

beforeEach(() => {
  resetCounters();
});

after(() => {
  assert.deepEqual(unhandled, [], 'a failing exporter must not raise an unhandled rejection');
});

const pipeline = (url: string, capture: 'none' | 'full' = 'none') => {
  const policy = resolvePolicy({ capture });
  /**
   * Wrapped the way `init()` wraps it. The guard is the outermost link there,
   * so a suite that composed the chain without it would be asserting about a
   * pipeline no consumer runs — and the exactly-once callback property it adds
   * is exactly the thing these broken collectors are here to stress.
   */
  const exporter = new SafeSpanExporter(
    new RedactingSpanExporter(
      new OTLPTraceExporter({ url: `${url}/v1/traces`, concurrencyLimit: 1, timeoutMillis: 300 }),
      policy,
    ),
  );
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  return { provider, exporter, policy };
};

/** One workflow, run against a collector behaving badly, asserting it still works. */
const runAgainst = async (url: string, capture: 'none' | 'full' = 'none') => {
  const { provider, exporter } = pipeline(url, capture);

  const result = await withPolicy({ capture }, () =>
    withGlobalTracerProvider(provider, () =>
      withWorkflow({ name: 'chat-turn' }, async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return { reply: 'the application still got its answer' };
      }),
    ),
  );

  return { result, exporter, provider };
};

describe('a collector answering 503', () => {
  it('does not stop the application getting its result', async () => {
    const collector = await fakeCollector();
    collector.setStatus(503);
    try {
      const { result } = await runAgainst(collector.url);
      assert.deepEqual(result, { reply: 'the application still got its answer' });
    } finally {
      await collector.close();
    }
  });

  it('still lets shutdown resolve', async () => {
    const collector = await fakeCollector();
    collector.setStatus(503);
    try {
      const { provider } = await runAgainst(collector.url);
      await provider.shutdown();
    } finally {
      await collector.close();
    }
  });
});

describe('a collector answering 200 with a partialSuccess body', () => {
  it('is treated as a success and changes nothing for the caller', async () => {
    const collector = await fakeCollector();
    try {
      const { result } = await runAgainst(collector.url);
      await collector.waitFor(1);
      assert.deepEqual(result, { reply: 'the application still got its answer' });
      assert.ok(collector.traces.length > 0);
    } finally {
      await collector.close();
    }
  });
});

describe('a collector that never answers', () => {
  it('does not block the application on the export', async () => {
    const collector = await fakeCollector();
    collector.setHang(true);
    try {
      const started = Date.now();
      const { result, provider } = await runAgainst(collector.url);
      const elapsed = Date.now() - started;

      assert.deepEqual(result, { reply: 'the application still got its answer' });
      assert.ok(elapsed < 2000, `the run took ${elapsed}ms, so the export was blocking it`);
      await provider.shutdown();
    } finally {
      await collector.close();
    }
  });
});

describe('a collector that is not there at all', () => {
  it('survives a connection refused', async () => {
    /** Bound and closed, so the port is almost certainly free and refusing. */
    const collector = await fakeCollector();
    const dead = collector.url;
    await collector.close();

    const { result, provider } = await runAgainst(dead);
    assert.deepEqual(result, { reply: 'the application still got its answer' });
    await provider.shutdown();
    await new Promise(resolve => setTimeout(resolve, 50));
  });
});

/**
 * The ordering guarantee that matters when the transport is unreliable.
 *
 * OTLP exporters retry, so anything the transport was handed may be sent more
 * than once. Redaction happens before the exporter sees the span, which is what
 * makes that safe — a retry replays the already-redacted copy, never the
 * original.
 */
describe('redaction happens before the transport', () => {
  it('means a retrying exporter has no raw content to replay', async () => {
    const collector = await fakeCollector();
    collector.setStatus(503);

    try {
      const { provider, exporter } = pipeline(collector.url, 'none');

      await withPolicy({ capture: 'none' }, () =>
        withGlobalTracerProvider(provider, async () => {
          const { trace } = await import('@opentelemetry/api');
          trace
            .getTracer('@vendor/instrumentation-openai')
            .startSpan('chat gpt-5', { attributes: { 'gen_ai.input.messages': CARD } })
            .end();
        }),
      );

      await exporter.forceFlush();
      await collector.waitFor(1);

      /** Every body the failing collector received, across every retry. */
      const wire = JSON.stringify(collector.traces);
      assert.ok(wire.includes('chat gpt-5'), 'the span did reach the transport');
      assert.ok(!wire.includes('4111'), 'but never with content on it');
    } finally {
      await collector.close();
    }
  });
});

/**
 * A guard that turns a crash into a return is only half the work; the other
 * half is that the return leaves a trace. These are the numbers the eventual
 * `diagnose()` will publish, and the reason a failing endpoint is diagnosable
 * today with `OCTIC_TELEMETRY_DEBUG=1` rather than only visible as absence.
 */
describe('a suppressed failure is still a counted one', () => {
  it('counts the failure when the collector refuses the batch', async () => {
    const collector = await fakeCollector();
    collector.setStatus(503);
    try {
      const { exporter } = await runAgainst(collector.url);
      await exporter.forceFlush();

      assert.ok(snapshot().exportsFailed > 0, 'the failure was recorded');
      assert.equal(snapshot().spansAccepted, 0, 'and nothing was claimed as delivered');
    } finally {
      await collector.close();
    }
  });

  it('counts the spans when the collector takes them', async () => {
    const collector = await fakeCollector();
    try {
      const { exporter } = await runAgainst(collector.url);
      await exporter.forceFlush();
      await collector.waitFor(1);

      assert.ok(snapshot().spansAccepted > 0);
      assert.equal(snapshot().exportsFailed, 0);
    } finally {
      await collector.close();
    }
  });
});
