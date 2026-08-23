/**
 * How much telemetry is held, for how long, before it is sent.
 *
 * The proof of concept used `SimpleSpanProcessor`, one HTTP round trip per
 * span — measured at 51 spans producing 51 queue entries of ~2.2 KB each,
 * because every export re-sends the whole resource block. Its comment gave the
 * reason as "batching lets a process exit unflushed", which is a test-harness
 * problem wearing a production decision's clothes. The answer to it is an
 * explicit flush, and this package already has one.
 *
 * What this SDK does **not** do, and will not: register a `beforeExit` hook, a
 * `SIGTERM` handler, or a `flushOnExit` option. `beforeExit` re-arms itself
 * (Node re-emits it whenever the loop drains, and a telemetry SDK is precisely
 * the thing other libraries' `beforeExit` handlers feed with new spans), it
 * never fires on `process.exit()`, an uncaught exception, or any signal —
 * including the container `SIGTERM` that is how most production services stop.
 * A library installing signal handlers silently changes its host's shutdown
 * semantics. So the contract is the other way round: the application calls
 * `shutdown()` from its own graceful-shutdown path, and what is lost without
 * that call is at most `scheduledDelayMillis` worth of queued spans.
 */

/**
 * The four knobs, with the meanings OpenTelemetry gives them. Absent from
 * `InitOptions`, every one of these takes the default below.
 */
export interface BatchOptions {
  /** Spans held before new ones are dropped. Drops are counted. Default 2048. */
  maxQueueSize?: number;
  /** Most spans in one export. Must be ≤ `maxQueueSize`. Default 512. */
  maxExportBatchSize?: number;
  /** How long a partial batch waits for company. Default 5000ms. */
  scheduledDelayMillis?: number;
  /** Ceiling on one export attempt, retries included. Default 30000ms. */
  exportTimeoutMillis?: number;
}

/**
 * Stated here rather than inherited, and passed on every construction, which
 * has a consequence worth knowing: `@opentelemetry/sdk-trace-base` exports a
 * `BatchSpanProcessor` that fills any *undefined* field from `OTEL_BSP_*`
 * environment variables (`BatchSpanProcessor-shim.js:19-32`). Filling all four
 * takes that fallback out of play.
 *
 * That is deliberate. `BatchLogRecordProcessor` has no equivalent fallback at
 * all, so honouring the variables would tune traces and leave logs alone under
 * the same environment — one `OTEL_BSP_SCHEDULE_DELAY` producing two different
 * delays is worse than not reading it. `init({ batch })` is the one place these
 * are set, for both signals, and it is visible in the caller's own source.
 *
 * The values are OpenTelemetry's own defaults, with one exception: the log
 * delay, which upstream sets to 1000ms, is raised to match traces so a run's
 * spans and its log records leave together rather than in two waves.
 */
export const BATCH_DEFAULTS = {
  maxQueueSize: 2048,
  maxExportBatchSize: 512,
  scheduledDelayMillis: 5000,
  exportTimeoutMillis: 30000,
} as const satisfies Required<BatchOptions>;

/** Every field present, so no `OTEL_BSP_*` fallback can reach the processor. */
export const resolveBatchOptions = (options: BatchOptions = {}): Required<BatchOptions> => ({
  maxQueueSize: options.maxQueueSize ?? BATCH_DEFAULTS.maxQueueSize,
  maxExportBatchSize: options.maxExportBatchSize ?? BATCH_DEFAULTS.maxExportBatchSize,
  scheduledDelayMillis: options.scheduledDelayMillis ?? BATCH_DEFAULTS.scheduledDelayMillis,
  exportTimeoutMillis: options.exportTimeoutMillis ?? BATCH_DEFAULTS.exportTimeoutMillis,
});
