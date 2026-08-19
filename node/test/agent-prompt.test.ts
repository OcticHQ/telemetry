/**
 * Agent and prompt: the two scopes that replace rather than merge.
 *
 * They share a file because they share a shape and a reason. An inner
 * `withAgent()` means "this part is a different agent", and an inner
 * `withPrompt()` means "this call used a different template" — in both cases
 * merging with the enclosing value would produce a statement nobody made.
 *
 * The agent case also covers the resource-versus-span split, which is the one
 * place two layers write the same key on purpose: `init({ agent })` puts it on
 * the resource for free, and this scope overrides it per run for a process that
 * hosts several.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ROOT_CONTEXT, context } from '@opentelemetry/api';

import { agentAttributes, agentScope, withAgent } from '../src/agent.ts';
import { promptScope, withPrompt } from '../src/prompt.ts';
import { buildProvider, installContextManager } from './support/harness.ts';

installContextManager();

describe('agentAttributes', () => {
  it('writes the id alone when that is all there is', () => {
    assert.deepEqual(agentAttributes({ id: 'weather' }), { 'gen_ai.agent.id': 'weather' });
  });

  it('writes name and asset ref when supplied', () => {
    assert.deepEqual(agentAttributes({ id: 'weather', name: 'Weather', assetRef: 'poc/agent/w' }), {
      'gen_ai.agent.id': 'weather',
      'gen_ai.agent.name': 'Weather',
      'octic.agent.asset_ref': 'poc/agent/w',
    });
  });

  /**
   * The asset ref is the graph join key — the thing that makes "this agent is
   * unsanctioned" resolve to a node an integration discovered. An empty string
   * would join to nothing, so absent has to stay absent.
   */
  it('omits the asset ref rather than emitting an empty one', () => {
    assert.equal(agentAttributes({ id: 'weather' })['octic.agent.asset_ref'], undefined);
  });
});

describe('withAgent replaces', () => {
  it('does not merge an inner declaration with the enclosing one', () => {
    withAgent({ id: 'outer', name: 'Outer', assetRef: 'poc/agent/outer' }, () => {
      withAgent({ id: 'inner' }, () => {
        const attributes = agentScope.attributesFrom(context.active()) ?? {};
        assert.equal(attributes['gen_ai.agent.id'], 'inner');
        assert.equal(attributes['gen_ai.agent.name'], undefined, 'the outer name must not leak in');
        assert.equal(attributes['octic.agent.asset_ref'], undefined);
      });
    });
  });

  it('restores the outer agent afterwards', () => {
    withAgent({ id: 'outer' }, () => {
      withAgent({ id: 'inner' }, () => {});
      assert.equal(agentScope.from(context.active())?.id, 'outer');
    });
  });
});

describe('withPrompt replaces', () => {
  it('writes template and version', () => {
    const attributes =
      promptScope.attributesFrom(
        promptScope.contextWith(ROOT_CONTEXT, { template: 'compliance-report', version: '3' }),
      ) ?? {};
    assert.equal(attributes['gen_ai.prompt.name'], 'compliance-report');
    assert.equal(attributes['octic.prompt.version'], '3');
  });

  it('omits the version when there is not one', () => {
    const attributes =
      promptScope.attributesFrom(
        promptScope.contextWith(ROOT_CONTEXT, { template: 'compliance-report' }),
      ) ?? {};
    assert.equal(attributes['octic.prompt.version'], undefined);
  });

  it('does not carry the outer version into an inner template', () => {
    withPrompt({ template: 'outer', version: '3' }, () => {
      withPrompt({ template: 'inner' }, () => {
        const attributes = promptScope.attributesFrom(context.active()) ?? {};
        assert.equal(attributes['gen_ai.prompt.name'], 'inner');
        assert.equal(attributes['octic.prompt.version'], undefined);
      });
    });
  });
});

/**
 * Why the prompt is a scope and not an attribute on the workflow span: a run
 * that makes two model calls from two templates has to record both, and an
 * attribute on the run could only record one.
 */
describe('two prompts in one run', () => {
  it('stamps each model call with its own template', () => {
    const { collector, foreignTracer } = buildProvider({ content: { capture: 'none' } });

    withPrompt({ template: 'classify', version: '1' }, () => {
      foreignTracer.startSpan('chat classify').end();
    });
    withPrompt({ template: 'summarize', version: '2' }, () => {
      foreignTracer.startSpan('chat summarize').end();
    });

    assert.equal(collector.named('chat classify').attributes['gen_ai.prompt.name'], 'classify');
    assert.equal(collector.named('chat summarize').attributes['gen_ai.prompt.name'], 'summarize');
  });
});

/**
 * The orchestrator case. `init({ agent })` puts the agent on the *resource*,
 * which the processor here stands in for via `processorDefaults` — that is
 * exactly what `initWithExternalProvider` does when a host SDK owns the
 * resource. A per-run `withAgent()` has to win over it, which works only
 * because the processor applies its defaults before the context scopes.
 */
describe('resource default versus per-run override', () => {
  it('lets withAgent override the process-wide agent on the span', () => {
    const { collector, foreignTracer } = buildProvider({
      content: { capture: 'none' },
      processorDefaults: { 'gen_ai.agent.id': 'orchestrator', 'gen_ai.agent.name': 'Orchestrator' },
    });

    withAgent({ id: 'refund-bot', name: 'Refund Bot' }, () => {
      foreignTracer.startSpan('chat gpt-5').end();
    });

    const span = collector.only();
    assert.equal(span.attributes['gen_ai.agent.id'], 'refund-bot');
    assert.equal(span.attributes['gen_ai.agent.name'], 'Refund Bot');
  });

  it('falls back to the process-wide agent when no override is open', () => {
    const { collector, foreignTracer } = buildProvider({
      content: { capture: 'none' },
      processorDefaults: { 'gen_ai.agent.id': 'orchestrator' },
    });

    foreignTracer.startSpan('chat gpt-5').end();
    assert.equal(collector.only().attributes['gen_ai.agent.id'], 'orchestrator');
  });

  /**
   * A subtlety worth pinning: the override replaces the *scope*, but the
   * processor's defaults are applied first and separately, so a field the
   * override does not mention keeps the default's value rather than being
   * cleared. Two layers, not one merged object.
   */
  it('leaves a default field the override did not mention in place', () => {
    const { collector, foreignTracer } = buildProvider({
      content: { capture: 'none' },
      processorDefaults: { 'gen_ai.agent.id': 'orchestrator', 'gen_ai.agent.name': 'Orchestrator' },
    });

    withAgent({ id: 'refund-bot' }, () => {
      foreignTracer.startSpan('chat gpt-5').end();
    });

    const span = collector.only();
    assert.equal(span.attributes['gen_ai.agent.id'], 'refund-bot');
    assert.equal(span.attributes['gen_ai.agent.name'], 'Orchestrator');
  });
});
