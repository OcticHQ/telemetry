/**
 * The half of the package that emits spans.
 *
 * These three wrappers exist because instrumentation cannot produce them:
 * patching a provider SDK sees one HTTP call and cannot know that five of them
 * were one agent doing one job, and a tool execution is plain application code
 * that no patch is watching. So the shape they emit — the operation name, which
 * key carries the entity's name, what happens to a failure — is the contract,
 * and none of it was covered before this file.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

import { withRetrieval, withTool, withWorkflow } from '../src/annotations.ts';
import type { ContentOptions } from '../src/content.ts';
import {
  buildProvider,
  installContextManager,
  summaryOf,
  withGlobalTracerProvider,
  withPolicy,
} from './support/harness.ts';

installContextManager();

/**
 * Runs `fn` against a fresh provider with one capture level in force in both
 * places it matters — the module policy the annotations read to decide whether
 * to serialize at all, and the exporter policy applied on the way out. `init()`
 * derives both from one options object; a test that sets only one is testing a
 * configuration no consumer can produce.
 */
const emitting = async (content: ContentOptions, fn: () => Promise<unknown>) => {
  const { collector, provider } = buildProvider({ content });
  await withPolicy(content, () => withGlobalTracerProvider(provider, () => fn()));
  return collector;
};

const attributesOf = (span: ReadableSpan) => span.attributes;

describe('span names and operations', () => {
  it('names a workflow span after the operation and the workflow', async () => {
    const collector = await emitting({ capture: 'none' }, () =>
      withWorkflow({ name: 'chat-turn' }, async () => 'done'),
    );
    const span = collector.named('invoke_workflow chat-turn');
    assert.equal(attributesOf(span)['gen_ai.operation.name'], 'invoke_workflow');
    assert.equal(attributesOf(span)['gen_ai.workflow.name'], 'chat-turn');
  });

  it('names a tool span the same way', async () => {
    const collector = await emitting({ capture: 'none' }, () =>
      withTool({ name: 'get_weather' }, async () => ({ tempC: 14 })),
    );
    const span = collector.named('execute_tool get_weather');
    assert.equal(attributesOf(span)['gen_ai.operation.name'], 'execute_tool');
    assert.equal(attributesOf(span)['gen_ai.tool.name'], 'get_weather');
  });

  it('names a retrieval span the same way', async () => {
    const collector = await emitting({ capture: 'none' }, () =>
      withRetrieval({ name: 'city-guide' }, async () => []),
    );
    const span = collector.named('retrieval city-guide');
    assert.equal(attributesOf(span)['gen_ai.operation.name'], 'retrieval');
    assert.equal(attributesOf(span)['gen_ai.data_source.id'], 'city-guide');
  });

  /**
   * Each kind writes its own semantic convention rather than a shared
   * `octic.entity.name`, which used to exist and duplicated two of these while
   * reinventing the third. A consumer asking "what is this span called"
   * resolves the contract's `entity_name` alias table instead.
   */
  it('never writes a generic entity name', async () => {
    const collector = await emitting({ capture: 'none' }, async () => {
      await withWorkflow({ name: 'w' }, async () => {
        await withTool({ name: 't' }, async () => undefined);
      });
    });
    for (const span of collector.spans) {
      assert.equal(attributesOf(span)['octic.entity.name'], undefined);
    }
  });
});

describe('tool type', () => {
  it('defaults to function, which is what withTool wraps', async () => {
    const collector = await emitting({ capture: 'none' }, () =>
      withTool({ name: 'get_weather' }, async () => undefined),
    );
    assert.equal(
      attributesOf(collector.named('execute_tool get_weather'))['gen_ai.tool.type'],
      'function',
    );
  });

  it('honours an explicit toolType', async () => {
    const collector = await emitting({ capture: 'none' }, () =>
      withTool({ name: 'search', toolType: 'extension' }, async () => undefined),
    );
    assert.equal(
      attributesOf(collector.named('execute_tool search'))['gen_ai.tool.type'],
      'extension',
    );
  });

  /**
   * The regression this guards. `target.type` answers a different question —
   * what the tool *reached*, which is the asset-graph one — and feeding it here
   * made our spans say `service` where the Vercel AI SDK says `function` for
   * the same call.
   */
  it('is not derived from target.type', async () => {
    const collector = await emitting({ capture: 'none' }, () =>
      withTool(
        { name: 'lookup', target: { name: 'forecast-api', type: 'service' } },
        async () => undefined,
      ),
    );
    const span = collector.named('execute_tool lookup');
    assert.equal(attributesOf(span)['gen_ai.tool.type'], 'function');
    assert.equal(attributesOf(span)['octic.target.type'], 'service');
  });
});

describe('the target', () => {
  it('writes name, type and asset ref', async () => {
    const collector = await emitting({ capture: 'none' }, () =>
      withRetrieval(
        {
          name: 'city-guide',
          target: { name: 'city-guide', type: 'datastore', assetRef: 'poc/datastore/city-guide' },
        },
        async () => [],
      ),
    );
    const span = collector.named('retrieval city-guide');
    assert.equal(attributesOf(span)['octic.target.name'], 'city-guide');
    assert.equal(attributesOf(span)['octic.target.type'], 'datastore');
    assert.equal(attributesOf(span)['octic.target.asset_ref'], 'poc/datastore/city-guide');
  });

  it('omits the optional halves rather than emitting empty ones', async () => {
    const collector = await emitting({ capture: 'none' }, () =>
      withTool({ name: 'lookup', target: { name: 'forecast-api' } }, async () => undefined),
    );
    const span = collector.named('execute_tool lookup');
    assert.equal(attributesOf(span)['octic.target.name'], 'forecast-api');
    assert.equal(attributesOf(span)['octic.target.type'], undefined);
    assert.equal(attributesOf(span)['octic.target.asset_ref'], undefined);
  });

  it('writes nothing when there is no target', async () => {
    const collector = await emitting({ capture: 'none' }, () =>
      withTool({ name: 'lookup' }, async () => undefined),
    );
    assert.equal(
      attributesOf(collector.named('execute_tool lookup'))['octic.target.name'],
      undefined,
    );
  });
});

describe('input and output', () => {
  it('records both under full', async () => {
    const collector = await emitting({ capture: 'full' }, () =>
      withTool({ name: 'get_weather', input: { city: 'Paris' } }, async () => ({ tempC: 14 })),
    );
    const span = collector.named('execute_tool get_weather');
    assert.equal(attributesOf(span)['octic.entity.input'], '{"city":"Paris"}');
    assert.equal(attributesOf(span)['octic.entity.output'], '{"tempC":14}');
  });

  /**
   * Under `none` these are not serialized at all rather than serialized and
   * stripped. Worth the separate path: an 8KB object costs real CPU to encode,
   * and a value that was never created cannot escape through a bug downstream.
   */
  it('produces neither under none', async () => {
    const collector = await emitting({ capture: 'none' }, () =>
      withTool({ name: 'get_weather', input: { city: 'Paris' } }, async () => ({ tempC: 14 })),
    );
    const span = collector.named('execute_tool get_weather');
    assert.equal(attributesOf(span)['octic.entity.input'], undefined);
    assert.equal(attributesOf(span)['octic.entity.output'], undefined);
  });

  it('summarizes both under metadata', async () => {
    const collector = await emitting({ capture: 'metadata' }, () =>
      withTool({ name: 'get_weather', input: { city: 'Paris' } }, async () => ({ tempC: 14 })),
    );
    const input = summaryOf(
      attributesOf(collector.named('execute_tool get_weather'))['octic.entity.input'],
    );
    assert.equal(input.redacted, true);
    assert.match(input.sha256, /^[0-9a-f]{16}$/);
  });

  it('writes no output key when the callback returns undefined', async () => {
    const collector = await emitting({ capture: 'full' }, () =>
      withTool({ name: 'notify' }, async () => undefined),
    );
    assert.equal(
      attributesOf(collector.named('execute_tool notify'))['octic.entity.output'],
      undefined,
    );
  });

  /** `null` is a result the tool actually produced, unlike `undefined`. */
  it('records a null result as null rather than dropping it', async () => {
    const collector = await emitting({ capture: 'full' }, () =>
      withTool({ name: 'lookup' }, async () => null),
    );
    assert.equal(
      attributesOf(collector.named('execute_tool lookup'))['octic.entity.output'],
      'null',
    );
  });

  it('records a string input as itself, not as JSON', async () => {
    const collector = await emitting({ capture: 'full' }, () =>
      withTool({ name: 'echo', input: 'plain text' }, async () => undefined),
    );
    assert.equal(
      attributesOf(collector.named('execute_tool echo'))['octic.entity.input'],
      'plain text',
    );
  });
});

/** An attribute has to be a primitive, and an unbounded blob is nobody's friend. */
describe('serialization limits', () => {
  it('truncates an input past the serialization bound', async () => {
    const collector = await emitting({ capture: 'full', maxLength: 1_000_000 }, () =>
      withTool({ name: 'big', input: 'z'.repeat(20_000) }, async () => undefined),
    );
    const input = String(attributesOf(collector.named('execute_tool big'))['octic.entity.input']);
    assert.ok(input.endsWith('…[truncated]'));
    assert.ok(input.length < 20_000);
  });

  it('does not throw on a circular structure', async () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;

    const collector = await emitting({ capture: 'full' }, () =>
      withTool({ name: 'loopy', input: circular }, async () => undefined),
    );
    assert.equal(
      attributesOf(collector.named('execute_tool loopy'))['octic.entity.input'],
      '[unserializable]',
    );
  });

  it('does not throw on a BigInt, which JSON refuses outright', async () => {
    const collector = await emitting({ capture: 'full' }, () =>
      withTool({ name: 'big-int', input: { count: 10n } }, async () => undefined),
    );
    assert.equal(
      attributesOf(collector.named('execute_tool big-int'))['octic.entity.input'],
      '[unserializable]',
    );
  });
});

/**
 * `gen_ai.retrieval.query.text` promises a string, so it only ever gets one.
 *
 * Found by reading a real capture rather than by a test: the first version of
 * this routed every retrieval input to that key, and a caller passing
 * `{ query: '...' }` produced a serialized object behind a name that says text —
 * the same lie we declined to tell by adopting `gen_ai.retrieval.documents`.
 */
describe('the retrieval query key', () => {
  it('uses the semantic convention when the caller passed text', async () => {
    const collector = await emitting({ capture: 'full' }, () =>
      withRetrieval({ name: 'city-guide', input: 'weather in Paris' }, async () => []),
    );
    const span = collector.named('retrieval city-guide');
    assert.equal(attributesOf(span)['gen_ai.retrieval.query.text'], 'weather in Paris');
    assert.equal(attributesOf(span)['octic.entity.input'], undefined);
  });

  it('falls back to octic.entity.input for a structured query', async () => {
    const collector = await emitting({ capture: 'full' }, () =>
      withRetrieval({ name: 'city-guide', input: { query: 'weather in Paris' } }, async () => []),
    );
    const span = collector.named('retrieval city-guide');
    assert.equal(attributesOf(span)['gen_ai.retrieval.query.text'], undefined);
    assert.equal(attributesOf(span)['octic.entity.input'], '{"query":"weather in Paris"}');
  });

  /**
   * The result deliberately does NOT go on `gen_ai.retrieval.documents`: this
   * wrapper returns whatever the application returns, and calling that
   * "documents" would assert a shape nobody validates.
   */
  it('never claims the result is documents', async () => {
    const collector = await emitting({ capture: 'full' }, () =>
      withRetrieval({ name: 'city-guide', input: 'q' }, async () => [{ id: 1 }]),
    );
    const span = collector.named('retrieval city-guide');
    assert.equal(attributesOf(span)['gen_ai.retrieval.documents'], undefined);
    assert.equal(attributesOf(span)['octic.entity.output'], '[{"id":1}]');
  });
});

describe('when the wrapped work throws', () => {
  const boom = new Error('provider refused the request');

  it('rethrows the original error object', async () => {
    const collector = await emitting({ capture: 'none' }, async () => {
      await assert.rejects(
        () => withTool({ name: 'failing' }, async () => Promise.reject(boom)),
        (error: unknown) => {
          assert.equal(error, boom, 'the same object, not a wrapper');
          return true;
        },
      );
    });
    assert.ok(collector.named('execute_tool failing'));
  });

  it('marks the span as an error and keeps the message on the status', async () => {
    const collector = await emitting({ capture: 'full' }, async () => {
      await assert.rejects(() => withTool({ name: 'failing' }, async () => Promise.reject(boom)));
    });
    const span = collector.named('execute_tool failing');
    assert.equal(span.status.code, SpanStatusCode.ERROR);
    assert.equal(span.status.message, boom.message);
  });

  it('records the exception as an event', async () => {
    const collector = await emitting({ capture: 'full' }, async () => {
      await assert.rejects(() => withTool({ name: 'failing' }, async () => Promise.reject(boom)));
    });
    const event = collector.named('execute_tool failing').events.find(e => e.name === 'exception');
    assert.ok(event, 'an exception event was recorded');
    assert.equal(event.attributes?.['exception.message'], boom.message);
  });

  it('ends the span rather than leaving it open', async () => {
    const collector = await emitting({ capture: 'none' }, async () => {
      await assert.rejects(() => withTool({ name: 'failing' }, async () => Promise.reject(boom)));
    });
    assert.equal(collector.named('execute_tool failing').ended, true);
  });

  it('behaves the same for a synchronous throw inside the callback', async () => {
    const collector = await emitting({ capture: 'none' }, async () => {
      await assert.rejects(() =>
        withTool({ name: 'failing-sync' }, () => {
          throw boom;
        }),
      );
    });
    assert.equal(collector.named('execute_tool failing-sync').status.code, SpanStatusCode.ERROR);
  });

  it('writes no output attribute for a call that produced none', async () => {
    const collector = await emitting({ capture: 'full' }, async () => {
      await assert.rejects(() => withTool({ name: 'failing' }, async () => Promise.reject(boom)));
    });
    assert.equal(
      attributesOf(collector.named('execute_tool failing'))['octic.entity.output'],
      undefined,
    );
  });

  /**
   * JavaScript permits throwing anything, and `recordException` is not safe on
   * all of it: given a value with no `code`, `name` or `message` it falls
   * through to a `diag.warn` that interpolates the value into a template
   * literal, and a Symbol there raises `TypeError: Cannot convert a Symbol
   * value to a string`. Unguarded, that TypeError replaced the caller's own
   * thrown value on the way out — an observability tool rewriting the error it
   * was watching. `non-interference.test.ts` owns the full set; this is the
   * one that lives next to the code it guards.
   */
  it('propagates a non-Error throw unchanged rather than substituting ours', async () => {
    const symbol = Symbol('boom');
    let caught: unknown;

    const collector = await emitting({ capture: 'none' }, async () => {
      try {
        await withTool({ name: 'symbol-thrower' }, () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- the value under test
          throw symbol;
        });
      } catch (error) {
        caught = error;
      }
    });

    assert.equal(caught, symbol);
    assert.equal(collector.named('execute_tool symbol-thrower').status.code, SpanStatusCode.ERROR);
  });

  it('unwinds the run scope so a later span is not attributed to the failed run', async () => {
    const collector = await emitting({ capture: 'none' }, async () => {
      await assert.rejects(() =>
        withWorkflow({ name: 'doomed', runId: 'run-doomed' }, async () => Promise.reject(boom)),
      );
      await withWorkflow({ name: 'next', runId: 'run-next' }, async () => undefined);
    });
    assert.equal(attributesOf(collector.named('invoke_workflow next'))['octic.run.id'], 'run-next');
  });
});

describe('nesting', () => {
  it('parents the tool span under the workflow span', async () => {
    const collector = await emitting({ capture: 'none' }, () =>
      withWorkflow({ name: 'chat-turn' }, async () => {
        await withTool({ name: 'get_weather' }, async () => undefined);
      }),
    );

    const workflow = collector.named('invoke_workflow chat-turn');
    const tool = collector.named('execute_tool get_weather');
    assert.equal(tool.parentSpanContext?.spanId, workflow.spanContext().spanId);
    assert.equal(tool.spanContext().traceId, workflow.spanContext().traceId);
  });

  it('carries the run id onto a foreign span that is not a direct child', async () => {
    const { collector, provider, foreignTracer } = buildProvider({ content: { capture: 'none' } });

    await withPolicy({ capture: 'none' }, () =>
      withGlobalTracerProvider(provider, () =>
        withWorkflow({ name: 'chat-turn', runId: 'run-x' }, async () => {
          await withTool({ name: 'get_weather' }, async () => {
            foreignTracer.startSpan('chat gpt-5').end();
          });
        }),
      ),
    );

    const foreign = collector.named('chat gpt-5');
    assert.equal(foreign.attributes['octic.run.id'], 'run-x');
    assert.equal(
      foreign.parentSpanContext?.spanId,
      collector.named('execute_tool get_weather').spanContext().spanId,
      'and it is nested under the tool, two levels below the workflow',
    );
  });
});
