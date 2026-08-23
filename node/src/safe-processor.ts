/**
 * The boundary between this SDK's callbacks and the stack that calls them.
 *
 * `SpanProcessor.onStart` is the dangerous one, and it is dangerous because of
 * *where* it runs, not what it does: the tracer calls it synchronously from
 * inside `startSpan`, which is inside whatever instrumentation created the
 * span, which is inside the customer's request handler. A throw there does not
 * lose telemetry — it takes out the call the customer was actually making.
 *
 * What can reach it today, so this is a list rather than a posture:
 *
 *   - a Context-shaped object whose `getValue` is not a function. Host SDKs
 *     pass their own context type into processors they own; ours reads four
 *     scopes off it.
 *   - a getter or Proxy inside an `Identity`, `Agent` or `Prompt` value. The
 *     scopes call `toAttributes`, which touches every field.
 *   - `identity.attributes` set to something `Object.entries` refuses.
 *
 * Everything else is defense in depth, and defense in depth is the correct
 * posture for a callback registered into someone else's control flow.
 *
 * This wraps *our* callback, and only ours. It is not an error sink for the
 * pipeline: the customer's own `fn` inside `withWorkflow` is never routed
 * through here, and a host SDK's other processors are called by the provider,
 * not by us.
 */
import { diag } from '@opentelemetry/api';
import type { Context } from '@opentelemetry/api';
import type { LogRecordProcessor, SdkLogRecord } from '@opentelemetry/sdk-logs';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { count } from './counters.ts';

const swallow = (where: string, error: unknown): void => {
  count('processorErrors');
  diag.warn(`octic-telemetry: ${where} failed and was suppressed`, error);
};

/** Both wrappers share every lifecycle method; only the emit hook differs. */
const guarded = async (where: string, run: () => Promise<void>): Promise<void> => {
  try {
    await run();
  } catch (error) {
    swallow(where, error);
  }
};

export class SafeSpanProcessor implements SpanProcessor {
  private readonly inner: SpanProcessor;

  constructor(inner: SpanProcessor) {
    this.inner = inner;
  }

  onStart(span: Span, parentContext: Context): void {
    try {
      this.inner.onStart(span, parentContext);
    } catch (error) {
      swallow('onStart', error);
    }
  }

  onEnd(span: ReadableSpan): void {
    try {
      this.inner.onEnd(span);
    } catch (error) {
      swallow('onEnd', error);
    }
  }

  /**
   * Rejections too, not only throws. `forceFlush` is reachable from the
   * customer's own graceful-shutdown path, where an unhandled rejection is a
   * non-zero exit code on a process that was shutting down cleanly.
   */
  async forceFlush(): Promise<void> {
    await guarded('forceFlush', () => this.inner.forceFlush());
  }

  async shutdown(): Promise<void> {
    await guarded('shutdown', () => this.inner.shutdown());
  }
}

/**
 * The logs half. `onEmit` runs synchronously inside the customer's
 * `logger.emit()` call and reaches further than `onStart` does — it mutates the
 * record through `setBody`/`setAttribute` and it invokes the customer's own
 * `redact` hook.
 */
export class SafeLogRecordProcessor implements LogRecordProcessor {
  private readonly inner: LogRecordProcessor;

  constructor(inner: LogRecordProcessor) {
    this.inner = inner;
  }

  onEmit(record: SdkLogRecord, context?: Context): void {
    try {
      this.inner.onEmit(record, context);
    } catch (error) {
      swallow('onEmit', error);
    }
  }

  async forceFlush(): Promise<void> {
    await guarded('forceFlush', () => this.inner.forceFlush());
  }

  async shutdown(): Promise<void> {
    await guarded('shutdown', () => this.inner.shutdown());
  }
}
