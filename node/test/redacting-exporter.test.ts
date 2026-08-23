/**
 * The exporter wrapper as a wrapper, separate from what it decides.
 *
 * `redaction.test.ts` owns policy; this file owns the mechanics — deferring for
 * a resource that has not settled, copying a span without dropping fields the
 * SDK added last release, scrubbing one resource once, and passing failure
 * through instead of swallowing it.
 *
 * Several of these hand the exporter a hand-built span rather than driving a
 * provider, because the shapes that matter here are ones the SDK only produces
 * under timing a test cannot arrange.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ExportResult } from '@opentelemetry/core';
import { ExportResultCode } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { Resource } from '@opentelemetry/resources';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

import { resolvePolicy } from '../src/content.ts';
import { RedactingSpanExporter } from '../src/redacting-exporter.ts';
import { CollectingExporter, fakeReadableSpan, installContextManager } from './support/harness.ts';

installContextManager();

const exportOnce = (
  exporter: RedactingSpanExporter,
  spans: ReadableSpan[],
): Promise<ExportResult> =>
  new Promise(resolve => {
    exporter.export(spans, resolve);
  });

describe('a resource whose detection is still in flight', () => {
  /**
   * Reading `.attributes` before detection settles materializes a snapshot
   * missing whatever had not resolved — silently, and only on fast-starting
   * processes. The inner exporter would have awaited this itself; we take the
   * resource away from it, so we inherit the obligation.
   */
  it('waits for async attributes before exporting', async () => {
    let settled = false;
    let release = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });

    const pending = {
      attributes: { 'service.name': 'test' },
      asyncAttributesPending: true,
      waitForAsyncAttributes: async () => {
        await gate;
        settled = true;
      },
    } as unknown as Resource;

    const collector = new CollectingExporter();
    const exporter = new RedactingSpanExporter(collector, resolvePolicy({ capture: 'none' }));

    const exported = exportOnce(exporter, [fakeReadableSpan({ resource: pending })]);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(collector.spans.length, 0, 'nothing exported while detection is pending');

    release();
    await exported;
    assert.equal(settled, true);
    assert.equal(collector.spans.length, 1);
  });

  /**
   * The `.then` used to have no rejection handler, so a detector that failed
   * dropped the batch *and* never called back. The dropped batch is a loss;
   * the missing callback is worse — a processor counts in-flight exports by
   * counting callbacks, so it waits forever on spans that were abandoned. Once
   * PR3 replaces `SimpleSpanProcessor` with a batching one, that is a queue
   * that stops draining.
   */
  it('exports anyway when detection rejects, and settles exactly once', async () => {
    const pending = {
      attributes: { 'service.name': 'test' },
      asyncAttributesPending: true,
      waitForAsyncAttributes: () => Promise.reject(new Error('detector exploded')),
    } as unknown as Resource;

    const collector = new CollectingExporter();
    const exporter = new RedactingSpanExporter(collector, resolvePolicy({ capture: 'none' }));

    let calls = 0;
    const result = await new Promise<ExportResult>(resolve => {
      exporter.export([fakeReadableSpan({ resource: pending })], value => {
        calls += 1;
        resolve(value);
      });
    });

    assert.equal(result.code, ExportResultCode.SUCCESS);
    assert.equal(collector.spans.length, 1, 'the batch was not dropped');
    assert.equal(calls, 1);
  });

  it('exports straight through when nothing is pending', async () => {
    const collector = new CollectingExporter();
    const exporter = new RedactingSpanExporter(collector, resolvePolicy({ capture: 'none' }));
    await exportOnce(exporter, [fakeReadableSpan()]);
    assert.equal(collector.spans.length, 1);
  });
});

describe('resource scrubbing', () => {
  const denied = () =>
    resourceFromAttributes({
      'service.name': 'test',
      'process.command_args': '/usr/bin/node server.js --token=hunter2',
      'host.id': '84c4f47c43d4497da39ce761dcc11c55',
    });

  it('drops denied keys and keeps the rest', async () => {
    const collector = new CollectingExporter();
    const exporter = new RedactingSpanExporter(collector, resolvePolicy({ capture: 'none' }));
    await exportOnce(exporter, [fakeReadableSpan({ resource: denied() })]);

    const resource = collector.only().resource;
    assert.equal(resource.attributes['process.command_args'], undefined);
    assert.equal(resource.attributes['host.id'], undefined);
    assert.equal(resource.attributes['service.name'], 'test');
  });

  /** One resource serves every span from a process; rebuilding it per span is waste. */
  it('returns the same scrubbed instance for the same resource', async () => {
    const collector = new CollectingExporter();
    const exporter = new RedactingSpanExporter(collector, resolvePolicy({ capture: 'none' }));
    const shared = denied();

    await exportOnce(exporter, [
      fakeReadableSpan({ resource: shared }),
      fakeReadableSpan({ resource: shared }),
    ]);

    assert.equal(collector.spans[0]!.resource, collector.spans[1]!.resource);
  });

  it('keeps two different resources apart', async () => {
    const collector = new CollectingExporter();
    const exporter = new RedactingSpanExporter(collector, resolvePolicy({ capture: 'none' }));

    await exportOnce(exporter, [
      fakeReadableSpan({
        resource: resourceFromAttributes({ 'service.name': 'a', 'host.id': 'x' }),
      }),
      fakeReadableSpan({
        resource: resourceFromAttributes({ 'service.name': 'b', 'host.id': 'y' }),
      }),
    ]);

    assert.equal(collector.spans[0]!.resource.attributes['service.name'], 'a');
    assert.equal(collector.spans[1]!.resource.attributes['service.name'], 'b');
  });

  /** Nothing denied means nothing to rebuild — the original instance is fine. */
  it('passes a clean resource through by identity', async () => {
    const collector = new CollectingExporter();
    const exporter = new RedactingSpanExporter(collector, resolvePolicy({ capture: 'none' }));
    const clean = resourceFromAttributes({ 'service.name': 'test' });

    await exportOnce(exporter, [fakeReadableSpan({ resource: clean })]);
    assert.equal(collector.only().resource, clean);
  });
});

/**
 * The copy is `Object.create` rather than a literal because `spanContext` is a
 * method and `ReadableSpan` gains fields across minor releases — a hand-built
 * copy drops whatever was added, quietly.
 */
describe('the copied span', () => {
  it('keeps every field the sanitizer does not name', async () => {
    const collector = new CollectingExporter();
    const exporter = new RedactingSpanExporter(collector, resolvePolicy({ capture: 'none' }));
    const original = fakeReadableSpan({ attributes: { 'gen_ai.usage.input_tokens': 5200 } });

    await exportOnce(exporter, [original]);
    const copy = collector.only();

    assert.equal(copy.name, original.name);
    assert.equal(copy.spanContext().traceId, original.spanContext().traceId);
    assert.equal(copy.instrumentationScope.name, original.instrumentationScope.name);
    assert.deepEqual(copy.links, original.links);
    assert.deepEqual(copy.duration, original.duration);
    assert.equal(copy.ended, original.ended);
  });

  it('does not mutate the span it was given', async () => {
    const collector = new CollectingExporter();
    const exporter = new RedactingSpanExporter(collector, resolvePolicy({ capture: 'none' }));
    const original = fakeReadableSpan({
      attributes: { 'gen_ai.input.messages': 'secret' },
      status: { code: 2, message: 'boom' },
    });

    await exportOnce(exporter, [original]);

    assert.equal(
      original.attributes['gen_ai.input.messages'],
      'secret',
      'the original is untouched',
    );
    assert.equal(original.status.message, 'boom');
    assert.equal(collector.only().attributes['gen_ai.input.messages'], undefined);
  });
});

describe('a batch', () => {
  it('is sanitized span by span', async () => {
    const collector = new CollectingExporter();
    const exporter = new RedactingSpanExporter(collector, resolvePolicy({ capture: 'none' }));

    await exportOnce(exporter, [
      fakeReadableSpan({ name: 'a', attributes: { 'gen_ai.input.messages': 'secret' } }),
      fakeReadableSpan({ name: 'b', attributes: { 'gen_ai.usage.input_tokens': 5200 } }),
    ]);

    assert.equal(collector.named('a').attributes['gen_ai.input.messages'], undefined);
    assert.equal(collector.named('b').attributes['gen_ai.usage.input_tokens'], 5200);
  });

  it('arrives at the inner exporter as one call', async () => {
    const collector = new CollectingExporter();
    const exporter = new RedactingSpanExporter(collector, resolvePolicy({ capture: 'none' }));

    await exportOnce(exporter, [fakeReadableSpan({ name: 'a' }), fakeReadableSpan({ name: 'b' })]);
    assert.equal(collector.batches.length, 1);
    assert.equal(collector.batches[0]!.length, 2);
  });

  it('handles an empty batch without calling through oddly', async () => {
    const collector = new CollectingExporter();
    const exporter = new RedactingSpanExporter(collector, resolvePolicy({ capture: 'none' }));

    const result = await exportOnce(exporter, []);
    assert.equal(result.code, ExportResultCode.SUCCESS);
  });
});

describe('delegation to the inner exporter', () => {
  it('passes a failure result through unchanged', async () => {
    const collector = new CollectingExporter({ result: ExportResultCode.FAILED });
    const exporter = new RedactingSpanExporter(collector, resolvePolicy({ capture: 'none' }));

    const result = await exportOnce(exporter, [fakeReadableSpan()]);
    assert.equal(result.code, ExportResultCode.FAILED);
  });

  it('forwards shutdown', async () => {
    const collector = new CollectingExporter();
    await new RedactingSpanExporter(collector, resolvePolicy()).shutdown();
    assert.equal(collector.shutdownCalls, 1);
  });

  it('forwards forceFlush', async () => {
    const collector = new CollectingExporter();
    await new RedactingSpanExporter(collector, resolvePolicy()).forceFlush();
    assert.equal(collector.forceFlushCalls, 1);
  });

  /** forceFlush is optional on SpanExporter, so an exporter without one must not throw. */
  it('resolves forceFlush when the inner exporter has none', async () => {
    const bare = {
      export: (_spans: ReadableSpan[], done: (result: ExportResult) => void) =>
        done({ code: ExportResultCode.SUCCESS }),
      shutdown: () => Promise.resolve(),
    };
    await new RedactingSpanExporter(bare, resolvePolicy()).forceFlush();
  });
});
