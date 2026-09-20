/**
 * `initWithExternalProvider()` — the mode where somebody else owns the tracer
 * provider.
 *
 * This exists because a host SDK (OpenLLMetry, the Vercel AI SDK, anything that
 * calls `register()` itself) will not give up the provider, and two registered
 * providers means one of them silently wins. So we hand over the two pieces
 * that carry our behaviour and let the host arrange them.
 *
 * The consequence, and the thing this file is really about: the resource then
 * belongs to the host, so everything `init()` would have put there — the agent,
 * the environment, which SDK produced this — never reaches a span unless the
 * processor applies it per span instead. That was measured with OpenLLMetry,
 * where the agent came through empty until the fallback existed.
 *
 * Its own file because init.ts latches on the first call: `setup()` runs at
 * most once per process, and a later call warns and reuses what it built.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { trace } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import { initWithExternalProvider, type ExternalProviderTelemetry } from '../src/index.ts';
import { withAgent } from '../src/agent.ts';
import { withIdentity } from '../src/identity.ts';
import { fakeCollector, FOREIGN_SCOPE, installContextManager } from './support/harness.ts';
import { SDK_NAME, SDK_VERSION } from '../src/version.ts';

installContextManager();

const CARD = 'my card is 4111 1111 1111 1111';

let collector: Awaited<ReturnType<typeof fakeCollector>>;
let telemetry: ExternalProviderTelemetry;
let providerBefore: unknown;

before(async () => {
  collector = await fakeCollector();
  providerBefore = trace.getTracerProvider();

  telemetry = initWithExternalProvider({
    endpoint: collector.url,
    auth: { kind: 'apiKey', apiKey: 'poc-token' },
    serviceName: 'external-integration',
    agent: { id: 'weather-assistant', name: 'Weather Assistant', assetRef: 'poc/agent/weather' },
    environment: 'test',
    content: { capture: 'none' },
  });
});

after(async () => {
  await collector.close();
});

describe('what it does and does not do on its own', () => {
  /**
   * The failure this guards is a quiet one: if this registered a provider, it
   * would race the host's and whichever lost would export nothing, with no
   * error anywhere.
   */
  it('registers no global tracer provider', () => {
    assert.equal(trace.getTracerProvider(), providerBefore);
  });

  it('hands back the two pieces the host has to install', () => {
    assert.ok(telemetry.spanProcessor, 'a processor to enrich');
    assert.ok(telemetry.spanExporter, 'and an exporter to ship');
  });

  /**
   * The exporter handed over is redaction-wrapped, not the raw OTLP one —
   * handing over the raw exporter would put the host SDK in charge of policy.
   */
  it('exports nothing until the host installs them', async () => {
    trace.getTracer(FOREIGN_SCOPE).startSpan('orphan').end();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(collector.traces.length, 0);
  });

  /**
   * For host SDKs with their own content switch: pass this through so content
   * is never produced, rather than produced and then stripped.
   */
  it('reports whether the host should produce content at all', () => {
    assert.equal(telemetry.captureContent, false, 'none means do not even produce it');
  });
});

describe('once the host has installed them', () => {
  /** Stands in for the host SDK: its resource, its provider, our two pieces. */
  let hostProvider: NodeTracerProvider;

  before(async () => {
    hostProvider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        'service.name': 'host-sdk',
        /** Traceloop's default detectors ship argv, which is a known secret store. */
        'process.command_args': '/usr/bin/node server.js --token=hunter2',
        'host.id': '84c4f47c43d4497da39ce761dcc11c55',
      }),
      spanProcessors: [telemetry.spanProcessor, new SimpleSpanProcessor(telemetry.spanExporter)],
    });

    await withIdentity({ conversationId: 'conv-1', userId: 'user-42' }, async () => {
      hostProvider
        .getTracer(FOREIGN_SCOPE)
        .startSpan('chat gpt-5', {
          attributes: { 'gen_ai.usage.input_tokens': 5200, 'gen_ai.input.messages': CARD },
        })
        .end();
    });

    await hostProvider.forceFlush();
    await collector.waitFor(1);
  });

  it('delivers the span to our endpoint', () => {
    assert.ok(collector.spans().some(span => span.name === 'chat gpt-5'));
  });

  /**
   * The whole reason `provenanceOnSpans` exists. The resource is the host's, so
   * a consumer looking only there would find no agent, no environment and no
   * SDK version — the processor puts them on each span instead.
   */
  it('puts the provenance on every span, because the resource is not ours', () => {
    const span = collector.spans().find(entry => entry.name === 'chat gpt-5');
    assert.equal(span?.attributes['octic.sdk.name'], SDK_NAME);
    /**
     * Against the package's real version, not a literal. It was pinned to
     * `'0.0.0'` here because `init.ts` shadowed `version.ts` with a local
     * constant of that value, so the assertion agreed with the bug.
     */
    assert.equal(span?.attributes['octic.sdk.version'], SDK_VERSION);
    assert.notEqual(SDK_VERSION, '0.0.0');
    assert.equal(span?.attributes['octic.schema.version'], '1');
    assert.equal(span?.attributes['deployment.environment.name'], 'test');
  });

  it('puts the agent on every span for the same reason', () => {
    const span = collector.spans().find(entry => entry.name === 'chat gpt-5');
    assert.equal(span?.attributes['gen_ai.agent.id'], 'weather-assistant');
    assert.equal(span?.attributes['gen_ai.agent.name'], 'Weather Assistant');
    assert.equal(span?.attributes['octic.agent.asset_ref'], 'poc/agent/weather');
  });

  it('keeps the host resource as the resource, rather than substituting ours', () => {
    assert.equal(collector.resourceAttributes()['service.name'], 'host-sdk');
  });

  /**
   * The exporter is ours in both modes, which is exactly why the scrub lives
   * there rather than in the processor — it survives the host arranging its own
   * processor list however it likes.
   */
  it('still scrubs the denied attributes off the host resource', () => {
    const resource = collector.resourceAttributes();
    assert.equal(resource['process.command_args'], undefined);
    assert.equal(resource['host.id'], undefined);
  });

  it('still redacts content on the way out', () => {
    assert.ok(!JSON.stringify(collector.traces).includes('4111'));
  });

  it('still stamps identity onto spans the host SDK created', () => {
    const span = collector.spans().find(entry => entry.name === 'chat gpt-5');
    assert.equal(span?.attributes['gen_ai.conversation.id'], 'conv-1');
    assert.equal(span?.attributes['user.id'], 'user-42');
  });

  it('lets a per-run agent override the declared one', async () => {
    const before = collector.traces.length;

    await withAgent({ id: 'refund-bot' }, async () => {
      hostProvider.getTracer(FOREIGN_SCOPE).startSpan('chat refund').end();
    });
    await hostProvider.forceFlush();
    await collector.waitFor(before + 1);

    const span = collector.spans().find(entry => entry.name === 'chat refund');
    assert.equal(span?.attributes['gen_ai.agent.id'], 'refund-bot');
  });
});

describe('the logs half, which stays ours', () => {
  /**
   * Only the traces move to the host: `init()` registers a LoggerProvider in
   * both modes, because some instrumentation puts all message content on the
   * logs signal and with no provider those records reach the global no-op
   * logger and vanish.
   */
  it('flushes logs without touching the host provider', async () => {
    await telemetry.forceFlush();
  });

  it('shuts logs down independently', async () => {
    await telemetry.shutdown();
  });
});
