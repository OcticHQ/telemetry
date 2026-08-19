/**
 * The mechanism, tested once.
 *
 * Identity, agent, run id and prompt are four instances of one pattern, and if
 * `createContextScope` is right they are right. What is worth pinning here is
 * the part that is easy to get wrong and impossible to notice: the value has to
 * survive an `await`, a timer and a `Promise.all`, because a real agent run is
 * nothing but those. A scope that silently evaporates across an await stamps
 * spans correctly in a synchronous test and stamps nothing in production.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ROOT_CONTEXT, context } from '@opentelemetry/api';

import { createContextScope } from '../src/context-scope.ts';
import { installContextManager } from './support/harness.ts';

installContextManager();

interface Thing {
  a?: string;
  b?: string;
}

/** Replaces on nesting — the `withAgent` / `withPrompt` shape. */
const replacing = createContextScope<Thing>({
  key: 'test.replacing',
  toAttributes: value => ({ 'test.a': value.a ?? '', 'test.b': value.b ?? '' }),
});

/** Merges on nesting — the `withIdentity` shape. */
const merging = createContextScope<Thing>({
  key: 'test.merging',
  toAttributes: value => ({ 'test.a': value.a ?? '', 'test.b': value.b ?? '' }),
  merge: (existing, incoming) => ({ ...existing, ...incoming }),
});

describe('a scope value', () => {
  it('is undefined before anything sets it', () => {
    assert.equal(replacing.from(ROOT_CONTEXT), undefined);
    assert.equal(replacing.attributesFrom(ROOT_CONTEXT), undefined);
  });

  it('is visible inside with() and gone after it', () => {
    replacing.with({ a: 'inside' }, () => {
      assert.deepEqual(replacing.from(context.active()), { a: 'inside' });
    });
    assert.equal(replacing.from(context.active()), undefined);
  });

  it('is restored to the outer value when an inner scope exits', () => {
    replacing.with({ a: 'outer' }, () => {
      replacing.with({ a: 'inner' }, () => {
        assert.equal(replacing.from(context.active())?.a, 'inner');
      });
      assert.equal(replacing.from(context.active())?.a, 'outer');
    });
  });

  it('does not leak between sibling scopes', () => {
    replacing.with({ a: 'first' }, () => {
      assert.equal(replacing.from(context.active())?.a, 'first');
    });
    replacing.with({ a: 'second' }, () => {
      assert.equal(replacing.from(context.active())?.a, 'second');
    });
  });
});

describe('nesting', () => {
  it('replaces wholesale when the scope declares no merge', () => {
    replacing.with({ a: 'outer', b: 'kept?' }, () => {
      replacing.with({ a: 'inner' }, () => {
        const value = replacing.from(context.active());
        assert.equal(value?.a, 'inner');
        assert.equal(value?.b, undefined, 'replace means replace — b must not survive');
      });
    });
  });

  it('merges field by field when the scope declares one', () => {
    merging.with({ a: 'outer', b: 'outer-b' }, () => {
      merging.with({ a: 'inner' }, () => {
        const value = merging.from(context.active());
        assert.equal(value?.a, 'inner', 'the inner write wins on a shared key');
        assert.equal(value?.b, 'outer-b', 'and leaves untouched keys alone');
      });
    });
  });
});

describe('purity', () => {
  it('contextWith returns a new context and does not mutate the old one', () => {
    const next = replacing.contextWith(ROOT_CONTEXT, { a: 'x' });
    assert.notEqual(next, ROOT_CONTEXT);
    assert.equal(replacing.from(ROOT_CONTEXT), undefined);
    assert.equal(replacing.from(next)?.a, 'x');
  });

  it('with() returns whatever the callback returns', () => {
    assert.equal(
      replacing.with({ a: 'x' }, () => 42),
      42,
    );
  });
});

/**
 * The cases that decide whether this works on a real agent run rather than in a
 * synchronous test. Every one of these is a shape the annotations produce.
 */
describe('across async boundaries', () => {
  it('survives an await', async () => {
    await replacing.with({ a: 'awaited' }, async () => {
      await Promise.resolve();
      assert.equal(replacing.from(context.active())?.a, 'awaited');
    });
  });

  it('survives a timer', async () => {
    await replacing.with({ a: 'timed' }, async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(replacing.from(context.active())?.a, 'timed');
    });
  });

  it('keeps concurrent scopes apart under Promise.all', async () => {
    const observe = (value: string, delay: number) =>
      replacing.with({ a: value }, async () => {
        await new Promise(resolve => setTimeout(resolve, delay));
        return replacing.from(context.active())?.a;
      });

    // Interleaved on purpose: the later-started one finishes first.
    const seen = await Promise.all([observe('slow', 20), observe('fast', 1)]);
    assert.deepEqual(seen, ['slow', 'fast']);
  });

  /**
   * Work that outlives the scope that started it still carries it. This is
   * AsyncLocalStorage semantics rather than a decision of ours, but it is
   * load-bearing — a tool call kicked off inside `withWorkflow` and awaited
   * after it returns must still land on the run — so it is pinned here rather
   * than left to be rediscovered.
   */
  it('follows work detached from the scope that started it', async () => {
    let detached: Promise<string | undefined> | undefined;
    replacing.with({ a: 'detached' }, () => {
      detached = (async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return replacing.from(context.active())?.a;
      })();
    });
    assert.equal(replacing.from(context.active()), undefined, 'the scope has closed');
    assert.equal(await detached, 'detached', 'but the work it started still carries it');
  });
});
