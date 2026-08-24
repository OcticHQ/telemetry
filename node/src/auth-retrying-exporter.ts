/**
 * One refresh-and-retry when ingest says 401.
 *
 * The headers factory cannot do this. It runs *before* a send and never sees
 * the response, so it can renew a token on a schedule but cannot notice that
 * the one it just handed over was refused. Something has to observe the export
 * result, and the smallest thing that can is an exporter wrapper.
 *
 * What makes it cheap is that the status survives the trip: on a non-retryable
 * non-2xx the pinned exporter's Node transport produces
 * `new OTLPExporterError(statusMessage, statusCode, body)` and passes it
 * straight to `resultCallback`, so the HTTP status arrives here as a number on
 * `error.code` — the same field `isSpoolable()` already reads. 401 is not in
 * the exporter's own retryable set (429/502/503/504), so it takes exactly this
 * path: one clean failure, no internal retry to race.
 *
 * **Position in the chain is deliberate.** This sits *inside* the spool —
 * `Safe → Redacting → Spooling → AuthRetrying → OTLP` — so a 401 the retry
 * fixes never touches disk, and a 401 that survives the retry still falls
 * through to the spool, 401 being correctly absent from `PERMANENT_STATUSES`.
 *
 * It is inserted only under `auth: { kind: 'enrollmentToken' }`. Re-sending a
 * static API key that was just rejected accomplishes nothing but a second 401.
 */
import { diag } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { count } from './counters.ts';
import { httpStatusOf } from './spool-exporter.ts';
import type { TokenManager } from './token-manager.ts';

const UNAUTHORIZED = 401;

/**
 * Latched across both signals and the whole process: a wrong issuer produces a
 * 401 on every batch of both signals, and the diagnosis is the same sentence
 * every time. One line is a clue; one line per batch is noise that buries it.
 */
let warned = false;

/** Test seam. `init()` latches per process and so does this. */
export const resetAuthWarning = (): void => {
  warned = false;
};

/**
 * Deliberately generic. Everything specific enough to be useful — the issuer
 * the token claims, the audience ingest expected — is inside a credential, and
 * deciding what is safe to print from one is a decision worth making against a
 * real support ticket rather than in advance. The two URLs are configuration,
 * not secrets, and a mismatch between them is the common cause.
 */
const warnOnce = (endpointUrl: string, tokenUrl: string): void => {
  if (warned) return;
  warned = true;
  diag.warn(
    `octic-telemetry: ingest at ${endpointUrl} rejected a freshly minted token (401). ` +
      `The token came from ${tokenUrl}. Check that the two point at the same environment ` +
      'and that the enrollment token belongs to it.',
  );
};

const isUnauthorized = (result: ExportResult): boolean =>
  result.code === ExportResultCode.FAILED && httpStatusOf(result.error) === UNAUTHORIZED;

export interface AuthRetryingExporterOptions<T> {
  inner: T;
  tokens: TokenManager;
  /** Both are for the diagnostic only; neither is used to build a request. */
  endpointUrl: string;
  tokenUrl: string;
}

/**
 * `send` is the inner exporter's `export`, curried by the caller so this
 * function never has to know whether it is holding spans or log records.
 *
 * The `settled` latch is local and not the same guarantee `SafeSpanExporter`
 * provides. That one protects the *processor* from a chain that reports twice;
 * this one protects the retry from being triggered twice by a single failed
 * export, which would double-invalidate the token and re-send the same batch
 * more than once.
 */
const retryOnUnauthorized = (
  send: (done: (result: ExportResult) => void) => void,
  resultCallback: (result: ExportResult) => void,
  { tokens, endpointUrl, tokenUrl }: Omit<AuthRetryingExporterOptions<unknown>, 'inner'>,
): void => {
  let settled = false;
  const settle = (result: ExportResult): void => {
    if (settled) return;
    settled = true;
    resultCallback(result);
  };

  send(first => {
    if (settled) return;
    if (!isUnauthorized(first)) {
      settle(first);
      return;
    }

    /**
     * Drop the cached token *before* re-sending, so the headers factory mints
     * rather than serving the credential ingest just refused.
     */
    tokens.invalidate();
    count('authRetries');

    send(second => {
      if (isUnauthorized(second)) warnOnce(endpointUrl, tokenUrl);
      settle(second);
    });
  });
};

export class AuthRetryingSpanExporter implements SpanExporter {
  private readonly options: AuthRetryingExporterOptions<SpanExporter>;

  constructor(options: AuthRetryingExporterOptions<SpanExporter>) {
    this.options = options;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const { inner, ...rest } = this.options;
    retryOnUnauthorized(
      done => {
        inner.export(spans, done);
      },
      resultCallback,
      rest,
    );
  }

  shutdown(): Promise<void> {
    return this.options.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.options.inner.forceFlush?.() ?? Promise.resolve();
  }
}

export class AuthRetryingLogRecordExporter implements LogRecordExporter {
  private readonly options: AuthRetryingExporterOptions<LogRecordExporter>;

  constructor(options: AuthRetryingExporterOptions<LogRecordExporter>) {
    this.options = options;
  }

  export(records: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    const { inner, ...rest } = this.options;
    retryOnUnauthorized(
      done => {
        inner.export(records, done);
      },
      resultCallback,
      rest,
    );
  }

  shutdown(): Promise<void> {
    return this.options.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.options.inner.forceFlush();
  }
}
