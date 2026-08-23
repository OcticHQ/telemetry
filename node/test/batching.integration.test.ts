/**
 * Batching through `init()`, and the property it is most likely to cost us.
 *
 * Switching from one export per span to a queue and a timer is the moment a
 * library starts owning lifecycle. The queue needs draining, the timer needs
 * firing, and the obvious way to make both reliable — a `beforeExit` hook, a
 * `SIGTERM` handler, a timer left holding the loop — is exactly the way a
 * telemetry SDK changes how its host process exits. This package does none of
 * it, and that is asserted here rather than asserted in prose: one case reads
 * `process.getActiveResourcesInfo()` and the listener counts before `init()`
 * and again after the first span, and requires them unchanged.
 *
 * The rest is the delivery contract that replaces the lifecycle: spans are
 * batched, `forceFlush()` is how you make them arrive, `shutdown()` flushes
 * once and can be called twice.
 *
 * A file to itself, because `init()` latches per process and `node --test`
 * gives one process per file.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { trace } from '@opentelemetry/api';

import { init, type Telemetry } from '../src/index.ts';
import { withWorkflow } from '../src/annotations.ts';
import { fakeCollector, FOREIGN_SCOPE, installContextManager } from './support/harness.ts';

installContextManager();

/** The events a library has no business touching in somebody else's process. */
const LIFECYCLE_EVENTS = ['beforeExit', 'exit', 'SIGTERM', 'SIGINT'] as const;

const listenerCounts = (): Record<string, number> =>
  Object.fromEntries(LIFECYCLE_EVENTS.map(event => [event, process.listenerCount(event)]));

let collector: Awaited<ReturnType<typeof fakeCollector>>;
let telemetry: Telemetry;
let listenersBefore: Record<string, number>;
let resourcesBefore: string[];

before(async () => {
  collector = await fakeCollector();

  /**
   * Snapshotted after the collector is listening, so its server socket is
   * already in the baseline and the comparison is about `init()` alone.
   */
  listenersBefore = listenerCounts();
  resourcesBefore = [...process.getActiveResourcesInfo()].sort();

  telemetry = init({
    endpoint: collector.url,
    apiKey: 'batching-token',
    serviceName: 'batching-integration',
    content: { capture: 'none' },
    /**
     * Long enough that nothing arrives on the timer's account during this file:
     * every delivery below is one somebody asked for. The default is 5s and a
     * test that waited for it would be asserting on the clock.
     */
    batch: { scheduledDelayMillis: 60_000 },
  });
});

after(async () => {
  await telemetry.shutdown();
  await collector.close();
});

describe('the SDK holds no lifecycle', () => {
  /**
   * Deliberately one case covering three things — the absence of exit hooks,
   * the absence of signal handlers, and a timer that does not hold the loop.
   * They have one failure mode between them ("the host process now exits
   * differently") and splitting them into three assertions of the same shape
   * would make it three times as easy to leave one behind.
   *
   * The spool is the one documented exception: it installs a `process.on('exit')`
   * drain when it is enabled, so that it can get the last batch onto disk
   * during an exit it did not ask for. This process is credentialed, which
   * leaves the spool off — see init-spool.integration.test.ts for the other side.
   */
  it('adds no process listener and no live handle, before or after a span', () => {
    assert.deepEqual(listenerCounts(), listenersBefore, 'init() attached a process listener');

    trace.getTracer(FOREIGN_SCOPE).startSpan('first').end();

    assert.deepEqual(listenerCounts(), listenersBefore, 'a span attached a process listener');
    assert.deepEqual(
      [...process.getActiveResourcesInfo()].sort(),
      resourcesBefore,
      'something in the pipeline is keeping the event loop alive',
    );
  });
});

describe('delivery', () => {
  it('batches, so many spans become one request', async () => {
    const before = collector.traces.length;

    for (let i = 0; i < 5; i += 1) {
      await withWorkflow({ name: `chat-turn-${String(i)}` }, () => Promise.resolve(undefined));
    }

    /**
     * Nothing has been sent yet and nothing should have been: the batch delay
     * is a minute and the queue is nowhere near full. This is the assertion the
     * proof of concept could not have made — it sent five requests here.
     */
    assert.equal(collector.traces.length, before, 'a span was exported without being asked for');

    await telemetry.forceFlush();

    assert.equal(collector.traces.length, before + 1, 'five spans should be one request');
    const names = collector.spans().map(span => span.name);
    for (let i = 0; i < 5; i += 1) {
      const name = `invoke_workflow chat-turn-${String(i)}`;
      assert.ok(names.includes(name), `${name} did not arrive`);
    }
  });

  /**
   * The flush has to have finished when it resolves, not merely have started.
   * A `forceFlush` that resolved early would leave every consumer's shutdown
   * path racing the exporter, and the loss would only show up under load.
   */
  it('has delivered by the time forceFlush resolves, with nothing left to wait for', async () => {
    const before = collector.traces.length;

    await withWorkflow({ name: 'settled' }, () => Promise.resolve(undefined));
    await telemetry.forceFlush();

    assert.equal(collector.traces.length, before + 1);
    assert.ok(collector.spans().some(span => span.name === 'invoke_workflow settled'));
  });
});

describe('shutdown', () => {
  it('can be called twice without flushing twice or rejecting', async () => {
    await withWorkflow({ name: 'last-words' }, () => Promise.resolve(undefined));

    await assert.doesNotReject(() => telemetry.shutdown());
    const afterFirst = collector.traces.length;

    await assert.doesNotReject(() => telemetry.shutdown());

    assert.equal(collector.traces.length, afterFirst, 'the second shutdown re-ran the pipeline');
    assert.ok(
      collector.spans().some(span => span.name === 'invoke_workflow last-words'),
      'the shutdown flush was skipped',
    );
  });

  it('stops the pipe rather than leaving it half open', async () => {
    const before = collector.traces.length;

    trace.getTracer(FOREIGN_SCOPE).startSpan('after shutdown').end();
    await telemetry.forceFlush();

    assert.equal(collector.traces.length, before, 'a span was exported after shutdown');
  });
});
