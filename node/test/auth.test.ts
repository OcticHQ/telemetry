/**
 * The credential, and the two things that can go wrong with one that expires.
 *
 * `resolveAuth` is the cheap half: which of the four states a set of options
 * lands in, including the one the types say cannot happen — a credential that
 * is present and empty, which is what `process.env.OCTIC_API_KEY!` evaluates to
 * in a container whose secret was not mounted.
 *
 * `TokenManager` is the half worth testing carefully, and it is tested against
 * a real HTTP server rather than a stubbed `fetch`, because every property that
 * matters here is a property of a real exchange: that a failure resolves rather
 * than rejects, that concurrent callers produce one request and not two, and
 * that the refresh floor holds when an issuer hands out two-second tokens.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { diag, DiagLogLevel, type DiagLogger } from '@opentelemetry/api';

import { resolveAuth } from '../src/auth.ts';
import { resetCounters, snapshot } from '../src/counters.ts';
import { TokenManager } from '../src/token-manager.ts';
import { fakeTokenEndpoint } from './support/harness.ts';

/** Captures `diag.warn` so a test can assert on what was said — and what was not. */
const warnings: string[] = [];
const capture: DiagLogger = {
  error: () => {},
  warn: (message, ...args) => warnings.push([message, ...args.map(String)].join(' ')),
  info: () => {},
  debug: () => {},
  verbose: () => {},
};

before(() => {
  diag.setLogger(capture, DiagLogLevel.WARN);
});

after(() => {
  diag.disable();
});

afterEach(() => {
  warnings.length = 0;
  resetCounters();
});

describe('resolveAuth', () => {
  it("reads 'none' as a chosen mode, not a missing credential", () => {
    assert.deepEqual(resolveAuth('none'), { mode: 'none' });
  });

  it('reads an api key', () => {
    assert.deepEqual(resolveAuth({ kind: 'apiKey', apiKey: 'k' }), { mode: 'apiKey', apiKey: 'k' });
  });

  it('reads an enrollment token with its token url', () => {
    assert.deepEqual(
      resolveAuth({ kind: 'enrollmentToken', enrollmentToken: 'octic_et_x', tokenUrl: 'u' }),
      { mode: 'enrollmentToken', enrollmentToken: 'octic_et_x', tokenUrl: 'u' },
    );
  });

  it('treats an absent, empty or whitespace credential as missing, with a reason', () => {
    assert.equal(resolveAuth().mode, 'missing');
    /** `apiKey: process.env.OCTIC_API_KEY!` in a container with no secret. */
    assert.equal(
      resolveAuth({ kind: 'apiKey', apiKey: undefined as unknown as string }).mode,
      'missing',
    );
    assert.equal(resolveAuth({ kind: 'apiKey', apiKey: '' }).mode, 'missing');
    assert.equal(resolveAuth({ kind: 'apiKey', apiKey: '  ' }).mode, 'missing');
    assert.equal(
      resolveAuth({ kind: 'enrollmentToken', enrollmentToken: '', tokenUrl: 'u' }).mode,
      'missing',
    );
    assert.equal(
      resolveAuth({ kind: 'enrollmentToken', enrollmentToken: 'octic_et_x', tokenUrl: '' }).mode,
      'missing',
    );
  });

  it('is a resolution, never a throw, on a shape the types forbid', () => {
    const resolved = resolveAuth({ kind: 'oauth' } as unknown as Parameters<typeof resolveAuth>[0]);
    assert.equal(resolved.mode, 'missing');
  });
});

describe('TokenManager', () => {
  let issuer: Awaited<ReturnType<typeof fakeTokenEndpoint>>;
  const managers: TokenManager[] = [];

  const manage = (options: { floorMillis?: number; tokenUrl?: string } = {}): TokenManager => {
    const manager = new TokenManager({
      enrollmentToken: 'octic_et_test',
      tokenUrl: options.tokenUrl ?? issuer.url,
      ...(options.floorMillis === undefined ? {} : { floorMillis: options.floorMillis }),
    });
    managers.push(manager);
    return manager;
  };

  before(async () => {
    issuer = await fakeTokenEndpoint({ ttlSeconds: 900 });
  });

  after(async () => {
    for (const manager of managers) manager.shutdown();
    await issuer.close();
  });

  afterEach(() => {
    /**
     * Every manager, not just this test's: one left running refreshes on its
     * own timer and shows up as an exchange the next test did not ask for.
     */
    for (const manager of managers) manager.shutdown();
    managers.length = 0;
    issuer.setStatus(200);
    issuer.setGarbage(false);
    issuer.setTtlSeconds(900);
  });

  it('exchanges the enrollment token for a bearer header', async () => {
    const manager = manage();
    const headers = await manager.headers();

    assert.equal(typeof headers.authorization, 'string');
    assert.match(headers.authorization ?? '', /^Bearer token-/);
    assert.deepEqual(issuer.bodies().at(-1), { enrollmentToken: 'octic_et_test' });
    assert.equal(snapshot().tokenExchanges, 1);
  });

  it('serves the cached token rather than exchanging per export', async () => {
    const manager = manage();
    const before = issuer.requestCount();

    const first = await manager.headers();
    const second = await manager.headers();

    assert.equal(first.authorization, second.authorization);
    assert.equal(issuer.requestCount() - before, 1);
  });

  it('coalesces concurrent callers into one exchange', async () => {
    const manager = manage();
    const before = issuer.requestCount();

    /** Both signals asking at once, which is what a flush of both looks like. */
    const [traces, logs] = await Promise.all([manager.headers(), manager.headers()]);

    assert.equal(traces.authorization, logs.authorization);
    assert.equal(issuer.requestCount() - before, 1, 'one exchange, not one per caller');
  });

  it('mints again after invalidate(), which is what the 401 retry needs', async () => {
    const manager = manage();
    const first = await manager.headers();

    manager.invalidate();
    const second = await manager.headers();

    assert.notEqual(first.authorization, second.authorization);
  });

  it('resolves with no header rather than rejecting when the endpoint refuses', async () => {
    issuer.setStatus(401);
    const manager = manage();

    const headers = await manager.headers();

    assert.deepEqual(headers, {}, 'an unauthenticated request, not a thrown exporter');
    assert.equal(snapshot().tokenExchangeFailures, 1);
    assert.ok(
      warnings.some(line => line.includes('answered 401')),
      'the failure is visible',
    );
  });

  it('resolves with no header when the endpoint answers 200 with something else', async () => {
    issuer.setGarbage(true);
    const manager = manage();

    assert.deepEqual(await manager.headers(), {});
    assert.ok(warnings.some(line => line.includes('not a token')));
  });

  it('resolves with no header when there is nothing listening at all', async () => {
    const manager = manage({ tokenUrl: 'http://127.0.0.1:1/v1/ingest/token' });

    assert.deepEqual(await manager.headers(), {});
    assert.equal(snapshot().tokenExchangeFailures, 1);
  });

  it('keeps serving the last token it had when a refresh fails', async () => {
    /** One second, so the cache goes stale inside the test rather than in 450s. */
    issuer.setTtlSeconds(1);
    const manager = manage({ floorMillis: 10 });
    const good = await manager.headers();

    issuer.setStatus(500);
    await new Promise(resolve => setTimeout(resolve, 1000));
    const afterFailure = await manager.headers();

    assert.equal(
      afterFailure.authorization,
      good.authorization,
      'a stale token still works if the failure was ours',
    );
  });

  it('discards a token ingest refused, rather than falling back to it', async () => {
    const manager = manage();
    const good = await manager.headers();

    issuer.setStatus(401);
    manager.invalidate();

    assert.deepEqual(
      await manager.headers(),
      {},
      'invalidate() means refused, and a refused token is not a fallback',
    );
    assert.notEqual(good.authorization, undefined);
  });

  it('never puts the credential in a diagnostic', async () => {
    issuer.setStatus(401);
    const manager = manage();
    await manager.headers();

    assert.ok(warnings.length > 0, 'something was said');
    for (const line of warnings) {
      assert.doesNotMatch(line, /octic_et_test/, 'the enrollment token is not in a log line');
      assert.doesNotMatch(line, /token-\d/, 'no minted token either');
    }
  });

  it('warns once when the issuer hands out tokens shorter than the refresh floor', async () => {
    issuer.setTtlSeconds(2);
    const manager = manage();
    await manager.headers();

    const clamped = warnings.filter(line => line.includes('shorter than this'));
    assert.equal(clamped.length, 1);
    assert.ok(clamped[0]?.includes('2s'));

    /** And it stays one, however many refreshes follow. */
    manager.invalidate();
    await manager.headers();
    assert.equal(warnings.filter(line => line.includes('shorter than this')).length, 1);
  });

  it('refreshes on its own at half the lifetime, without an export asking', async () => {
    /**
     * The floor is a parameter for exactly this: the real timer runs, and a
     * 1-second token with a 10ms floor renews 500ms from now rather than 450s.
     */
    issuer.setTtlSeconds(1);
    const manager = manage({ floorMillis: 10 });
    await manager.headers();

    const afterFirst = issuer.requestCount();
    await issuer.waitFor(afterFirst + 1, 2000);

    assert.ok(issuer.requestCount() > afterFirst, 'the refresh happened by itself');
  });

  it('holds no lifecycle: the refresh timer never keeps the process alive', async () => {
    issuer.setTtlSeconds(1);
    const manager = manage({ floorMillis: 10 });
    await manager.headers();

    const timers = process.getActiveResourcesInfo().filter(name => name === 'Timeout');
    assert.equal(timers.length, 0, 'an unref()"d timer is not an active resource');

    manager.shutdown();
  });

  it('stops exchanging after shutdown()', async () => {
    issuer.setTtlSeconds(1);
    const manager = manage({ floorMillis: 10 });
    await manager.headers();
    manager.shutdown();

    const settled = issuer.requestCount();
    await new Promise(resolve => setTimeout(resolve, 600));

    assert.equal(issuer.requestCount(), settled, 'no refresh after shutdown');
  });
});
