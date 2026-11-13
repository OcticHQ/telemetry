/**
 * Calls to Airlock's gate over `$AIRLOCK_GATE_SOCKET`.
 *
 * `attestKey` attests the agent's own public key in a data-blind or data-fetch
 * run. `sealedInput` then waits for the run's sealed parameters, which the FIU
 * seals to that key. `fetchData` hands the FIU's credentials to the gate in a
 * data-fetch run and reads back the vault entries the orchestrator fetched.
 *
 * None of them throws or rejects. `sealedInput` warns once per distinct problem
 * through `process.emitWarning`; `attestKey` and `fetchData` write no
 * warnings, because their result is the report.
 */
import { statSync } from 'node:fs';
import { request } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { types } from 'node:util';

const FETCH_TIMEOUT_MS = 330_000; // the orchestrator's 5-minute fetch timeout, plus margin
const READ_TIMEOUT_MS = 30_000;
const ATTEST_TIMEOUT_MS = 60_000; // a quote, a verifier run on the api, and a database write
const POLL_MS = 2_000;
// Connection failures that can fix themselves. Anything else (ENOENT, EACCES, …)
// on the first attempt is a misconfiguration; on a later one it is retried.
const TRANSIENT = new Set(['ECONNREFUSED', 'ECONNRESET', 'timeout']);
const MAX_REQUEST_BYTES = 64 * 1024; // the gate's limit; over it, it answers 413 early and may reset
const TOKEN = /^[a-z0-9_]{1,64}$/;
const EDGE_SPACE = /^[ \t\r\n]+|[ \t\r\n]+$/g;
// fatal: invalid UTF-8 throws. ignoreBOM: a BOM is kept as text, not dropped.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const warned = new Set<string>();
let pollMs = POLL_MS;
// Aborted only by resetGateForTests, so a test's unfinished poll cannot outlive it.
let polls = new AbortController();

const warnOnce = (message: string): void => {
  if (warned.has(message)) return;
  warned.add(message);
  process.emitWarning(`octic-telemetry: ${message}`);
};

interface Reply {
  status: number;
  body: Buffer;
}

/**
 * One request over the socket: the reply, or on any failure a string naming
 * it: an errno name such as `ENOENT`, `timeout`, or `failed` for anything else
 * (a garbled reply, a throw). A connection that closes before the reply ends,
 * a truncated body included, is `ECONNRESET`. A promise settles once, so a
 * late 'error' or 'close' after 'end' is a no-op.
 * A `body` is zeroed as soon as it has been written, and again on close.
 */
const call = (
  socketPath: string,
  method: 'GET' | 'POST',
  path: string,
  timeout: number,
  body?: Buffer,
): Promise<Reply | string> =>
  new Promise(resolve => {
    const fail = (error?: NodeJS.ErrnoException): void => {
      const code = error === undefined ? 'ECONNRESET' : error.code;
      // An errno name has no underscore; HPE_* (parser) and ERR_* (node) are not errnos.
      resolve(code !== undefined && /^E[A-Z0-9]+$/.test(code) ? code : 'failed');
    };
    try {
      const req = request({
        socketPath,
        path,
        method,
        timeout,
        agent: false, // a connection of its own: a stale pooled socket would fail the POST
        ...(body && {
          headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
        }),
      });
      req.on('timeout', () => {
        resolve('timeout');
        req.destroy();
      });
      req.on('error', fail);
      req.on('close', () => {
        fail();
      });
      req.on('response', res => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', fail);
        res.on('close', () => {
          fail();
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) });
        });
      });
      if (body === undefined) {
        req.end();
      } else {
        const wipe = (): void => {
          body.fill(0);
        };
        req.on('close', wipe);
        req.end(body, wipe);
      }
    } catch {
      body?.fill(0);
      resolve('failed');
    }
  });

const sealedRun = (): boolean => {
  const mode = process.env.AIRLOCK_RUN_MODE;
  return mode === 'data_blind' || mode === 'data_fetch';
};

const gateSocket = (): string | undefined => {
  const socketPath = process.env.AIRLOCK_GATE_SOCKET;
  return socketPath === '' ? undefined : socketPath;
};

/**
 * The run's sealed input from the gate, or null. Never rejects. Data-blind and
 * data-fetch runs have one: `AIRLOCK_RUN_MODE` must be `data_blind` or
 * `data_fetch`, else this is null straight away.
 *
 * The FIU seals the input to the agent's attested key, so it arrives after the
 * run starts. This polls every 2 seconds until the gate answers 200, with no
 * limit of its own: the orchestrator's deadline stops the workload. Only what
 * can fix itself is retried: a 404, the gate's "not yet", silently; a refused
 * or reset connection, a timeout or a 5xx with a warning once per distinct
 * problem. A path that is not a socket, any other connection failure (a socket
 * path that does not exist, EACCES, …) on the first attempt, or any other
 * status, warns once and is null; on a later attempt a connection failure is
 * retried.
 */
export async function sealedInput(): Promise<Uint8Array | null> {
  if (!sealedRun()) return null;
  const socketPath = gateSocket();
  if (socketPath === undefined) {
    warnOnce('AIRLOCK_GATE_SOCKET is not set; no sealed input');
    return null;
  }
  // Linux answers a connect() to a regular file with ECONNREFUSED, which is
  // retried; check the path's type so any non-socket gives up on every platform.
  try {
    if (!statSync(socketPath).isSocket()) {
      warnOnce('the gate socket failed (ENOTSOCK); no sealed input');
      return null;
    }
  } catch {
    /* left to the connection, as before */
  }
  const { signal } = polls;
  for (let first = true; ; first = false) {
    const reply = await call(socketPath, 'GET', '/v0/data/sealed', READ_TIMEOUT_MS);
    if (typeof reply === 'string') {
      if (first && !TRANSIENT.has(reply)) {
        warnOnce(`the gate socket failed (${reply}); no sealed input`);
        return null;
      }
      warnOnce(`could not reach the gate for the sealed input (${reply}); retrying`);
    } else if (reply.status === 200) {
      // A copy: Buffer.concat may hand back a slice of the shared pool.
      return new Uint8Array(reply.body);
    } else if (reply.status >= 500 && reply.status <= 599) {
      warnOnce(`the gate answered ${String(reply.status)} for the sealed input; retrying`);
    } else if (reply.status !== 404) {
      warnOnce(`the gate answered ${String(reply.status)} for the sealed input; no sealed input`);
      return null;
    }
    try {
      await sleep(pollMs, undefined, { signal });
    } catch {
      return null; // aborted by resetGateForTests
    }
  }
}

export interface FetchRequest {
  /** The object found inside the sealed parameters, passed through unchanged. */
  credentials: unknown;
  consentId: string;
  /** RFC 3339 timestamps. */
  fiDataRange: { from: string; to: string };
}

export type FetchResult =
  { ok: true; entries: Map<string, Uint8Array> } | { ok: false; reason: string };

const refused = (reason: string): FetchResult => ({ ok: false, reason });

const reasonFor = ({ status, body }: Reply): string => {
  if (status === 404 || status === 405) return 'unsupported';
  if (status === 400 || status === 409 || status === 413 || status === 422) {
    try {
      const text = utf8.decode(body).replace(EDGE_SPACE, '');
      if (TOKEN.test(text)) return text;
    } catch {
      /* not UTF-8: gate_error */
    }
  }
  return 'gate_error';
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const namesIn = (body: Buffer): string[] | undefined => {
  try {
    const parsed: unknown = JSON.parse(utf8.decode(body));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { names } = parsed as { names?: unknown };
    if (!Array.isArray(names) || !names.every(name => typeof name === 'string')) return undefined;
    return names;
  } catch {
    return undefined;
  }
};

/** Everything after the body exists. Holds no reference to the credentials. */
const exchange = async (socketPath: string, body: Buffer): Promise<FetchResult> => {
  const posted = await call(socketPath, 'POST', '/v0/fetch', FETCH_TIMEOUT_MS, body);
  if (typeof posted === 'string') return refused('gate_unreachable');
  if (posted.status !== 200) return refused(reasonFor(posted));
  const names = namesIn(posted.body);
  if (names === undefined) return refused('read_failed');
  const entries = new Map<string, Uint8Array>();
  try {
    for (const name of names) {
      // encodeURIComponent throws on a lone surrogate.
      const path = `/v0/data/${encodeURIComponent(name)}`;
      const got = await call(socketPath, 'GET', path, READ_TIMEOUT_MS);
      if (typeof got === 'string' || got.status !== 200) return refused('read_failed');
      entries.set(name, new Uint8Array(got.body));
    }
  } catch {
    return refused('read_failed');
  }
  return { ok: true, entries };
};

/**
 * Asks the gate to fetch the run's data, then reads each entry it names.
 * Never rejects and writes no warnings: a refusal is `{ ok: false, reason }`.
 *
 * Deliberately not async: the credentials are serialized here, and this frame
 * ends before any I/O, so nothing awaiting the gate holds them.
 */
export function fetchData(fetchRequest: FetchRequest): Promise<FetchResult> {
  try {
    if (process.env.AIRLOCK_RUN_MODE !== 'data_fetch') {
      return Promise.resolve(refused('not_data_fetch'));
    }
    const socketPath = process.env.AIRLOCK_GATE_SOCKET;
    if (socketPath === undefined || socketPath === '') return Promise.resolve(refused('no_gate'));
    let body: Buffer;
    try {
      const { credentials, consentId, fiDataRange } = fetchRequest;
      // JSON.stringify would drop a missing field silently; refuse it here instead.
      const { from, to } = fiDataRange as Partial<FetchRequest['fiDataRange']>;
      if (from === undefined || to === undefined) return Promise.resolve(refused('malformed'));
      body = Buffer.from(
        JSON.stringify({
          schema: 'airlock.fetch.request.v1',
          credentials,
          consent_id: consentId,
          fi_data_range: { from, to },
        }),
      );
    } catch {
      return Promise.resolve(refused('malformed'));
    }
    if (body.length > MAX_REQUEST_BYTES) {
      body.fill(0);
      return Promise.resolve(refused('malformed'));
    }
    return exchange(socketPath, body).catch(() => refused('gate_error'));
  } catch {
    return Promise.resolve(refused('gate_error'));
  }
}

export type AttestResult =
  | {
      ok: true;
      keyId: string;
      bundle: Record<string, unknown>;
      attestation: { mode: string; token: string };
    }
  | { ok: false; reason: string };

const attested = (body: Buffer): AttestResult => {
  try {
    const parsed: unknown = JSON.parse(utf8.decode(body));
    if (isObject(parsed)) {
      const { bundle, attestation } = parsed;
      const keyId = parsed.key_id;
      if (typeof keyId === 'string' && isObject(bundle) && isObject(attestation)) {
        const { mode, token } = attestation;
        if (typeof mode === 'string' && typeof token === 'string') {
          return { ok: true, keyId, bundle, attestation: { mode, token } };
        }
      }
    }
  } catch {
    /* not UTF-8 JSON: read_failed */
  }
  return { ok: false, reason: 'read_failed' };
};

/**
 * Attests the agent's X25519 public key (32 raw bytes, as a byte view or an
 * ArrayBuffer) through the gate, which quotes it and has the api list it. Never
 * rejects and writes no warnings: a refusal is `{ ok: false, reason }`. The
 * agent makes and keeps the private key.
 */
export function attestKey(publicKey: Uint8Array | ArrayBuffer): Promise<AttestResult> {
  const refuse = (reason: string): Promise<AttestResult> => Promise.resolve({ ok: false, reason });
  try {
    if (!sealedRun()) return refuse('not_sealed_run');
    const socketPath = gateSocket();
    if (socketPath === undefined) return refuse('no_gate');
    // An ArrayBuffer (webcrypto's exportKey('raw')), or any byte view, from any realm.
    const view = publicKey as Partial<Uint8Array>;
    const bytes = types.isAnyArrayBuffer(publicKey)
      ? Buffer.from(publicKey)
      : ArrayBuffer.isView(publicKey) && view.BYTES_PER_ELEMENT === 1
        ? Buffer.from(publicKey.buffer, publicKey.byteOffset, publicKey.byteLength)
        : undefined;
    if (bytes?.length !== 32) return refuse('malformed');
    const x = bytes.toString('base64url');
    const body = Buffer.from(
      JSON.stringify({
        schema: 'airlock.agent-key.request.v1',
        key: { kty: 'OKP', crv: 'X25519', x },
      }),
    );
    return call(socketPath, 'POST', '/v0/attest', ATTEST_TIMEOUT_MS, body)
      .then((reply): AttestResult => {
        if (typeof reply === 'string') return { ok: false, reason: 'gate_unreachable' };
        if (reply.status !== 200) return { ok: false, reason: reasonFor(reply) };
        return attested(reply.body);
      })
      .catch(() => ({ ok: false, reason: 'gate_error' }));
  } catch {
    return refuse('gate_error');
  }
}

/** For tests: how often `sealedInput` polls, in milliseconds. */
export const setSealedPollForTests = (ms: number): void => {
  pollMs = ms;
};

/** For tests: forget the one-time warnings, restore the poll interval, end any poll. */
export const resetGateForTests = (): void => {
  warned.clear();
  pollMs = POLL_MS;
  polls.abort();
  polls = new AbortController();
};
