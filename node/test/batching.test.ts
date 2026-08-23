/**
 * Batching, as three separable claims.
 *
 *   1. The four knobs resolve to stated values, and no environment variable
 *      reaches a processor behind the caller's back.
 *   2. A full queue drops, and the drop is counted rather than absorbed.
 *   3. The silence warning fires when spans are produced and none is
 *      exported — and disarms the moment one is.
 *
 * The second and third are the ones worth writing carefully. Both describe a
 * pipeline that is failing quietly, which is the condition a green test suite
 * is least likely to notice and the reason this SDK bothers to count anything.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { diag, DiagLogLevel, type DiagLogger } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';

import { BATCH_DEFAULTS, resolveBatchOptions } from '../src/batching.ts';
import { resetCounters } from '../src/counters.ts';
import { SafeSpanExporter } from '../src/safe-exporter.ts';
import { droppedRecordMeterProvider, QUEUE_FULL } from '../src/self-metrics.ts';
import {
  cancelSilenceWatch,
  configureSilenceWatch,
  noteExportSucceeded,
  noteSpanStarted,
} from '../src/silence-watch.ts';
import { fakeReadableSpan } from './support/harness.ts';

beforeEach(() => {
  resetCounters();
  cancelSilenceWatch();
});

const tick = (millis: number): Promise<void> => new Promise(resolve => setTimeout(resolve, millis));

/** Captures `diag` output for the length of one case, then puts it back. */
const withDiag = async (fn: (warnings: string[]) => Promise<void>): Promise<void> => {
  const warnings: string[] = [];
  const logger: DiagLogger = {
    error: () => undefined,
    warn: message => warnings.push(message),
    info: () => undefined,
    debug: () => undefined,
    verbose: () => undefined,
  };
  diag.setLogger(logger, DiagLogLevel.WARN);
  try {
    await fn(warnings);
  } finally {
    diag.disable();
  }
};

describe('the batch options', () => {
  it('fill every field, so the caller sees what the pipeline runs on', () => {
    assert.deepEqual(resolveBatchOptions(), BATCH_DEFAULTS);
  });

  it('take the caller over the default, one field at a time', () => {
    const resolved = resolveBatchOptions({ scheduledDelayMillis: 100 });

    assert.equal(resolved.scheduledDelayMillis, 100);
    assert.equal(resolved.maxQueueSize, BATCH_DEFAULTS.maxQueueSize);
  });

  /**
   * The property that matters is not "we ignore the variable" but "the two
   * signals cannot disagree". `sdk-trace-base`'s BatchSpanProcessor reads
   * `OTEL_BSP_*` into any field left undefined; `BatchLogRecordProcessor` reads
   * nothing. Resolving all four is what stops one environment variable from
   * tuning traces and leaving logs behind.
   */
  it('leaves nothing undefined for an OTEL_BSP_* fallback to fill', () => {
    const resolved: Record<string, unknown> = resolveBatchOptions({});

    for (const key of Object.keys(BATCH_DEFAULTS)) {
      assert.equal(typeof resolved[key], 'number', `${key} was left for the environment to set`);
    }
  });
});

describe('a queue that overflows', () => {
  /**
   * Driven through a real `BatchSpanProcessor` rather than by calling the meter
   * shim directly. The whole mechanism rests on an attribute value —
   * `error.type: 'queue_full'` — that OpenTelemetry sets internally and exports
   * from neither package's public entry point. A test that asserted against our
   * own copy of the string would keep passing through the rename that broke it.
   */
  it('counts what it drops, through the meter the processor reports to', async () => {
    /** Never settles, so the queue fills instead of draining. */
    const stuck: SpanExporter = {
      export: () => undefined,
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    };

    const counted: number[] = [];
    const processor = new BatchSpanProcessor({
      exporter: stuck,
      maxQueueSize: 4,
      maxExportBatchSize: 4,
      scheduledDelayMillis: 60_000,
      /** Short only so the abandoned export lets go of the process afterwards. */
      exportTimeoutMillis: 100,
      selfObsMeterProvider: droppedRecordMeterProvider(dropped => counted.push(dropped)),
    });

    /**
     * All ten in one synchronous pass, so nothing can drain between them and
     * the arithmetic is exact: the first four reach the batch size and are
     * handed to the exporter, which never calls back; the next four refill the
     * queue while that export is still in flight; the last two have nowhere to
     * go.
     */
    for (let i = 0; i < 10; i += 1) {
      processor.onEnd(fakeReadableSpan({ name: `span-${String(i)}` }));
    }

    assert.ok(counted.length > 0, 'the processor dropped spans and said nothing to the meter');
    assert.equal(
      counted.reduce((total, n) => total + n, 0),
      2,
      'four in flight, four queued, two with nowhere to go',
    );

    await processor.shutdown().catch(() => undefined);
  });

  it('names the drop the way the processors do', () => {
    const dropped: number[] = [];
    const meter = droppedRecordMeterProvider(n => dropped.push(n)).getMeter('test');
    const counter = meter.createCounter('otel.sdk.processor.span.processed');

    counter.add(3, { 'error.type': QUEUE_FULL });
    counter.add(9, { 'error.type': 'SomeExportError' });
    counter.add(7, {});

    assert.deepEqual(dropped, [3], 'only a queue-full drop is a drop; the rest are outcomes');
  });
});

describe('the silence warning', () => {
  it('fires when spans are produced and nothing is exported', async () => {
    await withDiag(async warnings => {
      configureSilenceWatch(20);
      noteSpanStarted();

      await tick(60);

      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? '', /none has been exported/);
    });
  });

  it('does not fire for a process that produced no spans at all', async () => {
    await withDiag(async warnings => {
      configureSilenceWatch(20);

      await tick(60);

      assert.deepEqual(warnings, [], 'silence is only a symptom when there is something to send');
    });
  });

  it('is disarmed by the first successful export', async () => {
    await withDiag(async warnings => {
      configureSilenceWatch(20);
      noteSpanStarted();
      noteExportSucceeded();

      await tick(60);

      assert.deepEqual(warnings, []);
    });
  });

  /**
   * A pipeline that delivered once and then stopped is a different problem —
   * the exporter is failing, and the exporter says so itself. Re-arming here
   * would report the same outage twice under two different names.
   */
  it('stays disarmed once it has seen a delivery', async () => {
    await withDiag(async warnings => {
      configureSilenceWatch(20);
      noteSpanStarted();
      noteExportSucceeded();
      noteSpanStarted();

      await tick(60);

      assert.deepEqual(warnings, []);
    });
  });

  it('does not re-arm per span, so a busy process still hears about it once', async () => {
    await withDiag(async warnings => {
      configureSilenceWatch(40);
      noteSpanStarted();
      await tick(30);
      noteSpanStarted();
      await tick(30);

      assert.equal(warnings.length, 1, 'the deadline moved with the traffic');
    });
  });

  it('is cancelled by shutdown', async () => {
    await withDiag(async warnings => {
      configureSilenceWatch(20);
      noteSpanStarted();
      cancelSilenceWatch();

      await tick(60);

      assert.deepEqual(warnings, []);
    });
  });
});

describe('the exporter that reports success', () => {
  /**
   * The disarm lives in `SafeSpanExporter`, so it covers `mode: 'only'` too:
   * the spool reports SUCCESS having written to disk and sent nothing, which is
   * a working pipeline and must not warn.
   */
  it('disarms the watch through the guard, not through HTTP', async () => {
    const accepting: SpanExporter = {
      export: (_spans, resultCallback: (result: ExportResult) => void) => {
        resultCallback({ code: ExportResultCode.SUCCESS });
      },
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    };

    await withDiag(async warnings => {
      configureSilenceWatch(20);
      noteSpanStarted();

      await new Promise<void>(resolve => {
        new SafeSpanExporter(accepting).export([], () => resolve());
      });
      await tick(60);

      assert.deepEqual(warnings, []);
    });
  });
});
