/**
 * OTLP wiring, pre-assembled.
 *
 * Ships no instrumentation. The consumer brings their own; the identity
 * processor enriches whatever they bring.
 *
 *   init()                      creates and registers the global TracerProvider
 *   initWithExternalProvider()  when another SDK owns it — returns the parts to
 *                               hand over, and is not complete until you do
 */
import { register } from 'node:module';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { SimpleSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { agentAttributes, type Agent } from './agent.ts';
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_OCTIC_SCHEMA_VERSION,
  ATTR_OCTIC_SDK_NAME,
  ATTR_OCTIC_SDK_VERSION,
  OCTIC_SCHEMA_VERSION,
} from './attributes.ts';
import { resolvePolicy, setActivePolicy, type ContentOptions } from './content.ts';
import { IdentitySpanProcessor } from './processor.ts';
import { RedactingLogRecordProcessor } from './redacting-log-processor.ts';
import { RedactingSpanExporter } from './redacting-exporter.ts';
import { SpoolingLogRecordExporter, SpoolingSpanExporter } from './spool-exporter.ts';
import {
  resolveSpoolOptions,
  Spool,
  type SpoolMode,
  type SpoolOptions,
  type SpoolStats,
} from './spool.ts';

const SDK_NAME = 'octic-node';
const SDK_VERSION = '0.0.0';

export interface InitOptions {
  /** Base URL of the collector. `/v1/traces` and `/v1/logs` are appended. */
  endpoint: string;
  /**
   * Required unless `auth: 'none'`. A missing key is not fatal — it disables the
   * transport and turns the spool on, because a process that cannot
   * authenticate can still keep its telemetry.
   */
  apiKey?: string;
  /**
   * `apiKey` (default) sends `authorization: Bearer <apiKey>`. `none` sends no
   * credential at all, which is what a local forwarder — an OTel Collector on
   * loopback — expects, and what a consumer who does not want to hold a token
   * asks for. Nothing about the spool changes between them except that `none`
   * turns it on by default.
   */
  auth?: 'apiKey' | 'none';
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
  /** Hand both to the host SDK: the processor to enrich, the exporter to ship. */
  identityProcessor: IdentitySpanProcessor;
  /** Redaction-wrapped. Handing over the raw OTLP exporter would bypass policy. */
  traceExporter: SpanExporter;
  /**
   * For host SDKs with their own content switch — pass it through
   * (`traceloop.initialize({ traceContent: telemetry.captureContent })`) so
   * content is never produced rather than produced and stripped.
   */
  captureContent: boolean;
  /** Logs only. The spans are in the host SDK's provider — flush those there. */
  flushLogs: () => Promise<void>;
  shutdownLogs: () => Promise<void>;
  /**
   * Present only when spooling is enabled. The spool rides inside
   * `traceExporter`, so it is live in this mode too — but only once the host SDK
   * has actually been handed that exporter.
   */
  spool?: SpoolHandle;
}

let initialized = false;

/**
 * `provenanceOnSpans` is for the case where a host SDK owns the provider: the
 * resource then belongs to that SDK, so the agent, environment and SDK version
 * would never reach a span. The processor applies them per span instead.
 */
const setup = (
  {
    endpoint,
    apiKey,
    auth = 'apiKey',
    serviceName,
    serviceVersion = '0.0.0',
    agent,
    environment,
    resourceAttributes = {},
    content,
    spool,
  }: InitOptions,
  { provenanceOnSpans }: { provenanceOnSpans: boolean },
) => {
  if (initialized) {
    throw new Error('octic-telemetry: already initialized.');
  }
  initialized = true;

  if (process.env.OCTIC_TELEMETRY_DEBUG === '1') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  /**
   * ESM auto-instrumentation patches modules as they load, which needs a loader
   * hook; without it a run exits 0 having emitted nothing. Only effective if
   * this runs before the instrumented library is imported, hence
   * `node --import ./telemetry.ts server.ts`.
   *
   * A library bundling its own nested copy of import-in-the-middle is not
   * served by this registration and needs its own escape hatch.
   */
  // DEP0205. The replacement is `module.registerHooks` via
  // `import-in-the-middle/register-hooks.mjs`, gated on `supportsSyncHooks()`
  // with this as the fallback. Deliberately not changed here: this pull request
  // moves code and changes no behaviour, and swapping the loader hook changes
  // when and how foreign modules are patched. It lands with the rest of the
  // public-surface work.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

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
   * A missing key under `auth: 'apiKey'` is a real deployment — a container
   * whose secret was not mounted, a token exchange that has not succeeded yet.
   * Throwing takes the consumer's process down over telemetry; sending
   * `Bearer undefined` produces a 401 per batch and loses everything. So the
   * transport is switched off and the spool takes custody instead, which is the
   * whole reason it exists.
   */
  const credentialed = auth === 'none' || (apiKey !== undefined && apiKey !== '');
  if (!credentialed) {
    diag.warn(
      'octic-telemetry: no apiKey and auth is not "none"; not exporting over HTTP. ' +
        'Telemetry will be spooled to disk for the reader to deliver.',
    );
  }

  const spoolConfig = resolveSpoolOptions(spool, {
    enabledByDefault: auth === 'none' || !credentialed || spool?.mode === 'only',
  });
  /** Nothing to fall back *from* when there is no credential. */
  const spoolMode: SpoolMode = credentialed ? spoolConfig.mode : 'only';
  const transport = spoolConfig.enabled ? spoolMode !== 'only' : true;

  const headers =
    auth === 'none' || apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` };
  const base = endpoint.replace(/\/$/, '');

  /**
   * Set before anything can emit: the annotations read it to decide whether to
   * serialize their input and output at all.
   */
  const contentPolicy = resolvePolicy(content);
  setActivePolicy(contentPolicy);

  const identityProcessor = new IdentitySpanProcessor(provenanceOnSpans ? provenance : {});

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
  const traceTransport = transport
    ? new OTLPTraceExporter({ url: `${base}${signalPaths.traces}`, headers })
    : undefined;
  const traceExporter = new RedactingSpanExporter(
    spoolInstance === undefined
      ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- see the invariant above
        traceTransport!
      : new SpoolingSpanExporter({
          ...(traceTransport === undefined ? {} : { inner: traceTransport }),
          spool: spoolInstance,
        }),
    contentPolicy,
  );

  const logTransport = transport
    ? new OTLPLogExporter({ url: `${base}${signalPaths.logs}`, headers })
    : undefined;
  const logExporter =
    spoolInstance === undefined
      ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- see the invariant above
        logTransport!
      : new SpoolingLogRecordExporter({
          ...(logTransport === undefined ? {} : { inner: logTransport }),
          spool: spoolInstance,
        });

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
      new RedactingLogRecordProcessor(contentPolicy),
      new SimpleLogRecordProcessor({ exporter: logExporter }),
    ],
  });
  logs.setGlobalLoggerProvider(loggerProvider);

  return {
    resource,
    identityProcessor,
    traceExporter,
    loggerProvider,
    contentPolicy,
    spool: spoolInstance,
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

export const init = (options: InitOptions): Telemetry => {
  const { resource, identityProcessor, traceExporter, loggerProvider, spool } = setup(options, {
    provenanceOnSpans: false,
  });

  const tracerProvider = new NodeTracerProvider({
    resource,
    // Simple, not Batch: batching lets a process exit unflushed.
    spanProcessors: [identityProcessor, new SimpleSpanProcessor(traceExporter)],
  });
  tracerProvider.register();

  const handle = spoolHandle(spool);
  return {
    forceFlush: async () => {
      await tracerProvider.forceFlush();
      await loggerProvider.forceFlush();
    },
    shutdown: async () => {
      await tracerProvider.shutdown();
      await loggerProvider.shutdown();
    },
    ...(handle === undefined ? {} : { spool: handle }),
  };
};

/**
 * Creates no provider. Until `identityProcessor` and `traceExporter` reach the
 * SDK that owns the provider, no span reaches the endpoint.
 */
export const initWithExternalProvider = (options: InitOptions): ExternalProviderTelemetry => {
  const { identityProcessor, traceExporter, loggerProvider, contentPolicy, spool } = setup(
    options,
    {
      provenanceOnSpans: true,
    },
  );

  const handle = spoolHandle(spool);
  return {
    identityProcessor,
    traceExporter,
    captureContent: contentPolicy.capture !== 'none',
    flushLogs: () => loggerProvider.forceFlush(),
    shutdownLogs: () => loggerProvider.shutdown(),
    ...(handle === undefined ? {} : { spool: handle }),
  };
};
