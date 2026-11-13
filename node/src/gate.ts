/**
 * Calls to Airlock's gate over `$AIRLOCK_GATE_SOCKET`.
 *
 * `sealedInput` reads the run's sealed parameters in a data-blind or data-fetch
 * run. `fetchData` hands the FIU's credentials to the gate in a data-fetch run
 * and reads back the vault entries the orchestrator fetched.
 *
 * Neither throws or rejects. `sealedInput` warns once per distinct problem
 * through `process.emitWarning`; `fetchData` writes no warnings, because its
 * result is the report.
 */
import { request } from 'node:http';

const FETCH_TIMEOUT_MS = 330_000; // the orchestrator's 5-minute fetch timeout, plus margin
const READ_TIMEOUT_MS = 30_000;
const MAX_REQUEST_BYTES = 64 * 1024; // the gate's limit; over it, it answers 413 early and may reset
const TOKEN = /^[a-z0-9_]{1,64}$/;
const EDGE_SPACE = /^[ \t\r\n]+|[ \t\r\n]+$/g;
// fatal: invalid UTF-8 throws. ignoreBOM: a BOM is kept as text, not dropped.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const warned = new Set<string>();

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
 * One request over the socket: the reply, or undefined on any failure. A
 * promise settles once, so a late 'error' or 'close' after 'end' is a no-op.
 * A `body` is zeroed as soon as it has been written, and again on close.
 */
const call = (
  socketPath: string,
  method: 'GET' | 'POST',
  path: string,
  timeout: number,
  body?: Buffer,
): Promise<Reply | undefined> =>
  new Promise(resolve => {
    const fail = (): void => {
      resolve(undefined);
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
      req.on('timeout', () => req.destroy());
      req.on('error', fail);
      req.on('close', fail);
      req.on('response', res => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', fail);
        res.on('close', fail);
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
      fail();
    }
  });

/**
 * The run's sealed input from the gate, or null. Never rejects. Data-blind and
 * data-fetch runs have one: `AIRLOCK_RUN_MODE` must be `data_blind` or
 * `data_fetch`.
 */
export async function sealedInput(): Promise<Uint8Array | null> {
  const mode = process.env.AIRLOCK_RUN_MODE;
  if (mode !== 'data_blind' && mode !== 'data_fetch') return null;
  const socketPath = process.env.AIRLOCK_GATE_SOCKET;
  if (socketPath === undefined || socketPath === '') {
    warnOnce('AIRLOCK_GATE_SOCKET is not set; no sealed input');
    return null;
  }
  const reply = await call(socketPath, 'GET', '/v0/data/sealed', READ_TIMEOUT_MS);
  // A copy: Buffer.concat may hand back a slice of the shared pool.
  if (reply?.status === 200) return new Uint8Array(reply.body);
  warnOnce('could not read the sealed input from the gate');
  return null;
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
  if (posted === undefined) return refused('gate_unreachable');
  if (posted.status !== 200) return refused(reasonFor(posted));
  const names = namesIn(posted.body);
  if (names === undefined) return refused('read_failed');
  const entries = new Map<string, Uint8Array>();
  try {
    for (const name of names) {
      // encodeURIComponent throws on a lone surrogate.
      const path = `/v0/data/${encodeURIComponent(name)}`;
      const got = await call(socketPath, 'GET', path, READ_TIMEOUT_MS);
      if (got?.status !== 200) return refused('read_failed');
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

/** For tests: forget the one-time warnings. */
export const resetGateForTests = (): void => {
  warned.clear();
};
