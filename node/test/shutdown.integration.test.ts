/**
 * `forceFlush()` and `shutdown()` against a collector that is not there.
 *
 * Found by running a fake application rather than by reading the code, which
 * is why it is worth keeping as a test: guarding our own exporters was not
 * enough. `TracerProvider.forceFlush`
 * (`sdk-trace/build/src/TracerProvider.js:92-104`) collects what its
 * processors produced and **rejects with an array of errors** — not an Error,
 * an array — and `SimpleSpanProcessor` hands it a rejected pending export when
 * the connection is refused. Unguarded, a consumer calling
 * `await telemetry.forceFlush()` from their own SIGTERM handler died on an
 * uncaught `[Error: connect ECONNREFUSED]`: a clean shutdown turned into a
 * non-zero exit by the telemetry SDK.
 *
 * Its own file for the usual reason — the init latch is process state — and it
 * is the slowest file in the suite at roughly eight seconds, because that is
 * how long the OTLP exporter's own retry budget takes to give up. Worth it:
 * the retrying is the part that produced the rejection.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { withWorkflow } from '../src/annotations.ts';
import { init } from '../src/index.ts';
import { installContextManager } from './support/harness.ts';

installContextManager();

/**
 * The failure this file exists for, found by running a fake application rather
 * than by reading the code: guarding our own exporters is not enough.
 * `TracerProvider.forceFlush` (`sdk-trace/build/src/TracerProvider.js:92-104`)
 * collects what its processors produced and **rejects with an array of
 * errors**, and `SimpleSpanProcessor` hands it a rejected pending export when
 * the collector refuses the connection. Unguarded, a consumer calling
 * `await telemetry.forceFlush()` from their SIGTERM handler died on an
 * uncaught `[Error: connect ECONNREFUSED]` — a clean shutdown turned into a
 * non-zero exit by the telemetry SDK.
 */
describe('the handle a consumer calls by hand', () => {
  /** Port 9 is the discard port: nothing listens, connections are refused. */
  const dead = 'http://127.0.0.1:9/';

  it('never rejects, even with a batch stuck against a dead collector', async () => {
    const telemetry = init({
      endpoint: dead,
      auth: { kind: 'apiKey', apiKey: 'x' },
      spool: { mode: 'fallback' },
      serviceName: 'dead-collector',
    });

    await withWorkflow({ name: 'one-request' }, async () => undefined);

    await assert.doesNotReject(() => telemetry.forceFlush());
    await assert.doesNotReject(() => telemetry.shutdown());
    /** Idempotent: a second shutdown from a retry path is not an error. */
    await assert.doesNotReject(() => telemetry.shutdown());
  });
});
