/**
 * OTLP wiring, pre-assembled.
 *
 * Ships no instrumentation. The consumer brings their own; `OcticSpanProcessor`
 * enriches whatever they bring.
 *
 *   init()                      creates and registers the global TracerProvider
 *   initWithExternalProvider()  when another SDK owns it — returns the parts to
 *                               hand over, and is not complete until you do
 */
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { ExportResultCode } from '@opentelemetry/core';
/**
 * OTLP/JSON, and the package name is the whole of the pin — there is no
 * `protocol` option on either exporter to say it twice.
 *
 * `…-otlp-http` serializes JSON; `…-otlp-proto-http` serializes protobuf, and
 * protobuf is what a stock OTLP/HTTP exporter sends, so a reader arriving here
 * from the OpenTelemetry docs will expect the opposite of what this does.
 * `docs/wire-format.md` states JSON as deliberate and `init.ts` writes
 * `contentType: 'application/json'` into every spool manifest, which a
 * downstream reader POSTs the segment with — so a swap of either import is a
 * silent lie in three places at once. `init.integration.test.ts` asserts the
 * received content type for that reason.
 */
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
} from '@opentelemetry/sdk-logs';
/**
 * `BatchSpanProcessor` from `@opentelemetry/sdk-trace`, not from
 * `@opentelemetry/sdk-trace-base`. The latter re-exports a shim that reads
 * `OTEL_BSP_*` and whose config type has no `selfObsMeterProvider` — see
 * batching.ts for why neither is wanted here. Same package, same version;
 * sdk-trace-base pins it and re-exports most of it already.
 */
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace';
import type { SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { agentAttributes, type Agent } from './agent.ts';
import {
  AuthRetryingLogRecordExporter,
  AuthRetryingSpanExporter,
} from './auth-retrying-exporter.ts';
import { resolveAuth, type AuthOptions } from './auth.ts';
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_OCTIC_SCHEMA_VERSION,
  ATTR_OCTIC_SDK_NAME,
  ATTR_OCTIC_SDK_VERSION,
  OCTIC_SCHEMA_VERSION,
} from './attributes.ts';
import { resolveBatchOptions, type BatchOptions } from './batching.ts';
import { installLoaderHook } from './loader-hook.ts';
import { resolvePolicy, setActivePolicy, type ContentOptions } from './content.ts';
import { OcticSpanProcessor } from './processor.ts';
import { RedactingLogRecordProcessor } from './redacting-log-processor.ts';
import { RedactingSpanExporter } from './redacting-exporter.ts';
import { SafeLogRecordExporter, SafeSpanExporter } from './safe-exporter.ts';
import { SafeLogRecordProcessor, SafeSpanProcessor } from './safe-processor.ts';
import { queueDropMeterProvider } from './self-metrics.ts';
import { cancelSilenceWatch, configureSilenceWatch } from './silence-watch.ts';
import { SpoolingLogRecordExporter, SpoolingSpanExporter } from './spool-exporter.ts';
import { TokenManager } from './token-manager.ts';
import {
  resolveSpoolOptions,
  Spool,
  type SpoolMode,
  type SpoolOptions,
  type SpoolStats,
} from './spool.ts';
import { SDK_NAME, SDK_VERSION } from './version.ts';

export interface InitOptions {
  /** Base URL of the collector. `/v1/traces` and `/v1/logs` are appended. */
  endpoint: string;
  /**
   * How this process authenticates to ingest. Three shapes, in `auth.ts`:
   * `{ kind: 'apiKey', apiKey }` sends a long-lived key verbatim,
   * `{ kind: 'enrollmentToken', enrollmentToken, tokenUrl }` exchanges a tenant
   * enrollment token for short-lived ingest JWTs and keeps renewing them, and
   * `'none'` sends no credential at all — what a local forwarder expects.
   *
   * A credential that is absent or empty is not fatal: it disables the
   * transport and turns the spool on, because a process that cannot
   * authenticate can still keep its telemetry. Nothing about the spool changes
   * between the modes except that `'none'` and a missing credential turn it on
   * by default.
   */
  auth?: AuthOptions;
  serviceName: string;
  serviceVersion?: string;
  /**
   * The agent this process runs, when there is only one. Lands as a resource
   * attribute, so every span carries it at no per-span cost. A process hosting
   * several agents overrides this per run with `withAgent()`.
   */
  agent?: Agent;
  /** `production`, `staging`, … */
  environment?: string;
  /** Extra resource attributes — tenant identifiers and so on. */
  resourceAttributes?: Record<string, string>;
  /**
   * Whether prompts, tool arguments and model output leave the process, and in
   * what form. Defaults to `{ capture: 'full' }` while this is early — see the
   * note at the top of `content.ts`. Set `{ capture: 'none' }` to send no
   * customer data at all, or `'metadata'` for length plus hash; every
   * governance attribute ships identically at all three.
   */
  content?: ContentOptions;
  /**
   * Where telemetry goes when it cannot be delivered — a dead endpoint, a
   * credential that does not work, a forwarder that is not up. Off by default
   * for a normal authenticated process; on by default under `auth: 'none'`, a
   * missing key, or `spool: { mode: 'only' }`. See spool.ts and
   * ../../contract/SPOOL.md.
   */
  spool?: SpoolOptions;
  /**
   * Queue sizes and delays for both signals. Every field defaults; see
   * batching.ts. Raising `scheduledDelayMillis` trades freshness for fewer
   * requests, and is also how much is at risk in a process that exits without
   * calling `shutdown()`.
   */
  batch?: BatchOptions;
  /**
   * Whether to install the ESM loader hook. Defaults to true, which is what an
   * application wants: without it, ESM auto-instrumentation patches nothing.
   *
   * Set it false when something else already installed one — a host SDK, a
   * `--import` shim, or a runtime that arranges its own — because a second
   * registration is a second loader in the chain rather than a no-op. See
   * loader-hook.ts.
   */
  loaderHook?: boolean;
}

export interface SpoolHandle {
  /** Undefined until the directory cascade settles, and if it never does. */
  directory: () => string | undefined;
  mode: SpoolMode;
  stats: () => SpoolStats;
  /** Everything queued is on disk, or was lost trying. */
  flush: () => Promise<void>;
}

export interface Telemetry {
  forceFlush: () => Promise<void>;
  shutdown: () => Promise<void>;
  /** Present only when spooling is enabled. */
  spool?: SpoolHandle;
}

export interface ExternalProviderTelemetry {
  /**
   * Hand both to the host SDK: the processor to enrich, the exporter to ship.
   *
   * Typed as the interface rather than `OcticSpanProcessor` because what
   * you get is the enricher inside a guard that stops it throwing into the
   * host SDK's `startSpan`. Pass it along; nothing here is meant to be
   * inspected.
   */
  spanProcessor: SpanProcessor;
  /** Redaction-wrapped. Handing over the raw OTLP exporter would bypass policy. */
  spanExporter: SpanExporter;
  /**
   * For host SDKs with their own content switch — pass it through
   * (`traceloop.initialize({ traceContent: telemetry.captureContent })`) so
   * content is never produced rather than produced and stripped.
   */
  captureContent: boolean;
  /**
   * Logs only — both of them. The spans are in the host SDK's provider, so
   * flush and stop those there. The names lost the `Logs` suffix when this
   * interface was tidied for publication; the scope did not change.
   */
  forceFlush: () => Promise<void>;
  shutdown: () => Promise<void>;
  /**
   * Present only when spooling is enabled. The spool rides inside
   * `spanExporter`, so it is live in this mode too — but only once the host SDK
   * has actually been handed that exporter.
   */
  spool?: SpoolHandle;
}

/**
 * `provenanceOnSpans` is for the case where a host SDK owns the provider: the
 * resource then belongs to that SDK, so the agent, environment and SDK version
 * would never reach a span. The processor applies them per span instead.
 */
const setup = (
  {
    endpoint,
    auth,
    serviceName,
    serviceVersion = '0.0.0',
    agent,
    environment,
    resourceAttributes = {},
    content,
    spool,
    batch,
    loaderHook = true,
  }: InitOptions,
  { provenanceOnSpans }: { provenanceOnSpans: boolean },
) => {
  if (process.env.OCTIC_TELEMETRY_DEBUG === '1') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  /**
   * ESM auto-instrumentation patches modules as they load, which needs a loader
   * hook; without it a run exits 0 having emitted nothing. Only effective if
   * this runs before the instrumented library is imported, hence
   * `node --import ./telemetry.ts server.ts`. Which of the two hooks gets
   * installed is `loader-hook.ts`'s business.
   *
   * A library bundling its own nested copy of import-in-the-middle is not
   * served by this registration and needs its own escape hatch. `loaderHook:
   * false` is the escape hatch for the other direction — a host that has
   * already installed one.
   */
  if (loaderHook) installLoaderHook();

  const provenance = {
    /**
     * Which version of the attribute contract these spans were written against.
     * Rides with the SDK name and version because it answers the same question
     * from the consumer's side: `octic.sdk.version` says what produced this,
     * this says what shape to expect. Without it a missing attribute and an
     * older SDK are indistinguishable.
     */
    [ATTR_OCTIC_SCHEMA_VERSION]: OCTIC_SCHEMA_VERSION,
    [ATTR_OCTIC_SDK_NAME]: SDK_NAME,
    [ATTR_OCTIC_SDK_VERSION]: SDK_VERSION,
    ...(environment === undefined ? {} : { [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: environment }),
    ...(agent === undefined ? {} : agentAttributes(agent)),
  };

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: serviceVersion,
    ...provenance,
    ...resourceAttributes,
  });

  /**
   * A missing credential is a real deployment — a container whose secret was
   * not mounted, an operator who has not issued an enrollment token yet.
   * Throwing takes the consumer's process down over telemetry; sending
   * `Bearer undefined` produces a 401 per batch and loses everything. So the
   * transport is switched off and the spool takes custody instead, which is the
   * whole reason it exists.
   *
   * An enrollment token counts as credentialed even though there is no token
   * yet: the first exchange has not resolved when this line runs, and treating
   * "not minted yet" as "no credential" would pin the process to `mode: 'only'`
   * for its whole life over a round trip that takes milliseconds.
   */
  const resolvedAuth = resolveAuth(auth);
  if (resolvedAuth.mode === 'missing') {
    diag.warn(
      `octic-telemetry: ${resolvedAuth.reason}; not exporting over HTTP. ` +
        'Telemetry will be spooled to disk for the reader to deliver.',
    );
  }
  const credentialed = resolvedAuth.mode !== 'missing';

  const spoolConfig = resolveSpoolOptions(spool, {
    enabledByDefault: resolvedAuth.mode === 'none' || !credentialed || spool?.mode === 'only',
  });
  /** Nothing to fall back *from* when there is no credential. */
  const spoolMode: SpoolMode = credentialed ? spoolConfig.mode : 'only';
  const transport = spoolConfig.enabled ? spoolMode !== 'only' : true;

  /**
   * Only built when there is something for it to authenticate: under
   * `mode: 'only'` nothing is sent, and minting tokens for a transport that
   * does not exist is traffic at the control plane for no reason.
   */
  const tokenManager =
    resolvedAuth.mode === 'enrollmentToken' && transport
      ? new TokenManager({
          enrollmentToken: resolvedAuth.enrollmentToken,
          tokenUrl: resolvedAuth.tokenUrl,
        })
      : undefined;
  /** Not awaited — see `TokenManager.start`. `setup()` stays synchronous. */
  tokenManager?.start();

  /**
   * A function, not an object, in enrollment-token mode. The pinned exporter
   * awaits `headers()` before every send, which is the hook that lets a token
   * minted after `init()` reach a request that was configured before it.
   */
  const headers =
    tokenManager !== undefined
      ? tokenManager.headers
      : resolvedAuth.mode === 'apiKey'
        ? { authorization: `Bearer ${resolvedAuth.apiKey}` }
        : {};
  const base = endpoint.replace(/\/$/, '');

  /**
   * Set before anything can emit: the annotations read it to decide whether to
   * serialize their input and output at all.
   */
  const contentPolicy = resolvePolicy(content);
  setActivePolicy(contentPolicy);

  const batchOptions = resolveBatchOptions(batch);
  /**
   * Armed by the first span, not by this call — a process that legitimately
   * produces no telemetry has nothing to warn about.
   */
  configureSilenceWatch();

  /**
   * Wrapped here rather than at each call site so both entry modes get it —
   * including the one where the processor is handed to a host SDK and this
   * package never sees it called again.
   */
  const spanProcessor = new SafeSpanProcessor(
    new OcticSpanProcessor(provenanceOnSpans ? provenance : {}),
  );

  const signalPaths = { traces: '/v1/traces', logs: '/v1/logs' } as const;
  const spoolInstance = spoolConfig.enabled
    ? new Spool(
        { ...spoolConfig, mode: spoolMode },
        {
          endpoint: base,
          signalPaths,
          contentType: 'application/json',
          contentEncoding: 'identity',
          serviceName,
          octicSchemaVersion: OCTIC_SCHEMA_VERSION,
          sdkName: SDK_NAME,
          sdkVersion: SDK_VERSION,
          contentCapture: contentPolicy.capture,
        },
      )
    : undefined;

  /**
   * The redaction wrapper goes around everything else, so it survives being
   * handed to a host SDK that arranges its own processors — see
   * redacting-exporter.ts — and so the spool inside it can only ever see spans
   * the content policy has already been applied to.
   */
  /**
   * The transport is only ever absent when the spool is there to replace it,
   * which is what the two `!` below assert. The invariant is real but lives in
   * `resolveTransport`, so the checker cannot see it from here, and expressing
   * it properly means either restructuring this branch or throwing when both
   * are missing — a behaviour change, so not in this pull request.
   */
  /**
   * `AuthRetrying*` goes here, between the OTLP exporter and everything above
   * it: inside the spool, so a 401 the retry fixes never touches disk, and
   * still above nothing, so a 401 that survives the retry spools like any other
   * transient failure. Absent in the other two auth modes — re-sending a static
   * key that was just refused only produces a second 401.
   */
  const withAuthRetry = <T>(
    inner: T,
    wrap: (options: { inner: T; tokens: TokenManager; endpointUrl: string; tokenUrl: string }) => T,
  ): T =>
    tokenManager === undefined || resolvedAuth.mode !== 'enrollmentToken'
      ? inner
      : wrap({
          inner,
          tokens: tokenManager,
          endpointUrl: base,
          tokenUrl: resolvedAuth.tokenUrl,
        });

  const traceTransport = transport
    ? withAuthRetry<SpanExporter>(
        new OTLPTraceExporter({ url: `${base}${signalPaths.traces}`, headers }),
        options => new AuthRetryingSpanExporter(options),
      )
    : undefined;
  /**
   * `SafeSpanExporter` is the outermost link, not an inner one: exactly-once
   * `resultCallback` and "a synchronous throw is a FAILED result" are
   * properties of the whole chain, and PR4 inserts another link into the
   * middle of it.
   */
  const spanExporter = new SafeSpanExporter(
    new RedactingSpanExporter(
      spoolInstance === undefined
        ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- see the invariant above
          traceTransport!
        : new SpoolingSpanExporter({
            ...(traceTransport === undefined ? {} : { inner: traceTransport }),
            spool: spoolInstance,
          }),
      contentPolicy,
    ),
  );

  const logTransport = transport
    ? withAuthRetry<LogRecordExporter>(
        new OTLPLogExporter({ url: `${base}${signalPaths.logs}`, headers }),
        options => new AuthRetryingLogRecordExporter(options),
      )
    : undefined;
  const logExporter = new SafeLogRecordExporter(
    spoolInstance === undefined
      ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- see the invariant above
        logTransport!
      : new SpoolingLogRecordExporter({
          ...(logTransport === undefined ? {} : { inner: logTransport }),
          spool: spoolInstance,
        }),
  );

  /**
   * Registered unconditionally: some instrumentation puts no message content on
   * spans and emits it on the logs signal instead. With no LoggerProvider those
   * records reach the global no-op logger and are dropped silently.
   */
  const loggerProvider = new LoggerProvider({
    resource,
    /**
     * Order matters and is the whole mechanism: MultiLogRecordProcessor calls
     * onEmit in array order, and sdk-logs sanctions mutation during onEmit, so
     * the redactor must sit ahead of the processor that exports.
     */
    processors: [
      /**
       * Wrapped for the same reason `onStart` is: `onEmit` runs synchronously
       * inside the customer's `logger.emit()`, and it reaches further — it
       * mutates the record and it calls the customer's own `redact` hook.
       */
      new SafeLogRecordProcessor(new RedactingLogRecordProcessor(contentPolicy)),
      /**
       * Guarded like the redactor beside it, for the half of the job the
       * exporter's own guard cannot do: `BatchLogRecordProcessor.forceFlush`
       * and `.shutdown()` **reject** when a batch fails
       * (`BatchLogRecordProcessorBase.js`), and both are reachable from the
       * consumer's own shutdown path.
       */
      new SafeLogRecordProcessor(
        new BatchLogRecordProcessor({
          exporter: logExporter,
          ...batchOptions,
          selfObsMeterProvider: queueDropMeterProvider(),
        }),
      ),
    ],
  });
  logs.setGlobalLoggerProvider(loggerProvider);

  return {
    resource,
    spanProcessor,
    spanExporter,
    loggerProvider,
    contentPolicy,
    batchOptions,
    spool: spoolInstance,
    tokenManager,
  };
};

/** The public view of the spool, so nothing outside this package holds the object itself. */
const spoolHandle = (spool: Spool | undefined): SpoolHandle | undefined =>
  spool === undefined
    ? undefined
    : {
        directory: () => spool.directory,
        mode: spool.config.mode,
        stats: () => spool.stats(),
        flush: () => spool.forceFlush(),
      };

type Parts = ReturnType<typeof setup>;

/**
 * What this process has already done, so it is never done twice.
 *
 * The old guard was a boolean set *before* any work, and it threw. Both halves
 * were wrong. Throwing is a library taking an application down over telemetry,
 * and setting the flag first meant a single partial failure locked the process
 * out permanently behind the message "already initialized", which was not what
 * had happened.
 *
 * The replacement never re-runs `setup()`, because `setup()` is not idempotent
 * and its non-idempotence is invisible rather than loud:
 *
 *   - `installLoaderHook()` would install a second ESM loader hook on the
 *     asynchronous path. (The synchronous one notices and warns instead, which
 *     is luck rather than a guarantee.) This is the one bullet a caller can
 *     switch off — `loaderHook: false` skips it — and the other four still
 *     hold, so the latch does not become optional along with it.
 *   - `logs.setGlobalLoggerProvider` *silently ignores* a second registration
 *     and keeps the first, so the second LoggerProvider is dangling and the
 *     handle built around it flushes something no log record reaches.
 *   - `tracerProvider.register()` behaves the same way.
 *   - `setActivePolicy` would re-point the module-global policy while the
 *     first pipeline's exporters still hold the old object.
 *   - a second `Spool` would take custody of the same directory, with its own
 *     manifest, eviction and bounds bookkeeping, and the first would never be
 *     released.
 *
 * `degraded` is the case worth naming: `setup()` succeeded — so the global
 * LoggerProvider is registered and the spool is retained — and something after
 * it did not. Returning an inert handle there would orphan a live logs
 * pipeline that nothing could then flush or stop, so the handle keeps the
 * halves that exist.
 */
type State =
  | { kind: 'own'; parts: Parts; tracerProvider: NodeTracerProvider }
  | { kind: 'external'; parts: Parts }
  | { kind: 'degraded'; parts: Parts }
  | { kind: 'failed' };

let state: State | undefined;

const INERT: Telemetry = {
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

/** Enough of a `SpanProcessor` to be handed to a host SDK that will call it. */
const inertProcessor: SpanProcessor = {
  onStart: () => undefined,
  onEnd: () => undefined,
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

const inertExporter: SpanExporter = {
  export: (_spans, resultCallback) => {
    resultCallback({
      code: ExportResultCode.FAILED,
      error: new Error('octic-telemetry: not initialized'),
    });
  },
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

const INERT_EXTERNAL: ExternalProviderTelemetry = {
  spanProcessor: inertProcessor,
  spanExporter: inertExporter,
  captureContent: false,
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

/**
 * The last guard, and the one the layers below do not make redundant.
 *
 * `forceFlush` and `shutdown` are the two functions a consumer calls by hand,
 * usually from their own SIGTERM path, where a rejection is an unhandled
 * rejection and a clean shutdown becomes a non-zero exit. Guarding our own
 * exporters is not enough to prevent it: `TracerProvider.forceFlush`
 * (`sdk-trace/build/src/TracerProvider.js:92-104`) collects whatever its
 * processors produced and **rejects with an array of errors** — not an Error,
 * an array — and a processor hands it one whenever an export fails. Measured
 * against a dead endpoint under `SimpleSpanProcessor`: the process died on an
 * uncaught `[Error: connect ECONNREFUSED]`. Batching did not retire the
 * hazard, it widened it — `BatchSpanProcessor` rejects `forceFlush` and
 * `shutdown` on a failed batch *and* on its own `exportTimeoutMillis`, so
 * there are now two ways to reach the same crash.
 *
 * So the boundary is drawn here too. Whatever the pipeline does, these return.
 */
const neverRejects = async (what: string, run: () => Promise<void>): Promise<void> => {
  try {
    await run();
  } catch (error) {
    diag.warn(`octic-telemetry: ${what} did not complete cleanly`, error);
  }
};

/**
 * One shutdown per process, however many times it is asked for.
 *
 * The layers below are individually idempotent — `BatchSpanProcessor` latches
 * on `_shutdownOnce`, `Spool.shutdown()` checks `shuttingDown` — so a second
 * call was never destructive. What it was is *slow and misleading*: the second
 * caller awaits a fresh pass over a pipeline with nothing left in it, and any
 * warning it produces describes the second call rather than the one that did
 * the work. A consumer with both a `SIGTERM` handler and a `finally` block has
 * two callers, and both of them are correct to call it.
 */
let shuttingDown: Promise<void> | undefined;

const telemetryFrom = (current: State): Telemetry => {
  if (current.kind === 'failed') return INERT;

  const { loggerProvider, spanExporter, spool, tokenManager } = current.parts;
  const handle = spoolHandle(spool);

  /**
   * Only the `own` case has a provider of ours to drive. In the other two the
   * trace exporter is either the host SDK's to call or nobody's, and shutting
   * it down directly is what releases the spool.
   */
  const flushTraces =
    current.kind === 'own'
      ? () => current.tracerProvider.forceFlush()
      : () => spanExporter.forceFlush();
  const shutdownTraces =
    current.kind === 'own'
      ? () => current.tracerProvider.shutdown()
      : () => spanExporter.shutdown();

  return {
    /**
     * Both halves are attempted even if the first fails: a trace flush that
     * cannot reach the collector is no reason to abandon the logs.
     */
    forceFlush: async () => {
      await neverRejects('flushing traces', flushTraces);
      await neverRejects('flushing logs', () => loggerProvider.forceFlush());
    },
    /**
     * Bounded by `batch.exportTimeoutMillis` per in-flight batch — the queue is
     * drained in parallel, so the whole flush is one timeout, not one per
     * batch — and by the OTLP exporter's own retry deadline inside that. It is
     * safe to `await` on the way out of a service.
     */
    shutdown: async () => {
      shuttingDown ??= (async () => {
        /** Before the flush: the pipeline is stopping, so silence is expected. */
        cancelSilenceWatch();
        /**
         * After the timer, before the flush: the flush still needs a header, so
         * this only stops the *next* refresh and abandons an exchange that is
         * in flight — it never takes a token away from a batch on its way out.
         */
        tokenManager?.shutdown();
        await neverRejects('shutting down traces', shutdownTraces);
        await neverRejects('shutting down logs', () => loggerProvider.shutdown());
      })();
      await shuttingDown;
    },
    ...(handle === undefined ? {} : { spool: handle }),
  };
};

const externalFrom = (current: State): ExternalProviderTelemetry => {
  if (current.kind === 'failed') return INERT_EXTERNAL;

  const { spanProcessor, spanExporter, loggerProvider, contentPolicy, spool, tokenManager } =
    current.parts;
  const handle = spoolHandle(spool);

  return {
    spanProcessor,
    spanExporter,
    captureContent: contentPolicy.capture !== 'none',
    forceFlush: () => neverRejects('flushing logs', () => loggerProvider.forceFlush()),
    /**
     * Latched like `Telemetry.shutdown`, and it cancels the silence watch for
     * the same reason: in this mode the host SDK owns the spans, so its own
     * shutdown is the only signal we get that the process is stopping.
     */
    shutdown: async () => {
      shuttingDown ??= (async () => {
        cancelSilenceWatch();
        tokenManager?.shutdown();
        await neverRejects('shutting down logs', () => loggerProvider.shutdown());
      })();
      await shuttingDown;
    },
    ...(handle === undefined ? {} : { spool: handle }),
  };
};

/**
 * Warns about a second call and hands back what the first one built.
 *
 * The cross-mode warning names the cost rather than hiding it: an
 * `ExternalProviderTelemetry` rebuilt from an `init()` run carries a processor
 * constructed with `provenanceOnSpans: false`, so it stamps no per-span
 * provenance, and the host SDK's resource does not carry it either.
 */
const alreadyInitialized = (current: State, wanted: 'own' | 'external'): void => {
  if (current.kind === 'failed') {
    diag.warn(
      'octic-telemetry: a previous init() failed; returning the same inert handle rather than retrying. ' +
        'Set OCTIC_TELEMETRY_DEBUG=1 to see the original failure.',
    );
    return;
  }
  if (current.kind === wanted) {
    diag.warn('octic-telemetry: already initialized; returning the existing handle.');
    return;
  }
  diag.warn(
    `octic-telemetry: already initialized in "${current.kind}" mode; ignoring this "${wanted}" call ` +
      'and reusing the existing pipeline. Per-span provenance may be missing.',
  );
};

export const init = (options: InitOptions): Telemetry => {
  if (state !== undefined) {
    alreadyInitialized(state, 'own');
    return telemetryFrom(state);
  }

  /**
   * The whole body, not only `setup()`. By the time the provider is built,
   * `setup()` has already registered the global LoggerProvider and retained
   * the spool — so a failure here is `degraded`, not `failed`.
   */
  let parts: Parts | undefined;
  try {
    parts = setup(options, { provenanceOnSpans: false });

    const tracerProvider = new NodeTracerProvider({
      resource: parts.resource,
      spanProcessors: [
        parts.spanProcessor,
        /**
         * Guarded for the same reason the logs half is: `forceFlush` and
         * `shutdown` on a batch processor reject when a batch fails
         * (`BatchSpanProcessorBase.js:112-117, 149-151`), and the provider
         * collects those rejections into an *array* it rejects with. The
         * `neverRejects` guard on the handle catches that too — this one keeps
         * the failure attributable and counted rather than anonymous.
         */
        new SafeSpanProcessor(
          new BatchSpanProcessor({
            exporter: parts.spanExporter,
            ...parts.batchOptions,
            selfObsMeterProvider: queueDropMeterProvider(),
          }),
        ),
      ],
    });
    tracerProvider.register();

    state = { kind: 'own', parts, tracerProvider };
  } catch (error) {
    diag.error('octic-telemetry: init() failed; telemetry is disabled for this process', error);
    state = parts === undefined ? { kind: 'failed' } : { kind: 'degraded', parts };
  }

  return telemetryFrom(state);
};

/**
 * Creates no provider. Until `spanProcessor` and `spanExporter` reach the
 * SDK that owns the provider, no span reaches the endpoint.
 */
export const initWithExternalProvider = (options: InitOptions): ExternalProviderTelemetry => {
  if (state !== undefined) {
    alreadyInitialized(state, 'external');
    return externalFrom(state);
  }

  try {
    state = { kind: 'external', parts: setup(options, { provenanceOnSpans: true }) };
  } catch (error) {
    diag.error(
      'octic-telemetry: initWithExternalProvider() failed; telemetry is disabled for this process',
      error,
    );
    state = { kind: 'failed' };
  }

  return externalFrom(state);
};
