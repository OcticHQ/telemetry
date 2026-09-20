/**
 * Shared test scaffolding.
 *
 * Everything here exists because three or more test files needed it, and
 * because two of them getting it subtly different is how a suite starts
 * agreeing with a bug. The global-tracer-provider dance in particular was
 * open-coded twice in redaction.test.ts, including the non-obvious
 * `disable()`-first ordering that file documents at length.
 *
 * Nothing in this directory matches the `test/*.test.ts` glob, so the runner
 * never treats it as a suite.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { context, trace, type Attributes, type TracerProvider } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import type { ExportResult } from '@opentelemetry/core';
import { ExportResultCode } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { Resource } from '@opentelemetry/resources';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { ReadableSpan, SpanExporter, TimedEvent } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import { TRACER_NAME } from '../../src/annotations.ts';
import { resolvePolicy, setActivePolicy, type ContentOptions } from '../../src/content.ts';
import { OcticSpanProcessor } from '../../src/processor.ts';
import { RedactingSpanExporter } from '../../src/redacting-exporter.ts';

/**
 * Without this every `context.with` is a no-op: the API's default context
 * manager stores nothing, so `context.active()` is always ROOT and every scope
 * in this package silently stamps nothing. `init()` gets one for free from
 * `tracerProvider.register()`; a test building a provider by hand does not, and
 * neither does a host SDK that registers a provider without a context manager.
 *
 * Done here rather than per file so no suite can forget it and then pass for
 * the wrong reason — a context test with no context manager asserts that
 * nothing works, and does it in green.
 */
export const installContextManager = (): void => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
};

/** A vendor's name, so spans created with it take the foreign-scope path. */
export const FOREIGN_SCOPE = '@vendor/instrumentation-openai';

/** Copied from receiver/captured/ — the keys three real stacks actually send. */
export const CONTENT = {
  'gen_ai.input.messages':
    '[{"role":"user","parts":[{"type":"text","content":"my card is 4111 1111 1111 1111"}]}]',
  'gen_ai.output.messages':
    '[{"role":"assistant","parts":[{"type":"text","content":"It is 14C in Paris."}]}]',
  'gen_ai.system_instructions': 'You are a concise weather assistant.',
  'gen_ai.tool.call.result': '{"tempC":14}',
} as const;

/**
 * The shape `content.ts`'s `summarize()` writes when capture is `metadata`.
 *
 * Declared here rather than re-derived at each assertion because `JSON.parse`
 * returns `any`, and an `any` in a test is worse than an `any` in the source:
 * `summary.sha526` would type-check, run, and pass by being `undefined ===
 * undefined`. Parsing through a declared shape is what makes a typo in an
 * assertion a compile error.
 */
export interface RedactionSummary {
  redacted: true;
  chars: number;
  sha256: string;
}

/** Parse a `metadata`-capture summary off an attribute value. */
export const summaryOf = (value: unknown): RedactionSummary =>
  JSON.parse(String(value)) as RedactionSummary;

/** Not content, and must survive every setting — this is the product. */
export const GOVERNANCE = {
  'gen_ai.conversation.id': 'conv-1',
  'user.id': 'user-42',
  'octic.run.id': 'run-chat-turn-a3f9c1',
  'gen_ai.prompt.name': 'weather-assistant',
  'gen_ai.usage.input_tokens': 5200,
  'gen_ai.response.model': 'gpt-5',
  'octic.target.asset_ref': 'poc/datastore/city-guide',
} as const;

export interface CollectorOptions {
  /** Return FAILED instead of SUCCESS, to exercise the caller's error path. */
  result?: ExportResultCode;
  /** Throw synchronously from export(), which a badly behaved exporter does. */
  throwOnExport?: Error;
  /** Delay the callback, so ordering against forceFlush is observable. */
  delayMs?: number;
}

/** In-memory SpanExporter that records what it was handed, with failure knobs. */
export class CollectingExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = [];
  /** One entry per export() call, so batching is observable. */
  readonly batches: ReadableSpan[][] = [];
  shutdownCalls = 0;
  forceFlushCalls = 0;

  private readonly options: CollectorOptions;

  constructor(options: CollectorOptions = {}) {
    this.options = options;
  }

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    if (this.options.throwOnExport) throw this.options.throwOnExport;

    this.spans.push(...spans);
    this.batches.push(spans);

    const result: ExportResult = { code: this.options.result ?? ExportResultCode.SUCCESS };
    if (this.options.delayMs === undefined) {
      done(result);
      return;
    }
    setTimeout(() => done(result), this.options.delayMs);
  }

  /** The one span this export produced. Fails loudly rather than returning undefined. */
  only(): ReadableSpan {
    if (this.spans.length !== 1) {
      throw new Error(`expected exactly one span, got ${this.spans.length}`);
    }
    return this.spans[0]!;
  }

  named(name: string): ReadableSpan {
    const span = this.spans.find(entry => entry.name === name);
    if (span === undefined) {
      throw new Error(
        `no span named ${name}; exported: ${this.spans.map(s => s.name).join(', ') || '(none)'}`,
      );
    }
    return span;
  }

  shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    this.forceFlushCalls += 1;
    return Promise.resolve();
  }
}

export interface HarnessOptions {
  content?: ContentOptions;
  /** Extra resource attributes, for the resource-scrub path. */
  resource?: Record<string, string>;
  /** What OcticSpanProcessor stamps per span — the external-provider case. */
  processorDefaults?: Attributes;
  collector?: CollectorOptions;
}

/**
 * A provider that is never registered globally, so each case gets a clean one
 * and `init()`'s once-per-process guard stays out of the way.
 *
 * Both tracers come from the same provider on purpose: `ourTracer` is the name
 * the exporter recognises as ours, `foreignTracer` is not, and several
 * behaviours (the length heuristic, most obviously) differ only by that.
 */
export const buildProvider = ({
  content = {},
  resource = {},
  processorDefaults,
  collector: collectorOptions,
}: HarnessOptions = {}) => {
  const collector = new CollectingExporter(collectorOptions);
  const policy = resolvePolicy(content);
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': 'test', ...resource }),
    spanProcessors: [
      new OcticSpanProcessor(processorDefaults),
      new SimpleSpanProcessor(new RedactingSpanExporter(collector, policy)),
    ],
  });

  return {
    collector,
    policy,
    provider,
    ourTracer: provider.getTracer(TRACER_NAME),
    foreignTracer: provider.getTracer(FOREIGN_SCOPE),
  };
};

/**
 * Runs `fn` with `provider` as the global one, then puts things back.
 *
 * `disable()` comes first, not just on the way out: `setGlobalTracerProvider`
 * refuses to replace an already-registered global and returns false rather than
 * throwing, so a second test that skips this gets the no-op tracer, exports
 * nothing, and fails somewhere far from the cause.
 */
export const withGlobalTracerProvider = async <T>(
  provider: TracerProvider,
  fn: () => Promise<T>,
): Promise<T> => {
  trace.disable();
  trace.setGlobalTracerProvider(provider);
  try {
    return await fn();
  } finally {
    trace.disable();
  }
};

/**
 * Sets the module-global content policy for the duration of `fn`.
 *
 * The annotations read this to decide whether to serialize at all, and it is
 * process state — a test that sets it and does not restore it changes the
 * meaning of every test that runs after it in the same file.
 */
export const withPolicy = async <T>(content: ContentOptions, fn: () => Promise<T>): Promise<T> => {
  setActivePolicy(resolvePolicy(content));
  try {
    return await fn();
  } finally {
    setActivePolicy(resolvePolicy());
  }
};

/** Minimal stand-in for SdkLogRecord: the members the processor touches. */
export const fakeLogRecord = (body: unknown, attributes: Record<string, unknown> = {}) => ({
  body,
  attributes,
  setBody(next: unknown) {
    this.body = next;
    return this;
  },
  setAttribute(key: string, value: unknown) {
    this.attributes[key] = value;
    return this;
  },
});

export interface FakeSpanOptions {
  name?: string;
  scope?: string;
  attributes?: Attributes;
  events?: TimedEvent[];
  status?: { code: number; message?: string };
  resource?: Resource;
}

/**
 * A hand-built ReadableSpan, for the paths a real provider will not produce on
 * demand — a resource whose async attributes are still pending, most of all.
 *
 * Deliberately not run through a provider: the point of these cases is to hand
 * the exporter a shape it has to cope with, including shapes the SDK only
 * produces under timing we cannot arrange.
 */
export const fakeReadableSpan = ({
  name = 'chat gpt-5',
  scope = FOREIGN_SCOPE,
  attributes = {},
  events = [],
  status = { code: 0 },
  resource = resourceFromAttributes({ 'service.name': 'test' }),
}: FakeSpanOptions = {}): ReadableSpan =>
  ({
    name,
    kind: 0,
    spanContext: () => ({ traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 1 }),
    startTime: [0, 0],
    endTime: [0, 1],
    status,
    attributes,
    links: [],
    events,
    duration: [0, 1],
    ended: true,
    resource,
    instrumentationScope: { name: scope, version: '0.0.0' },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  }) as unknown as ReadableSpan;

// ── the spool ──────────────────────────────────────────────────────────────

/**
 * A private directory per case, removed afterwards.
 *
 * Every spool test has to own its directory: the spool is deliberately willing
 * to share one with other processes, so a shared fixture would let one case
 * count another's segments.
 */
export const withSpoolDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), 'octic-spool-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** The finished segments in a spool directory, oldest name first. */
export const segments = async (dir: string): Promise<string[]> =>
  (await readdir(dir)).filter(name => name.endsWith('.otlp.json')).sort();

/** Every segment's bytes, concatenated — for "is this string anywhere on disk". */
export const segmentBytes = async (dir: string): Promise<string> => {
  const names = await segments(dir);
  const bodies = await Promise.all(names.map(name => readFile(join(dir, name), 'utf8')));
  return bodies.join('\n');
};

export interface CapturedRequest {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

/**
 * An in-process OTLP/HTTP sink on an ephemeral port.
 *
 * Enough of the receiver to drive the real exporters — real HTTP, real
 * authorization header, real JSON encoding — without a second process, a port
 * to collide on, or an API key. What it is not is a validator: it decodes and
 * records, and the assertions live in the tests.
 */
export const fakeCollector = async () => {
  const traces: CapturedRequest[] = [];
  const logs: CapturedRequest[] = [];
  let status = 200;
  /**
   * A status per request, consumed in order and then exhausted — the shape a
   * refresh-and-retry needs, where the point is that the *second* attempt is
   * answered differently from the first. Falls back to `status` once empty, so
   * `setStatus` keeps meaning what it always meant.
   */
  const scripted: number[] = [];
  /** Hold the response open, to exercise an exporter that never hears back. */
  let hang = false;
  /**
   * Counted at the socket rather than derived from `traces`/`logs`, which are
   * only appended once a request is decoded — and never while hanging. "No HTTP
   * was attempted at all" is a claim only this can settle.
   */
  let received = 0;

  const server: Server = createServer((request, response) => {
    received += 1;
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => {
      if (hang) return;

      const raw = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // Kept rather than dropped: a body we cannot parse is the interesting
        // case, and a test asserting on it needs to see what actually arrived.
        body = { unparsed: raw };
      }

      const captured: CapturedRequest = {
        url: request.url ?? '',
        headers: request.headers,
        body,
      };
      if (captured.url.includes('/v1/logs')) logs.push(captured);
      else traces.push(captured);

      response.writeHead(scripted.shift() ?? status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ partialSuccess: {} }));
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');

  return {
    url: `http://127.0.0.1:${address.port}`,
    traces,
    logs,
    /** Every span across every trace request, flattened out of the OTLP envelope. */
    spans: () => traces.flatMap(request => flattenSpans(request.body)),
    /** Every log record, likewise. */
    records: () => logs.flatMap(request => flattenLogs(request.body)),
    /** Resource attributes as OTLP key/value pairs, from the first trace request. */
    resourceAttributes: () => {
      const first = traces[0];
      if (first === undefined) return {};
      const resourceSpans = (first.body.resourceSpans ?? []) as OtlpResourceSpans[];
      return fromOtlpAttributes(resourceSpans[0]?.resource?.attributes ?? []);
    },
    /** Requests that reached the socket, hung or answered. */
    requestCount: () => received,
    setStatus: (code: number) => {
      status = code;
    },
    /** e.g. `setStatuses([401, 200])`: refuse once, then accept. */
    setStatuses: (codes: readonly number[]) => {
      scripted.length = 0;
      scripted.push(...codes);
    },
    setHang: (value: boolean) => {
      hang = value;
    },
    /** Resolves once at least `count` requests of either signal have landed. */
    waitFor: async (count: number, timeoutMs = 2000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (traces.length + logs.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`only ${traces.length + logs.length} of ${count} requests arrived`);
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    },
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

/**
 * be-api's `/v1/ingest/token`, in-process.
 *
 * A second server rather than another route on `fakeCollector`, because the
 * token endpoint and the OTLP endpoint are different services on different
 * hosts in production. One origin serving both would let a `tokenUrl` wired to
 * the ingest host pass a test and fail everywhere else.
 *
 * Mints a distinct token per exchange, which is what lets a test assert that
 * the retry carried a *different* bearer rather than merely a second one.
 */
export const fakeTokenEndpoint = async ({ ttlSeconds = 900 }: { ttlSeconds?: number } = {}) => {
  const issued: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  let status = 200;
  let ttl = ttlSeconds;
  /** Answer 200 with something that is not a token — a proxy's login page, say. */
  let garbage = false;

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => {
      try {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      } catch {
        bodies.push({});
      }

      if (status !== 200) {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: {
              statusCode: status,
              message: 'Unauthorized',
              errorCode: 'INVALID_ENROLLMENT_TOKEN',
            },
          }),
        );
        return;
      }

      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      if (garbage) {
        response.end('<html>login</html>');
        return;
      }

      const accessToken = `token-${issued.length + 1}`;
      issued.push(accessToken);
      /** be-api's exact response shape, `tokenType` included. */
      response.end(JSON.stringify({ accessToken, tokenType: 'Bearer', expiresIn: ttl }));
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');

  return {
    url: `http://127.0.0.1:${address.port}/v1/ingest/token`,
    /** Tokens handed out, in order. */
    issued: () => [...issued],
    /** Exchange request bodies, so a test can assert the enrollment token was sent. */
    bodies: () => [...bodies],
    /** Requests that reached the handler, answered or refused. */
    requestCount: () => bodies.length,
    setStatus: (code: number) => {
      status = code;
    },
    setTtlSeconds: (seconds: number) => {
      ttl = seconds;
    },
    setGarbage: (value: boolean) => {
      garbage = value;
    },
    waitFor: async (count: number, timeoutMs = 2000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (bodies.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`only ${bodies.length} of ${count} exchanges arrived`);
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    },
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

// ── OTLP/JSON decoding, only as much as the assertions need ────────────────

interface OtlpKeyValue {
  key: string;
  value: Record<string, unknown>;
}

interface OtlpResourceSpans {
  resource?: { attributes?: OtlpKeyValue[] };
  scopeSpans?: {
    scope?: { name?: string };
    spans?: OtlpSpan[];
  }[];
}

interface OtlpSpan {
  name: string;
  attributes?: OtlpKeyValue[];
  status?: { code?: number; message?: string };
  events?: { name: string; attributes?: OtlpKeyValue[] }[];
}

/** OTLP wraps every value in a one-key type tag; unwrap to the plain value. */
const fromOtlpValue = (value: Record<string, unknown>): unknown => {
  if ('stringValue' in value) return value.stringValue;
  if ('boolValue' in value) return value.boolValue;
  if ('intValue' in value) return Number(value.intValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('arrayValue' in value) {
    const array = value.arrayValue as { values?: Record<string, unknown>[] };
    return (array.values ?? []).map(fromOtlpValue);
  }
  return undefined;
};

export const fromOtlpAttributes = (pairs: OtlpKeyValue[]): Record<string, unknown> =>
  Object.fromEntries(pairs.map(pair => [pair.key, fromOtlpValue(pair.value)]));

export interface WireSpan {
  name: string;
  scope: string;
  attributes: Record<string, unknown>;
  status: { code?: number; message?: string };
  events: { name: string; attributes: Record<string, unknown> }[];
}

const flattenSpans = (body: Record<string, unknown>): WireSpan[] =>
  ((body.resourceSpans ?? []) as OtlpResourceSpans[]).flatMap(resourceSpan =>
    (resourceSpan.scopeSpans ?? []).flatMap(scopeSpan =>
      (scopeSpan.spans ?? []).map(span => ({
        name: span.name,
        scope: scopeSpan.scope?.name ?? '',
        attributes: fromOtlpAttributes(span.attributes ?? []),
        status: span.status ?? {},
        events: (span.events ?? []).map(event => ({
          name: event.name,
          attributes: fromOtlpAttributes(event.attributes ?? []),
        })),
      })),
    ),
  );

export interface WireLog {
  scope: string;
  body: unknown;
  attributes: Record<string, unknown>;
}

const flattenLogs = (body: Record<string, unknown>): WireLog[] =>
  (
    (body.resourceLogs ?? []) as {
      scopeLogs?: {
        scope?: { name?: string };
        logRecords?: { body?: Record<string, unknown>; attributes?: OtlpKeyValue[] }[];
      }[];
    }[]
  ).flatMap(resourceLog =>
    (resourceLog.scopeLogs ?? []).flatMap(scopeLog =>
      (scopeLog.logRecords ?? []).map(record => ({
        scope: scopeLog.scope?.name ?? '',
        body: record.body === undefined ? undefined : fromOtlpValue(record.body),
        attributes: fromOtlpAttributes(record.attributes ?? []),
      })),
    ),
  );
