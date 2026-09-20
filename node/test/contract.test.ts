/**
 * The attribute contract, checked from inside the package.
 *
 * `contract/attributes.gen.ts` is generated and carries no imports, so that
 * ingest, the worker and the PoC harness can all read one file without a
 * semantic-conventions dependency in front of it. The cost of that choice is
 * that a semconv upgrade renaming a key is no longer a compile error here. This
 * puts the check back, at test time, where the pinned release is available.
 *
 * The second half is the property the whole exercise exists for: nothing in this
 * package may hold a second opinion about which attributes carry content. The
 * generator enforces that across the repo; these assert it for the two consumers
 * that would leak if it broke.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ROOT_CONTEXT } from '@opentelemetry/api';
import * as semconv from '@opentelemetry/semantic-conventions/incubating';

import {
  ATTR_OCTIC_AGENT_ASSET_REF,
  ATTR_OCTIC_RUN_ID,
  CONTENT_KEYS,
  CUSTOMER_ATTRIBUTE_PREFIX,
  EMITTED_ATTRIBUTES,
  INTERNAL_ATTRIBUTES,
  RESERVED_ATTRIBUTE_PREFIX,
  RESOURCE_DENY,
  SEMCONV_NAMES,
} from '../src/attributes.gen.ts';
import { isContent, isDeniedResourceAttribute, resolvePolicy } from '../src/content.ts';
import { identityScope } from '../src/identity.ts';
import { TRACER_NAME, TRACER_VERSION } from '../src/annotations.ts';
import { SDK_NAME, SDK_VERSION } from '../src/version.ts';
import { OCTIC_SDK_NAME_VALUE_OCTIC_NODE, OCTIC_SDK_NAME_VALUES } from '../src/attributes.gen.ts';

/**
 * Every generated constant that claims to be a semantic convention, against the
 * pinned release. Driven off the generated provenance map rather than a list
 * written here: a hand-maintained list inside the test that guards against
 * hand-maintained lists would be worth nothing.
 */
describe('generated contract vs the pinned semconv release', () => {
  it('claims at least one semantic convention', () => {
    assert.ok(Object.keys(SEMCONV_NAMES).length > 0, 'provenance map is empty');
  });

  for (const [name, value] of Object.entries(SEMCONV_NAMES)) {
    it(`${name} still exists and still means ${value}`, () => {
      const actual = (semconv as unknown as Record<string, string | undefined>)[name];
      assert.equal(
        actual,
        value,
        `semconv ${name} is ${String(actual)}; the contract says ${value}. ` +
          'Regenerate: node contract/generate.ts',
      );
    });
  }
});

describe('the exporter reads the contract, not a copy of it', () => {
  const policy = resolvePolicy();

  it('classifies every declared content key as content', () => {
    for (const key of CONTENT_KEYS) {
      assert.equal(isContent(key, 'x', false, policy), true, `${key} was not treated as content`);
    }
  });

  it('drops every denied resource attribute', () => {
    for (const key of RESOURCE_DENY) {
      assert.equal(isDeniedResourceAttribute(key), true, `${key} was not denied`);
    }
  });

  /**
   * The specific hole this wiring closed. `gen_ai.tool.call.arguments` is short
   * — `{"location":"Paris"}` is 21 characters — so the foreign-string length
   * bound never catches it, and the hand-written list in assertions.ts did not
   * include it. A stalled redactor would have scored green.
   */
  it('covers gen_ai.tool.call.arguments, which the length heuristic cannot', () => {
    const short = '{"location":"Paris"}';
    assert.ok(short.length < 200);
    assert.equal(isContent('gen_ai.tool.call.arguments', short, true, policy), true);
  });
});

describe('namespaces', () => {
  it('keeps customer attributes strictly inside the reserved prefix', () => {
    assert.ok(CUSTOMER_ATTRIBUTE_PREFIX.startsWith(RESERVED_ATTRIBUTE_PREFIX));
    assert.notEqual(CUSTOMER_ATTRIBUTE_PREFIX, RESERVED_ATTRIBUTE_PREFIX);
  });

  it('never puts an internal attribute on the emitted list', () => {
    for (const key of INTERNAL_ATTRIBUTES) {
      assert.equal(EMITTED_ATTRIBUTES.includes(key), false, `${key} is both internal and emitted`);
    }
  });

  /**
   * The reason the two prefixes exist.
   *
   * A caller who has never heard of `octic.run.id` can still pass a business
   * attribute called `run.id`. Under the old single prefix that produced exactly
   * `octic.run.id`, and it won: span-option attributes are applied when the span
   * is constructed, this stamps in `onStart`, and `onStart` runs second. The
   * graph join key was silently overwritable from application code.
   */
  it('cannot let a tenant attribute land on a reserved key', () => {
    const attributes = identityScope.attributesFrom(
      identityScope.contextWith(ROOT_CONTEXT, {
        conversationId: 'conv-1',
        attributes: { stack: 'svc-otel', 'run.id': 'hijacked', 'agent.asset_ref': 'hijacked' },
      }),
    );

    assert.equal(attributes?.[`${CUSTOMER_ATTRIBUTE_PREFIX}stack`], 'svc-otel');
    assert.equal(attributes?.[ATTR_OCTIC_RUN_ID], undefined);
    assert.equal(attributes?.[ATTR_OCTIC_AGENT_ASSET_REF], undefined);

    for (const key of Object.keys(attributes ?? {})) {
      const reserved =
        key.startsWith(RESERVED_ATTRIBUTE_PREFIX) && !key.startsWith(CUSTOMER_ATTRIBUTE_PREFIX);
      assert.equal(reserved, false, `tenant attribute reached the reserved namespace as ${key}`);
    }
  });
});

/**
 * The round trip: what the SDK actually emits, against what the contract says
 * it may.
 *
 * The cases above check that the generated file agrees with semconv and that
 * the redactor reads the generated file. Neither notices the third way these
 * drift — a new `span.setAttribute` in the source that nobody added to the
 * contract, or a contract entry for something the SDK stopped emitting. Both
 * are silent, and both are the kind of thing a consumer discovers by finding
 * an attribute it has no schema for.
 *
 * So this drives one run through every annotation and every scope, collects
 * what came out, and checks it both ways.
 */
describe('the wire surface, round trip', () => {
  /** Everything the SDK can put on a span, exercised once. */
  const emitEverything = async () => {
    const { buildProvider, withGlobalTracerProvider, withPolicy, installContextManager } =
      await import('./support/harness.ts');
    const { withWorkflow, withTool, withRetrieval } = await import('../src/annotations.ts');
    const { withIdentity } = await import('../src/identity.ts');
    const { withAgent } = await import('../src/agent.ts');
    const { withPrompt } = await import('../src/prompt.ts');

    installContextManager();

    const collected = new Set<string>();

    for (const capture of ['none', 'full'] as const) {
      const { collector, provider, foreignTracer } = buildProvider({
        content: { capture },
        /** `init()` always sets both halves of the service identity. */
        resource: { 'service.version': '1.4.0' },
        processorDefaults: {
          'octic.schema.version': '1',
          'octic.sdk.name': 'octic-node',
          'octic.sdk.version': '0.0.0',
          'deployment.environment.name': 'test',
        },
      });

      await withPolicy({ capture }, () =>
        withGlobalTracerProvider(provider, () =>
          withIdentity({ conversationId: 'conv-1', userId: 'user-1' }, () =>
            withAgent({ id: 'agent-1', name: 'Agent', assetRef: 'poc/agent/one' }, () =>
              withWorkflow(
                { name: 'chat-turn', input: { q: 'hi' }, target: { name: 'x', type: 'service' } },
                async () => {
                  await withPrompt({ template: 'weather', version: '3' }, async () => {
                    /**
                     * Carries content as well as a token count, so the `none`
                     * pass has something to withhold — otherwise nothing ever
                     * sets `octic.redacted` and the contract entry for it looks
                     * stale when it is not.
                     */
                    foreignTracer
                      .startSpan('chat gpt-5', {
                        attributes: {
                          'gen_ai.usage.input_tokens': 5,
                          'gen_ai.input.messages': '[{"role":"user"}]',
                        },
                      })
                      .end();
                  });
                  await withTool(
                    {
                      name: 'get_weather',
                      input: { city: 'Paris' },
                      target: {
                        name: 'forecast-api',
                        type: 'service',
                        assetRef: 'poc/service/forecast',
                      },
                    },
                    async () => ({ tempC: 14 }),
                  );
                  await withRetrieval({ name: 'city-guide', input: 'weather' }, async () => [1]);
                  return { reply: 'ok' };
                },
              ),
            ),
          ),
        ),
      );

      for (const span of collector.spans) {
        for (const key of Object.keys(span.attributes)) collected.add(key);
        for (const key of Object.keys(span.resource.attributes)) collected.add(key);
      }
    }

    return collected;
  };

  /**
   * Keys foreign instrumentation wrote, which we carry but do not own. The
   * contract governs what *we* emit; passing a vendor's key through is the
   * whole point of the enrichment model.
   */
  const FOREIGN = new Set(['gen_ai.usage.input_tokens', 'gen_ai.input.messages']);

  it('emits nothing the contract has not declared', async () => {
    const emitted = await emitEverything();
    const undeclared = [...emitted].filter(
      key => !EMITTED_ATTRIBUTES.includes(key) && !FOREIGN.has(key),
    );
    assert.deepEqual(
      undeclared,
      [],
      'add these to contract/attributes.yaml and regenerate, or stop emitting them',
    );
  });

  it('never lets an internal attribute reach the wire', async () => {
    const emitted = await emitEverything();
    for (const key of INTERNAL_ATTRIBUTES) {
      assert.equal(emitted.has(key), false, `${key} is internal plumbing and escaped`);
    }
  });

  /**
   * The other direction, which is the one that rots quietly: a contract entry
   * for something nothing emits any more reads as a promise to consumers that
   * the SDK is not keeping.
   */
  it('emits everything the contract declares', async () => {
    const emitted = await emitEverything();
    const missing = EMITTED_ATTRIBUTES.filter(key => !emitted.has(key));
    assert.deepEqual(
      missing,
      [],
      'the contract declares these but no scenario produced them — extend the scenario or drop the entry',
    );
  });
});

/**
 * The instrumentation scope name, which the drift check cannot see.
 *
 * `restatedKeys` in `contract/generate.ts` owns attribute *keys* — ids, content
 * keys, denied keys, field aliases — and deliberately not enum *values*, because
 * `'none'`, `'metadata'` and `'full'` are legitimate union members all over
 * `content.ts` and flagging them would bury every real finding. So the one enum
 * value this package depends on being a single copy is pinned here instead.
 *
 * It matters because it is read twice, in two directions: our own spans are
 * created under it, and `redacting-exporter.ts` decides a span is foreign by not
 * finding its scope in the set. A hand-written copy that drifts from the
 * contract stops our spans being recognised as ours — and a foreign span is the
 * one the content heuristic runs on, so the failure is a leak in the permissive
 * direction rather than a missing attribute.
 */
describe('the instrumentation scope', () => {
  it('is the SDK name the contract publishes, not a literal of our own', () => {
    assert.equal(TRACER_NAME, SDK_NAME);
    assert.equal(SDK_NAME, OCTIC_SDK_NAME_VALUE_OCTIC_NODE);
    assert.ok(
      (OCTIC_SDK_NAME_VALUES as readonly string[]).includes(TRACER_NAME),
      'the scope our spans carry must be a member of octic.sdk.name',
    );
  });

  /**
   * The scope version travels on the wire beside the name. It was `'0.0.0'`
   * until the public-surface pass, which made every span claim a version that
   * could not identify a release.
   */
  it('carries the package version, not a placeholder', () => {
    assert.equal(TRACER_VERSION, SDK_VERSION);
    assert.notEqual(TRACER_VERSION, '0.0.0');
  });
});
