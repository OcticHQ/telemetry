/**
 * `init()` end to end, against a real OTLP endpoint.
 *
 * Everything else in this suite builds a provider by hand, which means nothing
 * else checks the wiring `init()` actually performs: the URLs it appends, the
 * header it attaches, what lands on the resource versus on each span, and
 * whether a shutdown really stops the pipe. Those are the parts a consumer
 * inherits without writing a line, so they are the parts that fail silently.
 *
 * The collector is an in-process HTTP server on an ephemeral port. Real
 * exporters, real HTTP, real JSON — no second process and no API key.
 *
 * This file gets a process to itself because init.ts latches on the first call
 * and never re-runs `setup()`, so one *effective* `init()` per file is the
 * budget — later calls warn and hand back the pipeline this one built.
 * `node --test` gives one process per file, which is why the integration cases
 * are split up rather than sharing a describe.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { trace } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';

import { init, initWithExternalProvider, type Telemetry } from '../src/index.ts';
import { withContent } from '../src/content.ts';
import { withIdentity } from '../src/identity.ts';
import { withWorkflow } from '../src/annotations.ts';
import { fakeCollector, FOREIGN_SCOPE, installContextManager } from './support/harness.ts';

installContextManager();

const CARD = 'my card is 4111 1111 1111 1111';

let collector: Awaited<ReturnType<typeof fakeCollector>>;
let telemetry: Telemetry;
/** Captured after the first init(), to prove a later call does not replace it. */
let firstLoggerProvider: ReturnType<typeof logs.getLoggerProvider>;

before(async () => {
  collector = await fakeCollector();

  telemetry = init({
    /**
     * Trailing slash on purpose: a consumer copying a URL out of a dashboard
     * gets one, and `${base}/v1/traces` would otherwise produce a double slash
     * that some gateways 404.
     */
    endpoint: `${collector.url}/`,
    apiKey: 'poc-token',
    serviceName: 'init-integration',
    serviceVersion: '1.4.0',
    agent: { id: 'weather-assistant', name: 'Weather Assistant', assetRef: 'poc/agent/weather' },
    environment: 'test',
    resourceAttributes: { 'octic.custom.tenant': 'acme' },
    content: { capture: 'none' },
  });
  firstLoggerProvider = logs.getLoggerProvider();
});

after(async () => {
  await collector.close();
});

describe('what init() puts on the wire', () => {
  before(async () => {
    await withIdentity({ conversationId: 'conv-1', userId: 'user-42' }, () =>
      withWorkflow({ name: 'chat-turn', input: { message: CARD } }, async () => {
        trace
          .getTracer(FOREIGN_SCOPE)
          .startSpan('chat gpt-5', {
            attributes: {
              'gen_ai.usage.input_tokens': 5200,
              'gen_ai.input.messages': CARD,
            },
          })
          .end();

        logs.getLogger(FOREIGN_SCOPE).emit({
          attributes: { 'event.name': 'gen_ai.user.message' },
          body: { content: CARD },
        });

        return { reply: 'It is 14C in Paris.' };
      }),
    );

    await telemetry.forceFlush();
    await collector.waitFor(2);
  });

  it('posts traces to /v1/traces and logs to /v1/logs', () => {
    assert.ok(collector.traces.length > 0, 'traces arrived');
    assert.ok(collector.logs.length > 0, 'logs arrived');
    assert.equal(collector.traces[0]!.url, '/v1/traces');
    assert.equal(collector.logs[0]!.url, '/v1/logs');
  });

  it('presents the api key as a bearer token on both signals', () => {
    assert.equal(collector.traces[0]!.headers.authorization, 'Bearer poc-token');
    assert.equal(collector.logs[0]!.headers.authorization, 'Bearer poc-token');
  });

  it('carries the service identity and provenance on the resource', () => {
    const resource = collector.resourceAttributes();
    assert.equal(resource['service.name'], 'init-integration');
    assert.equal(resource['service.version'], '1.4.0');
    assert.equal(resource['octic.sdk.name'], 'octic-node');
    assert.equal(resource['octic.sdk.version'], '0.0.0');
    /** Declared `type: string` in the contract, so it ships as one. */
    assert.equal(resource['octic.schema.version'], '1');
    assert.equal(resource['deployment.environment.name'], 'test');
  });

  it('carries the agent on the resource, so every span gets it for free', () => {
    const resource = collector.resourceAttributes();
    assert.equal(resource['gen_ai.agent.id'], 'weather-assistant');
    assert.equal(resource['gen_ai.agent.name'], 'Weather Assistant');
    assert.equal(resource['octic.agent.asset_ref'], 'poc/agent/weather');
  });

  it('carries extra resource attributes the consumer supplied', () => {
    assert.equal(collector.resourceAttributes()['octic.custom.tenant'], 'acme');
  });

  /**
   * The half that distinguishes `init()` from `initWithExternalProvider()`.
   * Here the resource is ours, so provenance rides there and paying for it on
   * every span would be waste.
   */
  it('does not repeat the resource provenance on every span', () => {
    for (const span of collector.spans()) {
      assert.equal(
        span.attributes['octic.sdk.name'],
        undefined,
        `${span.name} repeated provenance`,
      );
      assert.equal(span.attributes['deployment.environment.name'], undefined);
    }
  });

  it('stamps identity and the run id onto the foreign span', () => {
    const span = collector.spans().find(entry => entry.name === 'chat gpt-5');
    assert.ok(span, 'the foreign span arrived');
    assert.equal(span.attributes['gen_ai.conversation.id'], 'conv-1');
    assert.equal(span.attributes['session.id'], 'conv-1');
    assert.equal(span.attributes['user.id'], 'user-42');
    assert.match(String(span.attributes['octic.run.id']), /^run-chat-turn-[0-9a-f]{16}$/);
  });

  it('keeps the foreign scope name, rather than relabelling the span as ours', () => {
    const span = collector.spans().find(entry => entry.name === 'chat gpt-5');
    assert.equal(span?.scope, FOREIGN_SCOPE);
  });

  it('redacts content on the way out, on both signals', () => {
    const wire = JSON.stringify({ traces: collector.traces, logs: collector.logs });
    assert.ok(!wire.includes('4111'), 'no card number anywhere on the wire');
    assert.ok(!wire.includes('It is 14C in Paris'), 'and no model output either');
  });

  it('never ships the internal capture attribute', () => {
    for (const span of collector.spans()) {
      assert.equal(span.attributes['octic.content.capture'], undefined);
    }
  });

  it('still ships the governance attributes the product runs on', () => {
    const span = collector.spans().find(entry => entry.name === 'chat gpt-5');
    assert.equal(span?.attributes['gen_ai.usage.input_tokens'], 5200);
  });
});

describe('the per-run override reaches the real exporter', () => {
  it('opens content up for one run while the process default stays none', async () => {
    const before = collector.traces.length;

    await withContent({ capture: 'full' }, async () => {
      trace
        .getTracer(FOREIGN_SCOPE)
        .startSpan('chat opened-up', { attributes: { 'gen_ai.input.messages': 'opened up' } })
        .end();
    });
    await telemetry.forceFlush();
    await collector.waitFor(before + 1);

    const span = collector.spans().find(entry => entry.name === 'chat opened-up');
    assert.equal(span?.attributes['gen_ai.input.messages'], 'opened up');
  });
});

describe('the once-per-process guard', () => {
  /**
   * It used to throw. A library crashing an application for being wired twice
   * is the failure this package promises not to be, and the flag was set
   * before any work, so one partial failure locked the process out for good
   * behind a message describing something that had not happened.
   */
  it('warns and hands back the working handle instead of throwing', async () => {
    const again = init({ endpoint: collector.url, apiKey: 'x', serviceName: 'again' });

    /**
     * Not `assert.equal(again, telemetry)`: the handle is rebuilt from the
     * same parts each call, so identity is not the property. What matters is
     * that it drives the pipeline the first call created — which this proves
     * by flushing a span through it.
     */
    const before = collector.traces.length;
    trace.getTracer(FOREIGN_SCOPE).startSpan('after the second init').end();
    await again.forceFlush();
    await collector.waitFor(before + 1);

    assert.ok(
      collector.spans().some(span => span.name === 'after the second init'),
      'the handle from the second init() flushes the first pipeline',
    );
  });

  /**
   * The cross-mode call is the one with a wrong answer available: rebuilding
   * from cached parts is the only option that does not register a second
   * global LoggerProvider, which `setGlobalLoggerProvider` would silently
   * ignore while we handed back a handle that flushed the dangling one.
   */
  it('serves the external-provider shape from the same pipeline', () => {
    const external = initWithExternalProvider({
      endpoint: collector.url,
      apiKey: 'x',
      serviceName: 'external-after-own',
    });

    assert.equal(logs.getLoggerProvider(), firstLoggerProvider);
    assert.ok(external.identityProcessor);
    assert.ok(external.traceExporter);
  });
});

describe('shutdown', () => {
  it('resolves, and nothing emitted afterwards reaches the collector', async () => {
    await telemetry.forceFlush();
    const before = collector.traces.length;

    await telemetry.shutdown();

    trace.getTracer(FOREIGN_SCOPE).startSpan('after shutdown').end();
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.equal(collector.traces.length, before, 'no further export happened');
    assert.equal(
      collector.spans().some(span => span.name === 'after shutdown'),
      false,
    );
  });

  it('is safe to call twice', async () => {
    await telemetry.shutdown();
  });
});
