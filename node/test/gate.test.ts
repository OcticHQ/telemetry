/**
 * The gate calls, against a gate stood up on a unix socket.
 *
 *   node --test test/gate.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { fetchData, resetGateForTests, sealedInput, type FetchRequest } from '../src/gate.ts';

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

type Answer = (seen: Seen) => { status?: number; body?: string | Buffer };

/** A gate on a fresh socket. `answer` may be swapped between calls. */
const gate = async (answer: Answer) => {
  const dir = await mkdtemp(join(tmpdir(), 'g-'));
  const path = join(dir, 'g.sock');
  const seen: Seen[] = [];
  const state = { answer };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const one = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      seen.push(one);
      const { status = 200, body = '' } = state.answer(one);
      res.statusCode = status;
      res.end(body);
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  return {
    path,
    dir,
    seen,
    state,
    close: async () => {
      server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
};

const sealedOnly: Answer = ({ url }) =>
  url === '/v0/data/sealed' ? { body: 'sealed' } : { status: 404 };

const CREDENTIALS = {
  schema: 'airlock.rebit.credentials.v1',
  entity_id: 'fiu-1',
  secret: 's3cret',
  signing_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
  signing_kid: 'kid-1',
};

const REQUEST: FetchRequest = {
  credentials: CREDENTIALS,
  consentId: 'consent-1',
  fiDataRange: { from: '2026-01-01T00:00:00Z', to: '2026-06-30T00:00:00Z' },
};

const saved = { ...process.env };
beforeEach(() => resetGateForTests());
afterEach(() => {
  process.env = { ...saved };
});

describe('sealedInput', () => {
  it('reads the blob from the gate socket in data_blind and data_fetch runs', async () => {
    const g = await gate(sealedOnly);
    try {
      process.env.AIRLOCK_GATE_SOCKET = g.path;
      for (const mode of ['data_blind', 'data_fetch']) {
        process.env.AIRLOCK_RUN_MODE = mode;
        const blob = await sealedInput();
        assert.equal(new TextDecoder().decode(blob!), 'sealed', mode);
      }
    } finally {
      await g.close();
    }
  });

  it('is null in another mode, without a socket, and on a dead socket', async () => {
    const g = await gate(sealedOnly);
    try {
      process.env.AIRLOCK_GATE_SOCKET = g.path;
      delete process.env.AIRLOCK_RUN_MODE;
      assert.equal(await sealedInput(), null);
      process.env.AIRLOCK_RUN_MODE = 'standard';
      assert.equal(await sealedInput(), null);
      assert.equal(g.seen.length, 0);
      process.env.AIRLOCK_RUN_MODE = 'data_blind';
      delete process.env.AIRLOCK_GATE_SOCKET;
      assert.equal(await sealedInput(), null);
      process.env.AIRLOCK_GATE_SOCKET = join(g.dir, 'absent.sock');
      assert.equal(await sealedInput(), null);
    } finally {
      await g.close();
    }
  });

  it('warns once about a missing socket, without OCTIC_TELEMETRY_DEBUG', async () => {
    delete process.env.OCTIC_TELEMETRY_DEBUG;
    process.env.AIRLOCK_RUN_MODE = 'data_blind';
    delete process.env.AIRLOCK_GATE_SOCKET;
    const seen: string[] = [];
    const listener = (warning: Error): void => {
      seen.push(warning.message);
    };
    process.on('warning', listener);
    try {
      assert.equal(await sealedInput(), null);
      assert.equal(await sealedInput(), null);
      await new Promise(resolve => setImmediate(resolve));
    } finally {
      process.off('warning', listener);
    }
    assert.equal(seen.length, 1);
    assert.match(seen[0]!, /AIRLOCK_GATE_SOCKET/);
  });
});

describe('fetchData', () => {
  it('posts the request, then reads every entry the gate names', async () => {
    const g = await gate(({ method, url }) => {
      if (method === 'POST' && url === '/v0/fetch') return { body: '{"names":["fi/a b","x"]}' };
      if (url === '/v0/data/fi%2Fa%20b') return { body: Buffer.from([0, 1, 2]) };
      if (url === '/v0/data/x') return { body: 'xx' };
      return { status: 404 };
    });
    try {
      process.env.AIRLOCK_RUN_MODE = 'data_fetch';
      process.env.AIRLOCK_GATE_SOCKET = g.path;
      const result = await fetchData(REQUEST);
      assert.ok(result.ok);
      assert.deepEqual([...result.entries.keys()], ['fi/a b', 'x']);
      assert.deepEqual([...result.entries.get('fi/a b')!], [0, 1, 2]);
      assert.equal(new TextDecoder().decode(result.entries.get('x')), 'xx');

      const [post, ...gets] = g.seen;
      assert.equal(post!.method, 'POST');
      assert.equal(post!.headers['content-type'], 'application/json');
      assert.equal(post!.headers['content-length'], String(Buffer.byteLength(post!.body)));
      assert.deepEqual(JSON.parse(post!.body), {
        schema: 'airlock.fetch.request.v1',
        credentials: CREDENTIALS,
        consent_id: 'consent-1',
        fi_data_range: { from: '2026-01-01T00:00:00Z', to: '2026-06-30T00:00:00Z' },
      });
      assert.deepEqual(
        gets.map(({ method, url }) => `${method} ${url}`),
        ['GET /v0/data/fi%2Fa%20b', 'GET /v0/data/x'],
      );
    } finally {
      await g.close();
    }
  });

  it('turns each refusal into its reason', async () => {
    const g = await gate(() => ({}));
    try {
      process.env.AIRLOCK_RUN_MODE = 'data_fetch';
      process.env.AIRLOCK_GATE_SOCKET = g.path;
      const cases: [number, string | Buffer, string][] = [
        [400, 'malformed\n', 'malformed'],
        [409, 'already_fetched\n', 'already_fetched'],
        [409, 'already_fetched ', 'already_fetched'],
        [400, 'malformed\x1f', 'gate_error'],
        [400, 'malformed\v', 'gate_error'],
        [400, '\ufeffmalformed', 'gate_error'],
        [422, Buffer.from([0x66, 0xff]), 'gate_error'],
        [413, 'malformed\n', 'malformed'],
        [422, 'consent_expired\n', 'consent_expired'],
        [422, 'Not A Token\n', 'gate_error'],
        [500, 'fetch failed\n', 'gate_error'],
        [503, 'busy\n', 'gate_error'],
        [404, '404 page not found\n', 'unsupported'],
        [405, 'Method Not Allowed\n', 'unsupported'],
        [200, '{"names":[1]}', 'read_failed'],
        [200, 'not json', 'read_failed'],
        [200, '[]', 'read_failed'],
        [200, '{}', 'read_failed'],
        [200, '{"names":"x"}', 'read_failed'],
        [200, '\ufeff{"names":[]}', 'read_failed'],
        [200, Buffer.from('{"names":[]}', 'utf16le'), 'read_failed'],
        [200, Buffer.from('{"names":["\xff"]}', 'latin1'), 'read_failed'],
      ];
      for (const [status, body, reason] of cases) {
        g.state.answer = () => ({ status, body });
        assert.deepEqual(
          await fetchData(REQUEST),
          { ok: false, reason },
          `${status} ${String(body)}`,
        );
      }
    } finally {
      await g.close();
    }
  });

  it('zeroes the request buffer once it is sent', async () => {
    const g = await gate(() => ({ status: 409, body: 'already_fetched\n' }));
    try {
      process.env.AIRLOCK_RUN_MODE = 'data_fetch';
      process.env.AIRLOCK_GATE_SOCKET = g.path;
      // fetchData builds its body synchronously, before any I/O, so this sees only that.
      const from = mock.method(Buffer, 'from');
      const pending = fetchData(REQUEST);
      from.mock.restore();
      assert.deepEqual(await pending, { ok: false, reason: 'already_fetched' });
      const [built, ...rest] = from.mock.calls.map(call => call.result as Buffer);
      assert.deepEqual(rest, []);
      assert.equal(built!.length, Buffer.byteLength(g.seen[0]!.body));
      assert.ok(built!.every(byte => byte === 0));
    } finally {
      await g.close();
    }
  });

  it('refuses an oversized request as malformed without touching the gate', async () => {
    const g = await gate(() => ({ body: '{"names":[]}' }));
    try {
      process.env.AIRLOCK_RUN_MODE = 'data_fetch';
      process.env.AIRLOCK_GATE_SOCKET = g.path;
      const big = { ...REQUEST, credentials: { ...CREDENTIALS, secret: 'x'.repeat(65_536) } };
      assert.deepEqual(await fetchData(big), { ok: false, reason: 'malformed' });
      assert.equal(g.seen.length, 0);
    } finally {
      await g.close();
    }
  });

  it('is read_failed for a name that cannot be URL-encoded', async () => {
    const g = await gate(() => ({ body: String.raw`{"names":["\ud800"]}` }));
    try {
      process.env.AIRLOCK_RUN_MODE = 'data_fetch';
      process.env.AIRLOCK_GATE_SOCKET = g.path;
      assert.deepEqual(await fetchData(REQUEST), { ok: false, reason: 'read_failed' });
      assert.equal(g.seen.length, 1);
    } finally {
      await g.close();
    }
  });

  it('is read_failed when a GET fails', async () => {
    const g = await gate(({ method }) =>
      method === 'POST' ? { body: '{"names":["a"]}' } : { status: 500 },
    );
    try {
      process.env.AIRLOCK_RUN_MODE = 'data_fetch';
      process.env.AIRLOCK_GATE_SOCKET = g.path;
      assert.deepEqual(await fetchData(REQUEST), { ok: false, reason: 'read_failed' });
    } finally {
      await g.close();
    }
  });

  it('touches no socket outside a data_fetch run', async () => {
    const g = await gate(() => ({ body: '{"names":[]}' }));
    try {
      process.env.AIRLOCK_GATE_SOCKET = g.path;
      for (const mode of [undefined, 'data_blind', 'standard']) {
        if (mode === undefined) delete process.env.AIRLOCK_RUN_MODE;
        else process.env.AIRLOCK_RUN_MODE = mode;
        assert.deepEqual(await fetchData(REQUEST), { ok: false, reason: 'not_data_fetch' });
      }
      assert.equal(g.seen.length, 0);
    } finally {
      await g.close();
    }
  });

  it('is no_gate, gate_unreachable and malformed before or without a gate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'g-'));
    try {
      process.env.AIRLOCK_RUN_MODE = 'data_fetch';
      delete process.env.AIRLOCK_GATE_SOCKET;
      assert.deepEqual(await fetchData(REQUEST), { ok: false, reason: 'no_gate' });
      process.env.AIRLOCK_GATE_SOCKET = '';
      assert.deepEqual(await fetchData(REQUEST), { ok: false, reason: 'no_gate' });
      process.env.AIRLOCK_GATE_SOCKET = join(dir, 'absent.sock');
      assert.deepEqual(await fetchData(REQUEST), { ok: false, reason: 'gate_unreachable' });
      for (const bad of [
        { ...REQUEST, credentials: { n: 1n } },
        { ...REQUEST, fiDataRange: { from: '2026-01-01T00:00:00Z' } } as unknown as FetchRequest,
      ]) {
        assert.deepEqual(await fetchData(bad), { ok: false, reason: 'malformed' });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
