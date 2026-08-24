/**
 * How this process proves who it is, resolved once at `init()`.
 *
 * Two credentials, and they are not variants of each other. An API key is a
 * string the caller already holds and that never changes for the life of the
 * process. An enrollment token is a *credential for getting credentials*: it is
 * exchanged at be-api for a short-lived ingest JWT — 900 seconds by default,
 * configurable down to seconds — and everything that expires needs something
 * that renews it. That renewal is `token-manager.ts`; this file is only the
 * shape and the resolution.
 *
 * The union is discriminated rather than four sibling fields because
 * `tokenUrl` is required for exactly one of the two. The token endpoint lives
 * on be-api and the OTLP endpoint lives on be-ingest — different services,
 * different hosts — so there is nothing to default it to, and a `tokenUrl`
 * silently derived from `endpoint` would POST the enrollment token at a service
 * with no such route. As a member of the union the compiler asks for it.
 */

/** What a caller writes. */
export type AuthOptions =
  /**
   * No credential at all, which is what a local forwarder — an OTel Collector
   * on loopback — expects, and what a consumer who does not want to hold a
   * token asks for.
   */
  | 'none'
  /** A long-lived key, sent verbatim on every request. */
  | { kind: 'apiKey'; apiKey: string }
  /**
   * A tenant enrollment token (`octic_et_…`), exchanged for short-lived ingest
   * JWTs for as long as the process runs. `tokenUrl` is be-api's
   * `/v1/ingest/token`, *not* the OTLP endpoint.
   */
  | { kind: 'enrollmentToken'; enrollmentToken: string; tokenUrl: string };

/**
 * What `setup()` acts on. `missing` is the fourth case and the one the types
 * say cannot happen: `apiKey: process.env.OCTIC_API_KEY!` type-checks and is
 * `undefined` at runtime in a container whose secret was not mounted. That is
 * a real deployment, not a programming error, and it resolves here rather than
 * throwing — the transport is switched off and the spool takes custody.
 */
export type ResolvedAuth =
  | { mode: 'none' }
  | { mode: 'apiKey'; apiKey: string }
  | { mode: 'enrollmentToken'; enrollmentToken: string; tokenUrl: string }
  | { mode: 'missing'; reason: string };

/** Absent, empty, or whitespace — all the same nothing. */
const usable = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

export const resolveAuth = (options?: AuthOptions): ResolvedAuth => {
  if (options === undefined) return { mode: 'missing', reason: 'no `auth` was configured' };
  if (options === 'none') return { mode: 'none' };

  switch (options.kind) {
    case 'apiKey':
      return usable(options.apiKey)
        ? { mode: 'apiKey', apiKey: options.apiKey }
        : { mode: 'missing', reason: '`auth.apiKey` is empty' };

    case 'enrollmentToken':
      if (!usable(options.enrollmentToken)) {
        return { mode: 'missing', reason: '`auth.enrollmentToken` is empty' };
      }
      if (!usable(options.tokenUrl)) {
        return { mode: 'missing', reason: '`auth.tokenUrl` is empty' };
      }
      return {
        mode: 'enrollmentToken',
        enrollmentToken: options.enrollmentToken,
        tokenUrl: options.tokenUrl,
      };

    /**
     * Unreachable by the types, reachable from JavaScript. A caller who passes
     * `auth: { kind: 'oauth' }` gets the spool, not a crash.
     */
    default:
      return { mode: 'missing', reason: '`auth.kind` is not one of "apiKey" or "enrollmentToken"' };
  }
};
