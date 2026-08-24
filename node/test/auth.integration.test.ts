/**
 * Refresh-and-retry on 401, against the exporter that will actually be in the
 * chain rather than a fake standing in for it.
 *
 * The mechanism this whole feature rests on is an implementation detail of a
 * pinned dependency: on a non-retryable non-2xx the Node transport produces
 * `new OTLPExporterError(statusMessage, statusCode, body)` and hands it to
 * `resultCallback`, so the HTTP status reaches a `SpanExporter` as a *number*
 * on `error.code`. A stub exporter can be made to do that, which is exactly why
 * one is not used here — a stub would keep agreeing with us after the real one
 * stopped.
 *
 * The canary case below is the most important assertion in the file. If a
 * future version of the exporter moves Node onto the fetch transport, the
 * status stops being a field and becomes prose inside a message string; the
 * retry would quietly never fire again while every other test in this file kept
 * passing off the proactive refresh.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { diag, DiagLogLevel, type DiagLogger } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

import { AuthRetryingSpanExporter, resetAuthWarning } from '../src/auth-retrying-exporter.ts';
import { resetCounters, snapshot } from '../src/counters.ts';
import { TokenManager } from '../src/token-manager.ts';
import { fakeCollector, fakeReadableSpan, fakeTokenEndpoint } from './support/harness.ts';

const warnings: string[] = [];
const capture: DiagLogger = {
  error: () => {},
  warn: (message, ...args) => warnings.push([message, ...args.map(String)].join(' ')),
  info: () => {},
  debug: () => {},
  verbose: () => {},
};

let collector: Awaited<ReturnType<typeof fakeCollector>>;
let issuer: Awaited<ReturnType<typeof fakeTokenEndpoint>>;
const managers: TokenManager[] = [];

/** The chain as `setup()` builds it, minus the links that do not matter here. */
const chain = (): { exporter: SpanExporter; tokens: TokenManager } => {
  const tokens = new TokenManager({
    enrollmentToken: 'octic_et_test',
    tokenUrl: issuer.url,
  });
  managers.push(tokens);

  const exporter = new AuthRetryingSpanExporter({
    inner: new OTLPTraceExporter({
      url: `${collector.url}/v1/traces`,
      headers: tokens.headers,
    }),
    tokens,
    endpointUrl: collector.url,
    tokenUrl: issuer.url,
  });

  return { exporter, tokens };
};

const exportOnce = async (exporter: SpanExporter, spans: ReadableSpan[]): Promise<ExportResult> =>
  new Promise(resolve => {
    exporter.export(spans, resolve);
  });

const bearers = (): (string | undefined)[] =>
  collector.traces.map(request => {
    const value = request.headers.authorization;
    return typeof value === 'string' ? value : undefined;
  });

before(async () => {
  diag.setLogger(capture, DiagLogLevel.WARN);
  collector = await fakeCollector();
  issuer = await fakeTokenEndpoint({ ttlSeconds: 900 });
});

after(async () => {
  for (const manager of managers) manager.shutdown();
  await collector.close();
  await issuer.close();
  diag.disable();
});

afterEach(() => {
  for (const manager of managers) manager.shutdown();
  managers.length = 0;
  collector.traces.length = 0;
  collector.setStatus(200);
  collector.setStatuses([]);
  issuer.setStatus(200);
  warnings.length = 0;
  resetCounters();
  resetAuthWarning();
});

describe('401 through the real exporter', () => {
  it('hands a wrapper a numeric error.code — the canary for the whole mechanism', async () => {
    collector.setStatuses([401]);
    const { tokens } = chain();

    /** The inner exporter alone: no retry, so the raw failure is observable. */
    const bare = new OTLPTraceExporter({
      url: `${collector.url}/v1/traces`,
      headers: tokens.headers,
    });
    const result = await exportOnce(bare, [fakeReadableSpan()]);
    const seen: unknown = result.error;

    assert.equal(result.code, ExportResultCode.FAILED);
    assert.ok(typeof seen === 'object' && seen !== null && 'code' in seen, 'error carries a code');
    assert.strictEqual(
      seen.code,
      401,
      'the status is a number on error.code, not prose in a message',
    );
    await bare.shutdown();
  });

  it('refreshes and retries once, and the retry carries a different token', async () => {
    collector.setStatuses([401, 200]);
    const { exporter } = chain();

    const result = await exportOnce(exporter, [fakeReadableSpan()]);

    assert.equal(result.code, ExportResultCode.SUCCESS, 'the batch was delivered on the retry');
    assert.equal(collector.traces.length, 2, 'two requests: the refusal and the retry');
    const [first, second] = bearers();
    assert.ok(first?.startsWith('Bearer token-'));
    assert.ok(second?.startsWith('Bearer token-'));
    assert.notEqual(first, second, 'the retry did not re-send the refused credential');
    assert.equal(snapshot().authRetries, 1);
  });

  it('retries once and never loops when the 401 is permanent', async () => {
    collector.setStatus(401);
    const { exporter } = chain();

    const result = await exportOnce(exporter, [fakeReadableSpan()]);

    assert.equal(result.code, ExportResultCode.FAILED, 'the failure is reported, not swallowed');
    assert.equal(collector.traces.length, 2, 'exactly two attempts, whatever the answer');
    assert.equal(snapshot().authRetries, 1);
  });

  it('says why once, naming both URLs and neither credential', async () => {
    collector.setStatus(401);
    const { exporter } = chain();

    await exportOnce(exporter, [fakeReadableSpan()]);
    await exportOnce(exporter, [fakeReadableSpan()]);

    const rejected = warnings.filter(line => line.includes('rejected a freshly minted token'));
    assert.equal(rejected.length, 1, 'one line per process, not one per batch');
    assert.ok(rejected[0]?.includes(collector.url), 'the ingest endpoint is named');
    assert.ok(rejected[0]?.includes(issuer.url), 'the token endpoint is named');
    assert.doesNotMatch(rejected[0] ?? '', /octic_et_test/);
    assert.doesNotMatch(rejected[0] ?? '', /token-\d/);
  });

  it('leaves a non-401 failure exactly as it found it', async () => {
    collector.setStatus(500);
    const { exporter } = chain();

    const result = await exportOnce(exporter, [fakeReadableSpan()]);

    assert.equal(result.code, ExportResultCode.FAILED);
    assert.equal(collector.traces.length, 1, 'no retry: a 500 is not an auth problem');
    assert.equal(snapshot().authRetries, 0);
  });

  it('passes a success straight through', async () => {
    const { exporter } = chain();

    const result = await exportOnce(exporter, [fakeReadableSpan()]);

    assert.equal(result.code, ExportResultCode.SUCCESS);
    assert.equal(collector.traces.length, 1);
    assert.equal(snapshot().authRetries, 0);
  });
});
