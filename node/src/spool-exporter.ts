/**
 * The exporters that hand undeliverable batches to the spool.
 *
 * Placement is the whole design. These sit *inside* `RedactingSpanExporter`
 * (and, for logs, behind `RedactingLogRecordProcessor`), so everything they see
 * has already been through the content policy — the same ordering argument that
 * makes a retrying transport safe, with a sharper consequence: a spool above
 * the redactor would write raw prompts to a customer's disk under
 * `capture: 'none'`.
 *
 * The exporter is also the only surface still ours under
 * `initWithExternalProvider()`, where the host SDK owns the processor list. One
 * implementation covers both entry modes.
 *
 * Serialization is lazy. A healthy process pays nothing for having a spool
 * configured: the bytes are only produced once the transport has already failed
 * — or, under `mode: 'only'`, in place of a transport that was never built.
 */
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { JsonLogsSerializer, JsonTraceSerializer } from '@opentelemetry/otlp-transformer';
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import type { Spool } from './spool.ts';

/**
 * Statuses where spooling would only ever produce a file the reader posts
 * forever and ingest keeps refusing. A malformed or oversized body is not a
 * delivery problem, and disk is too expensive to spend on one.
 *
 * Everything else spools, including anything unrecognised: on this side of the
 * decision the failure mode is a file that turns out to be undeliverable, and
 * on the other it is telemetry that is gone.
 */
const PERMANENT_STATUSES = new Set([400, 404, 405, 409, 413, 415, 422, 501]);

/**
 * `ExportResult.error` is an `OTLPExporterError` whose `code` is the HTTP
 * status; a connection refused, a DNS failure or a timeout arrives as a plain
 * `Error` with no code at all, which is exactly the case the spool exists for.
 */
export const isSpoolable = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null || !('code' in error)) return true;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'number') return true;
  return !PERMANENT_STATUSES.has(code);
};

export interface SpoolingExporterOptions<T> {
  /** Omitted under `mode: 'only'`, where disk is the sink rather than the fallback. */
  inner?: T;
  spool: Spool;
}

/**
 * Once a batch is on the queue for disk we report SUCCESS: custody has moved,
 * and telling a host SDK about a failure it cannot act on only produces log
 * noise. A batch the spool *refuses* keeps the failure it had.
 */
const settle = (accepted: boolean, original: ExportResult): ExportResult =>
  accepted ? { code: ExportResultCode.SUCCESS } : original;

const REFUSED: ExportResult = {
  code: ExportResultCode.FAILED,
  error: new Error('octic-telemetry: spool unavailable'),
};

export class SpoolingSpanExporter implements SpanExporter {
  private readonly inner: SpanExporter | undefined;
  private readonly spool: Spool;

  constructor({ inner, spool }: SpoolingExporterOptions<SpanExporter>) {
    this.inner = inner;
    this.spool = spool;
    this.spool.retain();
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (this.inner === undefined) {
      resultCallback(settle(this.toDisk(spans), REFUSED));
      return;
    }

    try {
      this.inner.export(spans, result => {
        if (result.code === ExportResultCode.SUCCESS || !isSpoolable(result.error)) {
          resultCallback(result);
          return;
        }
        resultCallback(settle(this.toDisk(spans), result));
      });
    } catch (error) {
      /** A transport that throws synchronously is a transport that failed. */
      resultCallback(settle(this.toDisk(spans), { code: ExportResultCode.FAILED, error: error as Error }));
    }
  }

  private toDisk(spans: ReadableSpan[]): boolean {
    const body = JsonTraceSerializer.serializeRequest(spans);
    if (body === undefined) return false;
    return this.spool.write('traces', body);
  }

  async shutdown(): Promise<void> {
    await Promise.all([this.inner?.shutdown(), this.spool.release()]);
  }

  async forceFlush(): Promise<void> {
    await Promise.all([this.inner?.forceFlush?.(), this.spool.forceFlush()]);
  }
}

export class SpoolingLogRecordExporter implements LogRecordExporter {
  private readonly inner: LogRecordExporter | undefined;
  private readonly spool: Spool;

  constructor({ inner, spool }: SpoolingExporterOptions<LogRecordExporter>) {
    this.inner = inner;
    this.spool = spool;
    this.spool.retain();
  }

  export(records: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    if (this.inner === undefined) {
      resultCallback(settle(this.toDisk(records), REFUSED));
      return;
    }

    try {
      this.inner.export(records, result => {
        if (result.code === ExportResultCode.SUCCESS || !isSpoolable(result.error)) {
          resultCallback(result);
          return;
        }
        resultCallback(settle(this.toDisk(records), result));
      });
    } catch (error) {
      resultCallback(
        settle(this.toDisk(records), { code: ExportResultCode.FAILED, error: error as Error }),
      );
    }
  }

  private toDisk(records: ReadableLogRecord[]): boolean {
    const body = JsonLogsSerializer.serializeRequest(records);
    if (body === undefined) return false;
    return this.spool.write('logs', body);
  }

  async shutdown(): Promise<void> {
    await Promise.all([this.inner?.shutdown(), this.spool.release()]);
  }

  async forceFlush(): Promise<void> {
    await Promise.all([this.inner?.forceFlush(), this.spool.forceFlush()]);
  }
}
