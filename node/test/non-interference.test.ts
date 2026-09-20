/**
 * The two promises, as tests.
 *
 *   1. A synchronous failure originating in this SDK never escapes into the
 *      caller's stack.
 *   2. A failure originating in the *caller's* code propagates untouched.
 *
 * They pull in opposite directions, which is why they are one file. A guard
 * written for the first is one careless `try` away from breaking the second,
 * and an observability tool that eats the application's errors is worse than
 * one that occasionally crashes: the crash gets fixed.
 *
 * The third thing here is what happens after a guard fires. A swallowed error
 * that leaves no trace is the same silence this package exists to remove, so
 * every case that suppresses something also asserts the counter moved.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { ROOT_CONTEXT } from '@opentelemetry/api';
import type { Attributes, Context } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  SimpleSpanProcessor,
  type ReadableSpan,
  type Span,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import { withTool } from '../src/annotations.ts';
import { resolvePolicy, setActivePolicy } from '../src/content.ts';
import { resetCounters, snapshot } from '../src/counters.ts';
import { withIdentity } from '../src/identity.ts';
import { OcticSpanProcessor } from '../src/processor.ts';
import { RedactingSpanExporter } from '../src/redacting-exporter.ts';
import { SafeSpanExporter } from '../src/safe-exporter.ts';
import { SafeSpanProcessor } from '../src/safe-processor.ts';
import { sanitizeAttributes } from '../src/sanitize.ts';
import {
  buildProvider,
  CollectingExporter,
  fakeReadableSpan,
  FOREIGN_SCOPE,
  installContextManager,
  withGlobalTracerProvider,
} from './support/harness.ts';

installContextManager();

beforeEach(() => {
  resetCounters();
});

const exportOnce = (exporter: SpanExporter, spans: ReadableSpan[]): Promise<ExportResult> =>
  new Promise(resolve => {
    exporter.export(spans, resolve);
  });

/**
 * The wiring `init()` actually builds, which the shared harness deliberately
 * does not: `buildProvider` composes the enricher bare so the redaction suite
 * sees its throws. Every case below that is about the guard needs the guard.
 */
const guardedProvider = () => {
  const collector = new CollectingExporter();
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': 'test' }),
    spanProcessors: [
      new SafeSpanProcessor(new OcticSpanProcessor()),
      new SimpleSpanProcessor(
        new SafeSpanExporter(
          new RedactingSpanExporter(collector, resolvePolicy({ capture: 'none' })),
        ),
      ),
    ],
  });
  return { collector, provider, foreignTracer: provider.getTracer(FOREIGN_SCOPE) };
};

// ── promise one: nothing of ours escapes ────────────────────────────────────

describe('a processor callback that throws', () => {
  /**
   * The shape that makes this worth guarding: `onStart` is called
   * synchronously by `Tracer.startSpan`, so the frame it throws into belongs to
   * whichever instrumentation created the span — code that has never heard of
   * this package and cannot be expected to catch us.
   */
  const throwing: SpanProcessor = {
    onStart: () => {
      throw new Error('processor exploded');
    },
    onEnd: () => {
      throw new Error('onEnd exploded');
    },
    forceFlush: () => Promise.reject(new Error('flush exploded')),
    shutdown: () => Promise.reject(new Error('shutdown exploded')),
  };

  it('does not escape onStart, and is counted', () => {
    const processor = new SafeSpanProcessor(throwing);
    assert.doesNotThrow(() => {
      processor.onStart({} as Span, ROOT_CONTEXT);
    });
    assert.equal(snapshot().processorErrors, 1);
  });

  it('does not escape onEnd', () => {
    const processor = new SafeSpanProcessor(throwing);
    assert.doesNotThrow(() => {
      processor.onEnd({} as ReadableSpan);
    });
    assert.equal(snapshot().processorErrors, 1);
  });

  /**
   * Rejections, not only throws: `forceFlush` and `shutdown` are reachable from
   * the application's own graceful-shutdown path, where an unhandled rejection
   * turns a clean exit into a non-zero one.
   */
  it('does not reject from forceFlush or shutdown', async () => {
    const processor = new SafeSpanProcessor(throwing);
    await processor.forceFlush();
    await processor.shutdown();
    assert.equal(snapshot().processorErrors, 2);
  });
});

describe('a Context the enricher cannot read', () => {
  /**
   * Reachable, not hypothetical: under `initWithExternalProvider()` the host
   * SDK owns the provider and hands our processor whatever it calls a Context.
   */
  const hostile = {
    getValue: () => {
      throw new TypeError('not the Context you were expecting');
    },
    setValue: () => hostile,
    deleteValue: () => hostile,
  } as unknown as Context;

  it('is suppressed rather than thrown into startSpan', () => {
    const processor = new SafeSpanProcessor(new OcticSpanProcessor());
    const span = { setAttributes: () => span, setAttribute: () => span } as unknown as Span;

    assert.doesNotThrow(() => {
      processor.onStart(span, hostile);
    });
    assert.equal(snapshot().processorErrors, 1);
  });
});

describe('an identity value that throws when read', () => {
  it('costs the span its attributes, not the caller their request', async () => {
    const { collector, provider, foreignTracer } = guardedProvider();
    const booby = {
      get conversationId(): string {
        throw new Error('getter exploded');
      },
    };

    await withGlobalTracerProvider(provider, async () => {
      await withIdentity(booby, async () => {
        foreignTracer.startSpan('chat gpt-5').end();
      });
    });
    await provider.forceFlush();

    /**
     * The span still exists and still ships. That is the whole point: losing
     * the enrichment is a telemetry problem, losing the span would be one too,
     * and throwing would have been the caller's problem.
     */
    assert.equal(collector.named('chat gpt-5').attributes['gen_ai.conversation.id'], undefined);
  });
});

// ── promise two: the caller's error is untouched ────────────────────────────

describe("a customer's own failure", () => {
  /**
   * `recordException` is the trap. Handed a value with no `code`, `name` or
   * `message` it falls through to a `diag.warn` that interpolates the value
   * into a template literal — and a Symbol there raises `TypeError: Cannot
   * convert a Symbol value to a string`, which would then replace the thrown
   * value on the way out of our `catch`. This case failed before the guard.
   */
  it('propagates a thrown Symbol as itself', async () => {
    const boom = Symbol('boom');
    let caught: unknown = 'nothing was thrown';

    try {
      await withTool({ name: 'symbol-thrower' }, () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the value under test
        throw boom;
      });
    } catch (error) {
      caught = error;
    }

    assert.equal(caught, boom, 'the same Symbol, not a TypeError about it');
  });

  it('propagates a thrown undefined as itself', async () => {
    const sentinel = Symbol('nothing was thrown');
    let caught: unknown = sentinel;

    try {
      await withTool({ name: 'undefined-thrower' }, () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the value under test
        throw undefined;
      });
    } catch (error) {
      caught = error;
    }

    assert.equal(caught, undefined);
    assert.notEqual(caught, sentinel, 'it did throw');
  });

  it('propagates a thrown string as itself', async () => {
    let caught: unknown;
    try {
      await withTool({ name: 'string-thrower' }, () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the value under test
        throw 'just a string';
      });
    } catch (error) {
      caught = error;
    }
    assert.equal(caught, 'just a string');
  });

  it('still marks the span an error and ends it when the value is a Symbol', async () => {
    const { collector, provider } = buildProvider({ content: { capture: 'none' } });
    setActivePolicy(resolvePolicy({ capture: 'none' }));

    await withGlobalTracerProvider(provider, async () => {
      await assert.rejects(
        async () =>
          withTool({ name: 'symbol-thrower' }, () => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- the value under test
            throw Symbol('boom');
          }),
        () => true,
      );
    });
    setActivePolicy(resolvePolicy());

    const span = collector.named('execute_tool symbol-thrower');
    assert.equal(span.status.code, 2, 'SpanStatusCode.ERROR');
    assert.equal(span.ended, true);
  });
});

describe('the boundary is origin, not stack frame', () => {
  /**
   * The negative case, and the one a "never throws" instruction most invites
   * getting wrong. Our processor sits in the same provider as a host SDK's,
   * and theirs throwing is not ours to swallow — the tracer's own behaviour is
   * the contract there, and hiding it would make their bug invisible.
   */
  it('does not catch a foreign processor throwing in the same provider', () => {
    const wrapped = new SafeSpanProcessor(new OcticSpanProcessor());
    const foreign: SpanProcessor = {
      onStart: () => {
        throw new Error('the host SDK exploded');
      },
      onEnd: () => undefined,
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    };

    const span = { setAttributes: () => span, setAttribute: () => span } as unknown as Span;
    assert.doesNotThrow(() => {
      wrapped.onStart(span, ROOT_CONTEXT);
    });
    assert.throws(() => {
      foreign.onStart({} as Span, ROOT_CONTEXT);
    }, /host SDK exploded/);
    assert.equal(snapshot().processorErrors, 0, 'we counted nothing, because none of it was ours');
  });
});

// ── the sanitizer ───────────────────────────────────────────────────────────

describe('attributes OpenTelemetry cannot carry', () => {
  /**
   * OTel drops all of these itself, with a `diag.warn` naming the key and not
   * naming us. The value here is the counting and the attribution: a consumer
   * whose business id never arrives needs to learn that from us.
   */
  const rejected: [string, unknown][] = [
    ['a symbol', Symbol('nope')],
    ['a bigint', 10n],
    ['a function', () => 1],
    ['a plain object', { nested: true }],
    ['a mixed array', [1, 'two']],
    ['a NaN', Number.NaN],
    ['an Infinity', Number.POSITIVE_INFINITY],
  ];

  for (const [label, value] of rejected) {
    it(`drops ${label} and counts it`, () => {
      const { attributes, dropped } = sanitizeAttributes({ 'octic.custom.x': value } as Attributes);
      assert.deepEqual(attributes, {});
      assert.equal(dropped, 1);
      assert.equal(snapshot().attributesDropped, 1);
    });
  }

  it('keeps what OpenTelemetry does accept, including a homogeneous array', () => {
    const { attributes, dropped } = sanitizeAttributes({
      string: 'a',
      number: 1,
      boolean: true,
      strings: ['a', 'b'],
      numbers: [1, 2],
      /** Holes do not decide the array's type, so this stays homogeneous. */
      holes: ['a', null, 'b'],
    });

    assert.equal(dropped, 0);
    assert.equal(Object.keys(attributes).length, 6);
  });

  it('skips undefined and null without counting them as drops', () => {
    const { attributes, dropped } = sanitizeAttributes({
      absent: undefined,
      empty: null,
    } as unknown as Attributes);

    assert.deepEqual(attributes, {});
    assert.equal(dropped, 0, 'an absent value is not a rejected one');
  });

  it('drops an oversized key rather than truncating it into a different key', () => {
    const { attributes, dropped } = sanitizeAttributes({ ['k'.repeat(300)]: 'v' });
    assert.deepEqual(attributes, {});
    assert.equal(dropped, 1);
  });

  it('caps a value at the policy length rather than dropping it', () => {
    const { attributes, dropped } = sanitizeAttributes({ big: 'x'.repeat(5000) });
    assert.equal(dropped, 0);
    assert.ok(String(attributes.big).length < 5000);
    assert.match(String(attributes.big), /…\[truncated\]$/);
  });

  it('caps the number of attributes one map can add', () => {
    const many: Attributes = {};
    for (let i = 0; i < 200; i += 1) many[`octic.custom.k${i}`] = i;

    const { attributes, dropped } = sanitizeAttributes(many);
    assert.equal(Object.keys(attributes).length, 128);
    assert.equal(dropped, 72);
  });
});

// ── the exporter chain ──────────────────────────────────────────────────────

describe('the exporter guard', () => {
  it('turns a synchronous throw into a FAILED result', async () => {
    const inner = new CollectingExporter({ throwOnExport: new Error('transport exploded') });
    const result = await exportOnce(new SafeSpanExporter(inner), [fakeReadableSpan()]);

    assert.equal(result.code, ExportResultCode.FAILED);
    assert.match(String(result.error?.message), /transport exploded/);
    assert.equal(snapshot().exportsFailed, 1);
  });

  /**
   * A processor tracks in-flight exports by counting callbacks. A second one
   * corrupts that accounting — and once PR3 puts a `BatchSpanProcessor` here,
   * corrupt accounting is a queue that stops draining.
   */
  it('forwards only the first of two results', async () => {
    const twice: SpanExporter = {
      export: (_spans, done) => {
        done({ code: ExportResultCode.SUCCESS });
        done({ code: ExportResultCode.FAILED, error: new Error('and again') });
      },
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    };

    const results: ExportResult[] = [];
    new SafeSpanExporter(twice).export([fakeReadableSpan()], result => results.push(result));

    assert.equal(results.length, 1);
    assert.equal(results[0]?.code, ExportResultCode.SUCCESS);
    assert.equal(snapshot().duplicateCallbacks, 1);
  });

  /**
   * Documents the boundary rather than defending it. An exporter that never
   * settles is a bug in that exporter, and a timeout invented here would race
   * the exporter's own `exportTimeoutMillis` with no better answer to give.
   */
  it('does not invent a result for an exporter that never calls back', async () => {
    const silent: SpanExporter = {
      export: () => undefined,
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    };

    let settled = false;
    new SafeSpanExporter(silent).export([fakeReadableSpan()], () => {
      settled = true;
    });
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.equal(settled, false);
  });

  it('counts spans, not batches, when the export succeeds', async () => {
    const inner = new CollectingExporter();
    await exportOnce(new SafeSpanExporter(inner), [fakeReadableSpan(), fakeReadableSpan()]);
    assert.equal(snapshot().spansAccepted, 2);
  });

  it('never rejects from shutdown or forceFlush', async () => {
    const hostile: SpanExporter = {
      export: (_spans, done) => done({ code: ExportResultCode.SUCCESS }),
      forceFlush: () => Promise.reject(new Error('flush exploded')),
      shutdown: () => Promise.reject(new Error('shutdown exploded')),
    };

    const exporter = new SafeSpanExporter(hostile);
    await exporter.forceFlush();
    await exporter.shutdown();
  });
});

describe('a span that cannot be sanitized', () => {
  /**
   * One span, not the batch. `export` runs inside the span processor, so a
   * throw here would take out every other span in the batch and land somewhere
   * nothing can act on it.
   */
  const cursed = (): ReadableSpan => {
    const span = fakeReadableSpan({ name: 'cursed' });
    return Object.create(span, {
      events: {
        get: () => {
          throw new Error('events exploded');
        },
        enumerable: true,
      },
    }) as ReadableSpan;
  };

  it('ships stripped, and the rest of the batch is untouched', async () => {
    const collector = new CollectingExporter();
    const exporter = new RedactingSpanExporter(collector, resolvePolicy({ capture: 'none' }));

    await exportOnce(exporter, [cursed(), fakeReadableSpan({ name: 'fine' })]);

    assert.equal(collector.spans.length, 2);
    assert.deepEqual(collector.named('cursed').attributes, {});
    assert.equal(collector.named('fine').name, 'fine');
  });
});

describe('the guard forwards rather than intercepts', () => {
  /**
   * The regression this file would otherwise miss entirely. Every other case
   * in the suite builds its provider through the harness, which wraps nothing,
   * so a `SafeSpanProcessor` that quietly swallowed every call would leave the
   * whole suite green and every span unenriched in production.
   */
  it('still stamps identity through SafeSpanProcessor', async () => {
    const { collector, provider, foreignTracer } = guardedProvider();

    await withGlobalTracerProvider(provider, async () => {
      await withIdentity({ userId: 'user-42' }, async () => {
        foreignTracer.startSpan('chat gpt-5').end();
      });
    });
    await provider.forceFlush();

    assert.equal(collector.named('chat gpt-5').attributes['user.id'], 'user-42');
  });
});
