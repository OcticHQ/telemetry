/**
 * The thing that renews the credential, because the credential expires.
 *
 * be-api mints an ingest JWT with a lifetime it chooses — 900 seconds by
 * default, as little as a couple of seconds in a test environment — and
 * be-ingest collapses *every* verification failure, expiry included, into one
 * 401. A header built once at `init()` is therefore correct for exactly one
 * token lifetime and wrong forever after: the batches start failing, the spool
 * takes them, and disk fills with telemetry that a valid token would have
 * delivered.
 *
 * Two properties make this safe to sit in front of an exporter:
 *
 *   1. **It never rejects.** `@opentelemetry/otlp-exporter-base` awaits the
 *      headers factory before every send and documents that functions passed
 *      to it MUST NOT throw. A failed exchange resolves with the last token it
 *      had, or with no `authorization` header at all — both of which produce a
 *      401 that the existing failure path already knows how to handle.
 *   2. **It holds no lifecycle.** The refresh timer is `unref()`'d and cleared
 *      on shutdown, and the exchange runs over an `agent: false` request whose
 *      socket is `unref()`'d — so an exchange in flight, or a token endpoint
 *      that never answers, cannot be the reason a process fails to exit. This
 *      is also why the exchange is not `fetch`: undici keeps a pooled
 *      connection alive after the response, and a keep-alive socket is a live
 *      handle in a package that promises not to own one.
 *
 * The token never reaches a log line, including under
 * `OCTIC_TELEMETRY_DEBUG=1`, and never reaches the spool manifest. Diagnostics
 * name the configured URL and the HTTP status, which are not secrets, and
 * nothing else.
 */
import { diag } from '@opentelemetry/api';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { count } from './counters.ts';

/**
 * Renew at half the token's life. Early enough that a failed attempt has room
 * for several retries before anything expires, late enough that the endpoint
 * sees two requests per lifetime rather than a stream.
 */
const REFRESH_FRACTION = 0.5;

/**
 * The shortest gap between refreshes, whatever the server says. `expiresIn` is
 * the issuer's number and a small one is legitimate — be-api's own test
 * environment issues two-second tokens — but half of two seconds is a refresh
 * every second for the life of the process, which is a load generator pointed
 * at the control plane. The clamp is announced once so a misconfigured issuer
 * is visible rather than merely survivable.
 *
 * Doubles as the base for failure backoff.
 */
export const REFRESH_FLOOR_MS = 30_000;

/** Ceiling on backoff: a token endpoint that comes back is noticed inside five minutes. */
const BACKOFF_MAX_MS = 300_000;

/** One exchange, start to finish. Past this the attempt is a failure like any other. */
const EXCHANGE_TIMEOUT_MS = 10_000;

/**
 * Treat a token as spent slightly before its stated expiry, so a batch that is
 * serialized and sent either side of the boundary is not the thing that
 * discovers it.
 *
 * Capped at a tenth of the lifetime as well, because a fixed five seconds
 * against a two-second token means every single export finds the cache spent
 * and mints again — the clamp on the refresh timer would hold while this turned
 * the exchange into a per-export round trip.
 */
const EXPIRY_SKEW_MS = 5_000;
const EXPIRY_SKEW_FRACTION = 0.1;

interface HttpResponse {
  status: number;
  body: string;
}

interface Token {
  value: string;
  expiresAtMillis: number;
  /** Kept to bound backoff: never wait longer than the token that is running out. */
  lifetimeMillis: number;
  /** How early to stop trusting it — see `EXPIRY_SKEW_MS`. */
  skewMillis: number;
}

export interface TokenManagerOptions {
  enrollmentToken: string;
  /** be-api's `/v1/ingest/token`, not the OTLP endpoint. */
  tokenUrl: string;
  /**
   * The refresh floor, as a parameter only so tests can drive the real timer
   * instead of asserting on a mock — the same seam `configureSilenceWatch()`
   * has, and like that one it is not an `InitOptions` field and should not
   * become one.
   */
  floorMillis?: number;
}

/**
 * A single POST, on a connection nothing pools and nothing keeps alive.
 *
 * `agent: false` is the point: a per-request socket that closes when the
 * response ends, so the only handle this module ever holds is the one it is
 * actively using, and `unref()` means even that one does not hold the loop.
 */
const postJson = (
  url: string,
  body: string,
  timeoutMillis: number,
): { response: Promise<HttpResponse>; abort: () => void } => {
  let pending: ClientRequest | undefined;

  const response = new Promise<HttpResponse>((resolve, reject) => {
    /** A malformed `tokenUrl` throws here, which rejects — it does not escape. */
    const target = new URL(url);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;

    const outgoing = send(
      target,
      {
        method: 'POST',
        agent: false,
        timeout: timeoutMillis,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      incoming => {
        const chunks: Buffer[] = [];
        incoming.on('data', chunk => chunks.push(chunk as Buffer));
        incoming.on('error', reject);
        incoming.on('end', () => {
          resolve({
            status: incoming.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );

    /** Never the reason a process stays alive. */
    outgoing.on('socket', socket => socket.unref());
    outgoing.on('timeout', () => outgoing.destroy(new Error('token exchange timed out')));
    outgoing.on('error', reject);
    outgoing.end(body);
    pending = outgoing;
  });

  return { response, abort: () => pending?.destroy(new Error('token exchange abandoned')) };
};

/**
 * The exchange response, checked rather than trusted. A proxy answering 200
 * with an HTML login page is a real deployment, and `Bearer undefined` is the
 * one outcome worse than no header at all.
 */
const readToken = (payload: string): { accessToken: string; expiresIn: number } | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;

  const { accessToken, expiresIn } = parsed as { accessToken?: unknown; expiresIn?: unknown };
  if (typeof accessToken !== 'string' || accessToken === '') return undefined;
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return undefined;
  }
  return { accessToken, expiresIn };
};

export class TokenManager {
  private readonly enrollmentToken: string;
  private readonly tokenUrl: string;
  private readonly floorMillis: number;

  private token: Token | undefined;
  private inFlight: Promise<Token | undefined> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private abortInFlight: (() => void) | undefined;
  private consecutiveFailures = 0;
  private stopped = false;
  private warnedShortLifetime = false;

  constructor({ enrollmentToken, tokenUrl, floorMillis = REFRESH_FLOOR_MS }: TokenManagerOptions) {
    this.enrollmentToken = enrollmentToken;
    this.tokenUrl = tokenUrl;
    this.floorMillis = floorMillis;
  }

  /**
   * The exporter's headers factory. Bound as a field because it is passed by
   * reference into two exporter constructors and called by them, never by us.
   *
   * Returning `{}` is a deliberate outcome, not a failure to produce one: an
   * unauthenticated request gets a 401, and a 401 is a case the chain already
   * handles — retry once, then spool. Throwing here would violate the
   * exporter's contract, and blocking here would stall every export behind a
   * token endpoint that is down.
   */
  readonly headers = async (): Promise<Record<string, string>> => {
    const token = await this.usableToken();
    return token === undefined ? {} : { authorization: `Bearer ${token}` };
  };

  /**
   * Kicked off from `setup()` so the first export does not pay for the first
   * exchange. Deliberately not awaited: `setup()` is synchronous, and making
   * it async to wait for a network round trip would put a token endpoint in
   * the path of a consumer's `init()` call.
   */
  start(): void {
    void this.exchange();
  }

  /**
   * From the 401 wrapper. Drops the cached token so the next `headers()` mints
   * a fresh one rather than re-sending the credential ingest just rejected.
   */
  invalidate(): void {
    this.token = undefined;
  }

  /** From `shutdown()`, alongside everything else this package has to let go of. */
  shutdown(): void {
    this.stopped = true;
    this.clearTimer();
    this.abortInFlight?.();
  }

  private async usableToken(): Promise<string | undefined> {
    const cached = this.token;
    if (cached !== undefined && Date.now() < cached.expiresAtMillis - cached.skewMillis) {
      return cached.value;
    }

    const minted = await this.exchange();
    /**
     * The fallback is the *stale* token, not nothing: an expired credential and
     * no credential produce the same 401, and the stale one still works if the
     * failure was ours — a DNS blip on the way to be-api says nothing about
     * whether ingest still accepts what we hold.
     *
     * `invalidate()` is the case this deliberately cannot reach: it clears the
     * cache outright, because a token ingest has just refused is not a thing to
     * fall back to.
     */
    return (minted ?? this.token)?.value;
  }

  /** One exchange at a time. Concurrent callers — both signals — await the same one. */
  private exchange(): Promise<Token | undefined> {
    this.inFlight ??= this.runExchange().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async runExchange(): Promise<Token | undefined> {
    if (this.stopped) return undefined;

    count('tokenExchanges');
    const { response, abort } = postJson(
      this.tokenUrl,
      JSON.stringify({ enrollmentToken: this.enrollmentToken }),
      EXCHANGE_TIMEOUT_MS,
    );
    this.abortInFlight = abort;

    try {
      const { status, body } = await response;

      if (status !== 200) {
        /**
         * 401 here is an enrollment token that is unknown or revoked, and
         * be-api does not distinguish the two on purpose. Retrying is still
         * right: the operator's fix is to issue a new token, and the process
         * should pick it up if the old one is reinstated.
         */
        this.failed(`the token endpoint answered ${status}`);
        return undefined;
      }

      const minted = readToken(body);
      if (minted === undefined) {
        this.failed('the token endpoint answered 200 with a body that is not a token');
        return undefined;
      }

      return this.accept(minted.accessToken, minted.expiresIn);
    } catch (error) {
      this.failed(error instanceof Error ? error.message : String(error));
      return undefined;
    } finally {
      this.abortInFlight = undefined;
    }
  }

  private accept(accessToken: string, expiresIn: number): Token {
    const lifetimeMillis = expiresIn * 1000;
    const token: Token = {
      value: accessToken,
      expiresAtMillis: Date.now() + lifetimeMillis,
      lifetimeMillis,
      skewMillis: Math.min(EXPIRY_SKEW_MS, lifetimeMillis * EXPIRY_SKEW_FRACTION),
    };
    this.token = token;
    this.consecutiveFailures = 0;

    const half = lifetimeMillis * REFRESH_FRACTION;
    if (half < this.floorMillis && !this.warnedShortLifetime) {
      this.warnedShortLifetime = true;
      diag.warn(
        `octic-telemetry: the ingest token expires in ${expiresIn}s, which is shorter than this ` +
          `SDK refreshes (${this.floorMillis}ms). Tokens will expire between refreshes and the ` +
          'exporter will retry on each 401. Raise JWT_ACCESS_TTL_SECONDS on the API.',
      );
    }

    this.arm(Math.max(half, this.floorMillis));
    return token;
  }

  private failed(reason: string): void {
    count('tokenExchangeFailures');
    this.consecutiveFailures += 1;
    const delay = this.backoffMillis();

    /** The URL is configuration and the status is a status. Neither is the credential. */
    diag.warn(
      `octic-telemetry: could not exchange the enrollment token at ${this.tokenUrl} — ${reason}. ` +
        `Retrying in ${Math.round(delay / 1000)}s; telemetry spools meanwhile.`,
    );

    this.arm(delay);
  }

  /**
   * Exponential from the floor, capped at five minutes — and capped again at
   * half the lifetime of the token we are holding, because backing off past
   * the point that token expires converts a recoverable failure into an outage.
   */
  private backoffMillis(): number {
    const exponential = this.floorMillis * 2 ** (this.consecutiveFailures - 1);
    const held = this.token;
    const ceiling =
      held === undefined
        ? BACKOFF_MAX_MS
        : Math.max(this.floorMillis, Math.min(BACKOFF_MAX_MS, held.lifetimeMillis / 2));
    return Math.min(exponential, ceiling);
  }

  private arm(delayMillis: number): void {
    this.clearTimer();
    if (this.stopped) return;

    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.exchange();
    }, delayMillis);

    /** Never the reason a process stays alive. */
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
