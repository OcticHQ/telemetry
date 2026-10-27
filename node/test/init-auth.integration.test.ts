/**
 * `init({ auth: { kind: 'enrollmentToken' } })` end to end: the wiring, not the
 * mechanism.
 *
 * `auth.integration.test.ts` proves the retry works when it is handed a chain;
 * this proves `setup()` builds that chain — that the headers factory reaches
 * both exporters, that a token minted after `init()` returned lands on a
 * request configured before it existed, and that a 401 from ingest is fixed
 * without the consumer knowing it happened.
 *
 * It also re-asserts the property every new component in this package has to
 * keep: an SDK that mints credentials on a timer and POSTs to a control plane
 * is exactly the shape of thing that ends up holding a process open, so the
 * listener and active-resource counts are compared across `init()` again here.
 *
 * A file to itself, because `init()` latches per process and `node --test`
 * gives one process per file.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { trace } from '@opentelemetry/api';

import { withWorkflow } from '../src/annotations.ts';
import { init, type Telemetry } from '../src/index.ts';
import {
  fakeCollector,
  fakeTokenEndpoint,
  installContextManager,
  FOREIGN_SCOPE,
} from './support/harness.ts';

installContextManager();

/** The events a library has no business touching in somebody else's process. */
const LIFECYCLE_EVENTS = ['beforeExit', 'exit', 'SIGTERM', 'SIGINT'] as const;

const listenerCounts = (): Record<string, number> =>
  Object.fromEntries(LIFECYCLE_EVENTS.map(event => [event, process.listenerCount(event)]));

let collector: Awaited<ReturnType<typeof fakeCollector>>;
let issuer: Awaited<ReturnType<typeof fakeTokenEndpoint>>;
let telemetry: Telemetry;
let listenersBefore: Record<string, number>;

const bearers = (): (string | undefined)[] =>
  collector.traces.map(request => {
    const value = request.headers.authorization;
    return typeof value === 'string' ? value : undefined;
  });

before(async () => {
  collector = await fakeCollector();
  issuer = await fakeTokenEndpoint({ ttlSeconds: 900 });

  listenersBefore = listenerCounts();

  telemetry = init({
    endpoint: collector.url,
    auth: {
      kind: 'enrollmentToken',
      enrollmentToken: 'octic_et_test',
      /** be-api, not be-ingest — two services, and the test wires them apart. */
      tokenUrl: issuer.url,
    },
    serviceName: 'init-auth-integration',
    spool: { mode: 'fallback' },
    content: { capture: 'none' },
    batch: { scheduledDelayMillis: 60_000 },
  });
});

after(async () => {
  await telemetry.shutdown();
  await collector.close();
  await issuer.close();
});

describe('init() with an enrollment token', () => {
  it('exports over HTTP rather than falling back to the spool', async () => {
    /**
     * The credential does not exist when `init()` returns — the exchange is in
     * flight. Treating that as "no credential" would pin the process to the
     * spool for its whole life, so this is the case that would regress
     * silently.
     */
    assert.equal(telemetry.spool, undefined, 'a transport was built, not a disk fallback');

    await withWorkflow({ name: 'first' }, async () => {
      trace.getTracer(FOREIGN_SCOPE).startSpan('chat gpt-5').end();
    });
    await telemetry.forceFlush();

    assert.equal(collector.traces.length, 1);
    assert.match(bearers()[0] ?? '', /^Bearer token-/, 'a minted token, not the enrollment token');
    assert.doesNotMatch(bearers()[0] ?? '', /octic_et_test/);
  });

  it('recovers from a 401 without the consumer seeing one', async () => {
    const before = collector.traces.length;
    collector.setStatuses([401, 200]);

    await withWorkflow({ name: 'second' }, async () => {
      trace.getTracer(FOREIGN_SCOPE).startSpan('chat gpt-5').end();
    });
    await telemetry.forceFlush();

    assert.equal(collector.traces.length - before, 2, 'the refusal and the retry');
    const [refused, retried] = bearers().slice(before);
    assert.notEqual(refused, retried, 'the retry minted rather than re-sent');
  });

  it('holds no lifecycle, token manager included', () => {
    assert.deepEqual(listenerCounts(), listenersBefore, 'no process listener was added');

    /**
     * Timers specifically, rather than the whole resource list. By this point
     * both fake servers are holding accepted sockets and the OTLP exporter's
     * own keep-alive agent is holding a client one — none of which this pull
     * request introduced, and all of which would make a blanket comparison an
     * assertion about the harness. The refresh timer is the thing PR4 added
     * that could keep a process alive, and an `unref()`'d timer is not an
     * active resource.
     */
    const timers = process.getActiveResourcesInfo().filter(name => name === 'Timeout');
    assert.deepEqual(timers, [], 'the token refresh timer does not hold the loop');
  });
});
