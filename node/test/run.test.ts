/**
 * The run id: the one identifier in this package that a person is expected to
 * quote.
 *
 * A trace id would technically identify a run, but it is opaque and chosen by
 * the SDK, so it cannot be what a ticket refers to or what a score arriving an
 * hour later keys off. That makes the *shape* part of the contract — readable
 * prefix, enough entropy not to collide — and worth pinning rather than
 * treating as an implementation detail.
 *
 * The scoping half matters just as much: the id is on the Context, not only on
 * the workflow span, which is what lets ingest attribute any span to its run
 * without walking the parent chain.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { withWorkflow } from '../src/annotations.ts';
import { currentRunId, mintRunId } from '../src/run.ts';
import {
  buildProvider,
  installContextManager,
  withGlobalTracerProvider,
  withPolicy,
} from './support/harness.ts';

installContextManager();

describe('mintRunId', () => {
  it('is a readable prefix plus sixteen hex characters', () => {
    assert.match(mintRunId('chat turn'), /^run-chat-turn-[0-9a-f]{16}$/);
  });

  it('lowercases and collapses punctuation into single dashes', () => {
    assert.match(mintRunId('Chat  Turn!!  Two'), /^run-chat-turn-two-[0-9a-f]{16}$/);
  });

  it('trims leading and trailing dashes off the slug', () => {
    assert.match(mintRunId('  !chat!  '), /^run-chat-[0-9a-f]{16}$/);
  });

  it('caps the slug so one long workflow name cannot dominate the id', () => {
    const id = mintRunId('a'.repeat(100));
    const slug = id.slice('run-'.length, id.lastIndexOf('-'));
    assert.equal(slug.length, 24);
  });

  /**
   * A name that slugs to nothing still has to produce a usable id. Non-Latin
   * names are the realistic route to this, not the punctuation case.
   */
  it('falls back to "run" when the name slugs away entirely', () => {
    assert.match(mintRunId('!!!'), /^run-run-[0-9a-f]{16}$/);
    assert.match(mintRunId('日本語'), /^run-run-[0-9a-f]{16}$/);
    assert.match(mintRunId(''), /^run-run-[0-9a-f]{16}$/);
  });

  it('does not repeat itself', () => {
    const ids = new Set(Array.from({ length: 200 }, () => mintRunId('chat')));
    assert.equal(ids.size, 200);
  });
});

describe('currentRunId', () => {
  it('is undefined outside a workflow', () => {
    assert.equal(currentRunId(), undefined);
  });

  it('is the live id inside one', async () => {
    const { provider } = buildProvider();
    let seen: string | undefined;

    await withPolicy({ capture: 'none' }, () =>
      withGlobalTracerProvider(provider, () =>
        withWorkflow({ name: 'chat-turn' }, async () => {
          seen = currentRunId();
        }),
      ),
    );

    assert.match(String(seen), /^run-chat-turn-[0-9a-f]{16}$/);
  });

  it('is undefined again once the workflow returns', async () => {
    const { provider } = buildProvider();
    await withPolicy({ capture: 'none' }, () =>
      withGlobalTracerProvider(provider, () => withWorkflow({ name: 'chat-turn' }, async () => {})),
    );
    assert.equal(currentRunId(), undefined);
  });
});

describe('the id a caller supplies', () => {
  it('is used verbatim rather than minted over', async () => {
    const { collector, provider } = buildProvider();

    await withPolicy({ capture: 'none' }, () =>
      withGlobalTracerProvider(provider, () =>
        withWorkflow({ name: 'chat-turn', runId: 'run-mkt-0412' }, async () => {
          assert.equal(currentRunId(), 'run-mkt-0412');
        }),
      ),
    );

    assert.equal(
      collector.named('invoke_workflow chat-turn').attributes['octic.run.id'],
      'run-mkt-0412',
    );
  });
});

describe('nested workflows', () => {
  it('give the inner run its own id and restore the outer one after', async () => {
    const { provider } = buildProvider();
    const seen: (string | undefined)[] = [];

    await withPolicy({ capture: 'none' }, () =>
      withGlobalTracerProvider(provider, () =>
        withWorkflow({ name: 'outer', runId: 'run-outer' }, async () => {
          seen.push(currentRunId());
          await withWorkflow({ name: 'inner', runId: 'run-inner' }, async () => {
            seen.push(currentRunId());
          });
          seen.push(currentRunId());
        }),
      ),
    );

    assert.deepEqual(seen, ['run-outer', 'run-inner', 'run-outer']);
  });

  it('stamps each span with the run that was open when it started', async () => {
    const { collector, provider } = buildProvider();

    await withPolicy({ capture: 'none' }, () =>
      withGlobalTracerProvider(provider, () =>
        withWorkflow({ name: 'outer', runId: 'run-outer' }, async () => {
          await withWorkflow({ name: 'inner', runId: 'run-inner' }, async () => {});
        }),
      ),
    );

    assert.equal(collector.named('invoke_workflow outer').attributes['octic.run.id'], 'run-outer');
    assert.equal(collector.named('invoke_workflow inner').attributes['octic.run.id'], 'run-inner');
  });
});

/**
 * The reason the id is scoped rather than only stamped on the workflow span:
 * a span the instrumentation created, several levels down, still has to resolve
 * to its run without anybody walking the parent chain.
 */
describe('the run id on spans we did not create', () => {
  it('reaches a foreign span nested inside the workflow', async () => {
    const { collector, provider, foreignTracer } = buildProvider({ content: { capture: 'none' } });

    await withPolicy({ capture: 'none' }, () =>
      withGlobalTracerProvider(provider, () =>
        withWorkflow({ name: 'chat-turn', runId: 'run-x' }, async () => {
          foreignTracer.startSpan('chat gpt-5').end();
        }),
      ),
    );

    assert.equal(collector.named('chat gpt-5').attributes['octic.run.id'], 'run-x');
  });
});
