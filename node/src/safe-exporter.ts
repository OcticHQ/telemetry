/**
 * The outermost link of each exporter chain, and the only place that knows the
 * chain is a chain.
 *
 * Two properties, both of which are properties of the *composition* rather than
 * of any one exporter, which is why they cannot live in `RedactingSpanExporter`
 * or `SpoolingSpanExporter`:
 *
 *   1. `resultCallback` fires exactly once. A processor tracks in-flight
 *      exports by counting callbacks; a second call corrupts that accounting
 *      and a missing one stalls it forever. `SpoolingSpanExporter` invokes the
 *      callback on every path it owns, but "every path" is a claim about one
 *      link, and PR4 inserts another link into the middle of the chain.
 *   2. A synchronous throw becomes a FAILED result. A `SpanExporter` that
 *      throws instead of calling back violates the interface, and the caller —
 *      the span processor, inside the tracer — is in no position to recover.
 *
 * It also owns the counters, because it is the one point every batch passes
 * through exactly once whatever the chain underneath is arranged to do.
 */
import { diag } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { count } from './counters.ts';

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/**
 * `items` is only read for its length, and only on the traces side. Counting
 * spans rather than batches is what makes the number comparable with what a
 * consumer sees at the other end; failures stay batch-shaped because a failed
 * batch is one event, not N.
 */
const guardExport = (
  signal: 'traces' | 'logs',
  items: readonly unknown[],
  resultCallback: (result: ExportResult) => void,
  run: (settle: (result: ExportResult) => void) => void,
): void => {
  let settled = false;

  const settle = (result: ExportResult): void => {
    if (settled) {
      count('duplicateCallbacks');
      diag.warn(`octic-telemetry: ${signal} exporter reported a result twice; ignoring the second`);
      return;
    }
    settled = true;

    if (result.code === ExportResultCode.SUCCESS) {
      if (signal === 'traces') count('spansAccepted', items.length);
    } else {
      count('exportsFailed');
      diag.warn(`octic-telemetry: ${signal} export failed`, result.error);
    }

    resultCallback(result);
  };

  try {
    run(settle);
  } catch (error) {
    /**
     * Not `throw`: the caller is a span processor running inside `Span.end()`.
     * A FAILED result is a thing it knows how to handle; an exception is not.
     */
    settle({ code: ExportResultCode.FAILED, error: asError(error) });
  }
};

/**
 * Deliberately not "and if the inner exporter never calls back, time it out".
 * A timeout here would race the exporter's own `exportTimeoutMillis` and there
 * is no result this layer could invent that is more true than "still waiting".
 * An inner exporter that never settles is a bug in that exporter.
 */
export class SafeSpanExporter implements SpanExporter {
  private readonly inner: SpanExporter;

  constructor(inner: SpanExporter) {
    this.inner = inner;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    guardExport('traces', spans, resultCallback, settle => {
      this.inner.export(spans, settle);
    });
  }

  async shutdown(): Promise<void> {
    try {
      await this.inner.shutdown();
    } catch (error) {
      diag.warn('octic-telemetry: traces exporter shutdown failed', error);
    }
  }

  async forceFlush(): Promise<void> {
    try {
      await this.inner.forceFlush?.();
    } catch (error) {
      diag.warn('octic-telemetry: traces exporter flush failed', error);
    }
  }
}

export class SafeLogRecordExporter implements LogRecordExporter {
  private readonly inner: LogRecordExporter;

  constructor(inner: LogRecordExporter) {
    this.inner = inner;
  }

  export(records: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    guardExport('logs', records, resultCallback, settle => {
      this.inner.export(records, settle);
    });
  }

  async shutdown(): Promise<void> {
    try {
      await this.inner.shutdown();
    } catch (error) {
      diag.warn('octic-telemetry: logs exporter shutdown failed', error);
    }
  }

  async forceFlush(): Promise<void> {
    try {
      await this.inner.forceFlush();
    } catch (error) {
      diag.warn('octic-telemetry: logs exporter flush failed', error);
    }
  }
}
