/**
 * The gate calls, against a gate stood up on a unix socket.
 *
 *   node --test test/gate.test.ts
 */
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type RequestListener } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import {
  attestKey,
  fetchData,
  resetGateForTests,
  sealedInput,
  setSealedPollForTests,
  type FetchRequest,
} from '../src/gate.ts';

interface Seen {
  at: number;
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** `cut` sends a Content-Length 10 bytes past the body, then drops the connection. */
type Answer = (seen: Seen) => { status?: number; body?: string | Buffer; cut?: boolean };

/** A gate on a fresh socket. `answer` may be swapped between calls. */
const gate = async (answer: Answer) => {
  const dir = await mkdtemp(join(tmpdir(), 'g-'));
  const path = join(dir, 'g.sock');
  const seen: Seen[] = [];
  const state = { answer };
  const listener: RequestListener = (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const one = {
        at: performance.now(),
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      seen.push(one);
      const { status = 200, body = '', cut = false } = state.answer(one);
      res.statusCode = status;
      if (cut) {
        res.setHeader('Content-Length', Buffer.byteLength(body) + 10);
        res.write(body, () => res.socket?.destroy());
      } else res.end(body);
    });
  };
  const listen = async () => {
    const server = createServer(listener);
    await new Promise<void>(resolve => server.listen(path, resolve));
    return server;
  };
  let server = await listen();
  return {
    path,
    dir,
    seen,
    state,
    /** Takes the socket away (Node unlinks it on close) until `start`. */
    stop: () => new Promise<void>(resolve => server.close(() => resolve())),
    start: async () => {
      server = await listen();
    },
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

/** The warnings emitted while `run` runs. */
const warningsDuring = async (run: () => Promise<void>): Promise<string[]> => {
  const seen: string[] = [];
  const listener = (warning: Error): void => {
    seen.push(warning.message);
  };
  process.on('warning', listener);
  try {
    await run();
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    process.off('warning', listener);
  }
  return seen;
};

const POLL_MS = 25;
/** A poll that never ends should fail the test, not hang the run. */
const POLLS = { timeout: 5_000 };

const saved = { ...process.env };
beforeEach(() => {
  resetGateForTests();
  setSealedPollForTests(POLL_MS);
});
afterEach(() => {
  resetGateForTests(); // ends any poll a failed test left running
  process.env = { ...saved };
});

describe('sealedInput', () => {
  it('reads the blob from the gate socket in data_blind and data_fetch runs', POLLS, async () => {
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

  it('is null in another mode, without a socket, and on a dead socket', POLLS, async () => {
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

  it('warns once about a missing socket, without OCTIC_TELEMETRY_DEBUG', POLLS, async () => {
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

describe('sealedInput waiting for its parameters', () => {
  /** Answers each GET with the next status in turn, then 200 'sealed'. */
  const inTurn =
    (...statuses: number[]): Answer =>
    () => {
      const status = statuses.shift();
      return status === undefined ? { body: 'sealed' } : { status, body: 'gate-body' };
    };

  it(
    'returns the blob after two 404s, polled at the interval, without a warning',
    POLLS,
    async () => {
      const g = await gate(inTurn(404, 404));
      try {
        process.env.AIRLOCK_RUN_MODE = 'data_blind';
        process.env.AIRLOCK_GATE_SOCKET = g.path;
        let blob: Uint8Array | null = null;
        const warnings = await warningsDuring(async () => {
          blob = await sealedInput();
        });
        assert.equal(new TextDecoder().decode(blob!), 'sealed');
        assert.deepEqual(warnings, []);
        assert.equal(g.seen.length, 3);
        for (let index = 1; index < 3; index += 1) {
          assert.ok(g.seen[index]!.at - g.seen[index - 1]!.at >= POLL_MS - 5);
        }
      } finally {
        await g.close();
      }
    },
  );

  it('retries a 5xx, warning once and never with the body', POLLS, async () => {
    const g = await gate(inTurn(503));
    try {
      process.env.AIRLOCK_RUN_MODE = 'data_fetch';
      process.env.AIRLOCK_GATE_SOCKET = g.path;
      let blob: Uint8Array | null = null;
      const warnings = await warningsDuring(async () => {
        blob = await sealedInput();
      });
      assert.equal(new TextDecoder().decode(blob!), 'sealed');
      assert.equal(g.seen.length, 2);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /503/);
      assert.doesNotMatch(warnings[0]!, /gate-body/);
    } finally {
      await g.close();
    }
  });

  it(
    'is null at once, warning once, on a socket it may not use',
    { ...POLLS, skip: process.getuid?.() === 0 && 'root ignores the mode' },
    async () => {
      const g = await gate(sealedOnly);
      try {
        await chmod(g.path, 0o000);
        process.env.AIRLOCK_RUN_MODE = 'data_blind';
        process.env.AIRLOCK_GATE_SOCKET = g.path;
        let blob: Uint8Array | null = new Uint8Array();
        const warnings = await warningsDuring(async () => {
          blob = await sealedInput();
        });
        assert.equal(blob, null);
        assert.equal(g.seen.length, 0);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0]!, /EACCES/);
      } finally {
        await g.close();
      }
    },
  );

  it('is null at once, warning once, when the socket does not exist', POLLS, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'g-'));
    try {
      process.env.AIRLOCK_RUN_MODE = 'data_blind';
      process.env.AIRLOCK_GATE_SOCKET = join(dir, 'absent.sock');
      let blob: Uint8Array | null = new Uint8Array();
      const warnings = await warningsDuring(async () => {
        blob = await sealedInput();
      });
      assert.equal(blob, null);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /ENOENT/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is null at once when the path is not a socket', POLLS, async () => {
    // Without the type check, Linux would answer ECONNREFUSED and poll forever.
    const dir = await mkdtemp(join(tmpdir(), 'g-'));
    try {
      process.env.AIRLOCK_RUN_MODE = 'data_blind';
      process.env.AIRLOCK_GATE_SOCKET = join(dir, 'file');
      await writeFile(process.env.AIRLOCK_GATE_SOCKET, '');
      let blob: Uint8Array | null = new Uint8Array();
      const warnings = await warningsDuring(async () => {
        blob = await sealedInput();
      });
      assert.equal(blob, null);
      assert.deepEqual(warnings, [
        'octic-telemetry: the gate socket failed (ENOTSOCK); no sealed input',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it(
    'is null at once on any other connection error, such as a path through a file',
    POLLS,
    async () => {
      // ENOTDIR on Linux and macOS alike. A regular file at the path itself is
      // ENOTSOCK on macOS but ECONNREFUSED on Linux, which is retried.
      const dir = await mkdtemp(join(tmpdir(), 'g-'));
      try {
        await writeFile(join(dir, 'file'), '');
        process.env.AIRLOCK_RUN_MODE = 'data_blind';
        process.env.AIRLOCK_GATE_SOCKET = join(dir, 'file', 'g.sock');
        let blob: Uint8Array | null = new Uint8Array();
        const warnings = await warningsDuring(async () => {
          blob = await sealedInput();
        });
        assert.equal(blob, null);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0]!, /ENOTDIR/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it('gives up on any status but 200, 404 or a 5xx, warning once', POLLS, async () => {
    for (const status of [403, 600]) {
      const g = await gate(inTurn(status));
      try {
        process.env.AIRLOCK_RUN_MODE = 'data_blind';
        process.env.AIRLOCK_GATE_SOCKET = g.path;
        let blob: Uint8Array | null = new Uint8Array();
        const warnings = await warningsDuring(async () => {
          blob = await sealedInput();
        });
        assert.equal(blob, null, String(status));
        assert.equal(g.seen.length, 1);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0]!, new RegExp(String(status)));
      } finally {
        await g.close();
      }
    }
  });

  it('retries a truncated 200 as a reset connection', POLLS, async () => {
    let cut = true;
    const g = await gate(() => {
      const answer = { body: 'sealed', cut };
      cut = false;
      return answer;
    });
    try {
      process.env.AIRLOCK_RUN_MODE = 'data_blind';
      process.env.AIRLOCK_GATE_SOCKET = g.path;
      let blob: Uint8Array | null = null;
      const warnings = await warningsDuring(async () => {
        blob = await sealedInput();
      });
      assert.equal(new TextDecoder().decode(blob!), 'sealed');
      assert.equal(g.seen.length, 2);
      assert.deepEqual(warnings, [
        'octic-telemetry: could not reach the gate for the sealed input (ECONNRESET); retrying',
      ]);
    } finally {
      await g.close();
    }
  });

  it('is null at once on a garbled reply, warning "failed"', POLLS, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'g-'));
    const path = join(dir, 'g.sock');
    const server = createNetServer(socket => socket.end('garbage\r\n\r\n'));
    await new Promise<void>(resolve => server.listen(path, resolve));
    try {
      process.env.AIRLOCK_RUN_MODE = 'data_blind';
      process.env.AIRLOCK_GATE_SOCKET = path;
      let blob: Uint8Array | null = new Uint8Array();
      const warnings = await warningsDuring(async () => {
        blob = await sealedInput();
      });
      assert.equal(blob, null);
      assert.deepEqual(warnings, [
        'octic-telemetry: the gate socket failed (failed); no sealed input',
      ]);
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ends an in-flight poll on resetGateForTests, resolving null', POLLS, async () => {
    const g = await gate(() => ({ status: 404 }));
    try {
      process.env.AIRLOCK_RUN_MODE = 'data_blind';
      process.env.AIRLOCK_GATE_SOCKET = g.path;
      const pending = sealedInput();
      while (g.seen.length < 2) await new Promise(resolve => setTimeout(resolve, 5));
      resetGateForTests();
      assert.equal(await pending, null);
    } finally {
      await g.close();
    }
  });

  it('retries a socket that refuses, then goes missing, until it serves', POLLS, async () => {
    const g = await gate(sealedOnly);
    const moved = `${g.path}.x`;
    try {
      // Leave a socket file with no listener behind: move it aside, close the
      // server (which unlinks only the original path), and move it back.
      await rename(g.path, moved);
      await g.stop();
      await rename(moved, g.path);
      process.env.AIRLOCK_RUN_MODE = 'data_blind';
      process.env.AIRLOCK_GATE_SOCKET = g.path;
      let blob: Uint8Array | null = null;
      const warnings = await warningsDuring(async () => {
        const pending = sealedInput();
        await new Promise(resolve => setTimeout(resolve, POLL_MS * 4));
        await unlink(g.path); // a later ENOENT is retried too
        await new Promise(resolve => setTimeout(resolve, POLL_MS * 4));
        await g.start();
        blob = await pending;
      });
      assert.equal(new TextDecoder().decode(blob!), 'sealed');
      assert.equal(g.seen.length, 1);
      assert.equal(warnings.length, 2);
      assert.match(warnings[0]!, /ECONNREFUSED/);
      assert.match(warnings[1]!, /ENOENT/);
    } finally {
      await g.close();
    }
  });
});

const KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const ATTESTED = {
  key_id: 'key_abc',
  bundle: { 'airlock.agent_key': 'airlock.agent-key.v1', run_id: 'run-1' },
  attestation: { mode: 'dev', token: 'tok' },
};

describe('attestKey', () => {
  it('posts exactly the key request and parses the 200', async () => {
    const g = await gate(() => ({ body: JSON.stringify(ATTESTED) }));
    try {
      process.env.AIRLOCK_GATE_SOCKET = g.path;
      const forms: [string, Uint8Array | ArrayBuffer][] = [
        ['data_blind', KEY],
        ['data_fetch', KEY],
        ['data_fetch', KEY.slice().buffer], // webcrypto's exportKey('raw')
        [
          'data_fetch',
          runInNewContext('Uint8Array.from({ length: 32 }, (_, i) => i).buffer') as ArrayBuffer,
        ],
        [
          'data_fetch',
          runInNewContext('Uint8Array.from({ length: 32 }, (_, i) => i)') as Uint8Array,
        ],
        ['data_fetch', new Uint8Array([9, ...KEY, 9]).subarray(1, 33)],
      ];
      for (const [mode, key] of forms) {
        process.env.AIRLOCK_RUN_MODE = mode;
        assert.deepEqual(await attestKey(key), {
          ok: true,
          keyId: 'key_abc',
          bundle: ATTESTED.bundle,
          attestation: { mode: 'dev', token: 'tok' },
        });
      }
      assert.equal(g.seen.length, forms.length);
      assert.equal(new Set(g.seen.map(({ body }) => body)).size, 1);
      const [post] = g.seen;
      assert.equal(post!.method, 'POST');
      assert.equal(post!.url, '/v0/attest');
      assert.equal(post!.headers['content-type'], 'application/json');
      assert.equal(
        post!.body,
        '{"schema":"airlock.agent-key.request.v1","key":{"kty":"OKP","crv":"X25519","x":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}}',
      );
    } finally {
      await g.close();
    }
  });

  it('turns each refusal and each malformed 200 into its reason', async () => {
    const g = await gate(() => ({}));
    try {
      process.env.AIRLOCK_RUN_MODE = 'data_blind';
      process.env.AIRLOCK_GATE_SOCKET = g.path;
      const json = (value: unknown): string => JSON.stringify(value);
      const cases: [number, string | Buffer, string][] = [
        [400, 'malformed\n', 'malformed'],
        [409, 'already_attested\n', 'already_attested'],
        [422, 'attest_failed\n', 'attest_failed'],
        [413, 'malformed\n', 'malformed'],
        [422, 'Not A Token\n', 'gate_error'],
        [404, '404 page not found\n', 'unsupported'],
        [405, 'Method Not Allowed\n', 'unsupported'],
        [500, 'internal\n', 'gate_error'],
        [200, 'not json', 'read_failed'],
        [200, '[]', 'read_failed'],
        [200, 'null', 'read_failed'],
        [200, `\ufeff${json(ATTESTED)}`, 'read_failed'],
        [200, Buffer.from([0x7b, 0xff, 0x7d]), 'read_failed'],
        [200, json({ ...ATTESTED, key_id: 1 }), 'read_failed'],
        [200, json({ ...ATTESTED, bundle: [] }), 'read_failed'],
        [200, json({ ...ATTESTED, bundle: null }), 'read_failed'],
        [200, json({ ...ATTESTED, attestation: undefined }), 'read_failed'],
        [200, json({ ...ATTESTED, attestation: { mode: 1, token: 'tok' } }), 'read_failed'],
        [200, json({ ...ATTESTED, attestation: { mode: 'dev' } }), 'read_failed'],
      ];
      for (const [status, body, reason] of cases) {
        g.state.answer = () => ({ status, body });
        assert.deepEqual(await attestKey(KEY), { ok: false, reason }, `${status} ${String(body)}`);
      }
    } finally {
      await g.close();
    }
  });

  it('refuses outside a sealed run and a key that is not 32 bytes, without touching the gate', async () => {
    const g = await gate(() => ({ body: JSON.stringify(ATTESTED) }));
    try {
      process.env.AIRLOCK_GATE_SOCKET = g.path;
      for (const mode of [undefined, 'standard']) {
        if (mode === undefined) delete process.env.AIRLOCK_RUN_MODE;
        else process.env.AIRLOCK_RUN_MODE = mode;
        assert.deepEqual(await attestKey(KEY), { ok: false, reason: 'not_sealed_run' });
      }
      process.env.AIRLOCK_RUN_MODE = 'data_blind';
      for (const key of [
        KEY.subarray(1),
        new Uint8Array(33),
        new ArrayBuffer(31),
        new Uint16Array(16),
        new DataView(new ArrayBuffer(32)),
        [...KEY],
      ]) {
        assert.deepEqual(await attestKey(key as Uint8Array), { ok: false, reason: 'malformed' });
      }
      assert.equal(g.seen.length, 0);
    } finally {
      await g.close();
    }
  });

  it('is no_gate without a socket and gate_unreachable on an absent one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'g-'));
    try {
      delete process.env.AIRLOCK_GATE_SOCKET;
      const short = KEY.subarray(1);
      process.env.AIRLOCK_RUN_MODE = 'standard';
      assert.deepEqual(await attestKey(short), { ok: false, reason: 'not_sealed_run' });
      process.env.AIRLOCK_RUN_MODE = 'data_fetch';
      assert.deepEqual(await attestKey(short), { ok: false, reason: 'no_gate' });
      assert.deepEqual(await attestKey(KEY), { ok: false, reason: 'no_gate' });
      process.env.AIRLOCK_GATE_SOCKET = '';
      assert.deepEqual(await attestKey(KEY), { ok: false, reason: 'no_gate' });
      process.env.AIRLOCK_GATE_SOCKET = join(dir, 'absent.sock');
      assert.deepEqual(await attestKey(KEY), { ok: false, reason: 'gate_unreachable' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
        [409, 'not_ready\n', 'not_ready'],
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
