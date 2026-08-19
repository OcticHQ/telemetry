/**
 * Durable identity, as it lands on a span.
 *
 * Two things here are contracts rather than conveniences. The conversation id
 * is written twice, under the GenAI name and the general one, because which of
 * the two experimental keys survives is not ours to decide. And tenant-supplied
 * attributes go under `octic.custom.`, never bare `octic.` — that split exists
 * because a caller passing `{ 'run.id': ... }` once produced `octic.run.id` and
 * won, since span-option attributes are applied at construction and this stamps
 * in `onStart`.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ROOT_CONTEXT, context } from '@opentelemetry/api';

import { identityHook, identityScope, withIdentity } from '../src/identity.ts';
import { buildProvider, installContextManager } from './support/harness.ts';

installContextManager();

/** Attributes as the processor would compute them, without building a span. */
const attributesFor = (identity: Parameters<typeof withIdentity>[0]) =>
  identityScope.attributesFrom(identityScope.contextWith(ROOT_CONTEXT, identity)) ?? {};

describe('what identity writes', () => {
  it('writes the conversation under both names', () => {
    const attributes = attributesFor({ conversationId: 'conv-1' });
    assert.equal(attributes['gen_ai.conversation.id'], 'conv-1');
    assert.equal(attributes['session.id'], 'conv-1');
  });

  it('writes the user id', () => {
    assert.equal(attributesFor({ userId: 'user-42' })['user.id'], 'user-42');
  });

  it('writes nothing at all for an empty identity', () => {
    assert.deepEqual(attributesFor({}), {});
  });

  it('omits keys for fields that were not supplied', () => {
    const attributes = attributesFor({ userId: 'user-42' });
    assert.equal(attributes['gen_ai.conversation.id'], undefined);
    assert.equal(attributes['session.id'], undefined);
  });

  it('preserves the three attribute value types a tenant may send', () => {
    const attributes = attributesFor({
      attributes: { plan: 'enterprise', seats: 40, trial: false },
    });
    assert.equal(attributes['octic.custom.plan'], 'enterprise');
    assert.equal(attributes['octic.custom.seats'], 40);
    assert.equal(attributes['octic.custom.trial'], false);
  });
});

describe('nesting merges rather than replaces', () => {
  it('lets an inner call add a business id without clobbering the conversation', () => {
    withIdentity({ conversationId: 'conv-1', userId: 'user-42' }, () => {
      withIdentity({ attributes: { ticket: 'T-9' } }, () => {
        const attributes = identityScope.attributesFrom(context.active()) ?? {};
        assert.equal(attributes['gen_ai.conversation.id'], 'conv-1');
        assert.equal(attributes['user.id'], 'user-42');
        assert.equal(attributes['octic.custom.ticket'], 'T-9');
      });
    });
  });

  it('merges the attribute maps instead of replacing the whole map', () => {
    withIdentity({ attributes: { a: '1', b: '2' } }, () => {
      withIdentity({ attributes: { b: 'overwritten', c: '3' } }, () => {
        const attributes = identityScope.attributesFrom(context.active()) ?? {};
        assert.equal(attributes['octic.custom.a'], '1', 'an untouched key survives');
        assert.equal(attributes['octic.custom.b'], 'overwritten', 'the inner write wins');
        assert.equal(attributes['octic.custom.c'], '3');
      });
    });
  });

  it('lets an inner call correct the user id', () => {
    withIdentity({ userId: 'anonymous' }, () => {
      withIdentity({ userId: 'user-42' }, () => {
        assert.equal(identityScope.attributesFrom(context.active())?.['user.id'], 'user-42');
      });
    });
  });
});

describe('identityHook', () => {
  it('makes identity visible to work started inside done()', () => {
    const hook = identityHook<{ conversation: string }>(request => ({
      conversationId: request.conversation,
    }));

    let seen: string | undefined;
    hook({ conversation: 'conv-from-request' }, undefined, () => {
      seen = identityScope.from(context.active())?.conversationId;
    });

    assert.equal(seen, 'conv-from-request');
  });

  /**
   * The failure this shape is designed to avoid. Calling `done()` *outside*
   * `context.with` compiles, runs, and stamps nothing — the request chains off
   * that call, so the context has to be active when it happens.
   */
  it('leaves the surrounding context untouched once the hook returns', () => {
    const hook = identityHook<unknown>(() => ({ conversationId: 'conv-1' }));
    hook({}, undefined, () => {});
    assert.equal(identityScope.from(context.active()), undefined);
  });
});

describe('on a span the instrumentation created', () => {
  it('reaches a foreign span through the processor', () => {
    const { collector, foreignTracer } = buildProvider({ content: { capture: 'none' } });

    withIdentity(
      { conversationId: 'conv-9', userId: 'user-7', attributes: { tier: 'gold' } },
      () => {
        foreignTracer.startSpan('chat gpt-5').end();
      },
    );

    const span = collector.only();
    assert.equal(span.attributes['gen_ai.conversation.id'], 'conv-9');
    assert.equal(span.attributes['session.id'], 'conv-9');
    assert.equal(span.attributes['user.id'], 'user-7');
    assert.equal(span.attributes['octic.custom.tier'], 'gold');
  });

  it('stamps nothing when no identity is set', () => {
    const { collector, foreignTracer } = buildProvider({ content: { capture: 'none' } });
    foreignTracer.startSpan('chat gpt-5').end();

    const span = collector.only();
    assert.equal(span.attributes['gen_ai.conversation.id'], undefined);
    assert.equal(span.attributes['user.id'], undefined);
  });
});
