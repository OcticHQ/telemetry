# 002 — Token refresh

Status: accepted

The fourth of the pull requests taking the Node SDK to its first stable release,
after landing the code, non-interference and batching. It is criterion 4 of the
release gate: *credentials refresh*.

## Why

`docs/wire-format.md` has always said that the ingest token expires and that
"an integration needs something that renews it — that is one of the reasons the
SDK exists". The SDK did not renew anything. `init()` built
`{ authorization: 'Bearer ' + apiKey }` once and handed the frozen object to
both OTLP exporter constructors.

Against the real backend that is a scheduled failure. be-api mints the ingest
JWT with `JWT_ACCESS_TTL_SECONDS`, 900 by default, and be-ingest collapses every
verification failure — expiry included — into one 401. 401 is not in
`PERMANENT_STATUSES`, so the batches would have started spooling fifteen minutes
into every long-running process and never recovered: disk filling with telemetry
that a valid token would have delivered, and no error anywhere that says why.

## What the exporter gave us

The design rests on two properties of the pinned
`@opentelemetry/otlp-exporter-base@0.221.0`, both verified against the installed
package rather than taken from the changelog:

- `headers` accepts a factory, not only an object, and the Node transport
  `await`s it **before every send** (`http-exporter-transport.js:17`). A token
  minted after `init()` returned therefore reaches an exporter configured before
  it existed. The factory's documented contract is that it MUST NOT throw.
- On a non-retryable non-2xx the transport produces
  `new OTLPExporterError(statusMessage, statusCode, body)`
  (`http-transport-utils.js:75`), so the HTTP status arrives at the
  `SpanExporter` boundary as a **number** on `error.code` — the same field
  `isSpoolable()` already read. 401 is absent from the exporter's own retryable
  set, so it takes exactly this path with no internal retry to race.

## What was built

**`auth.ts`** — `AuthOptions` widens from `'apiKey' | 'none'` to a discriminated
union of `'none'`, `{ kind: 'apiKey', apiKey }` and
`{ kind: 'enrollmentToken', enrollmentToken, tokenUrl }`, and the top-level
`apiKey` option is gone. `tokenUrl` is required inside its member rather than
optional: the token endpoint is be-api and the OTLP endpoint is be-ingest, so
there is nothing to derive it from, and a `tokenUrl` defaulted off `endpoint`
would POST the enrollment token at a service with no such route — surfacing as
spooled telemetry rather than as the configuration error it is. Making it a
member of the union is what lets the compiler ask for it.

`resolveAuth()` keeps a runtime empty check the types say is unnecessary.
`apiKey: process.env.OCTIC_API_KEY!` type-checks and is `undefined` in a
container whose secret was not mounted; that resolves to `missing`, which
switches the transport off and gives the spool custody exactly as before.

**`token-manager.ts`** — one exchange in flight at a time, shared by both
signals; refresh at half the token's life with a 30-second floor; exponential
backoff from that floor on failure, capped at five minutes and again at half the
lifetime of the token being held. It never rejects: a failed exchange resolves
with the last-known token, or with no `authorization` header at all, and the
resulting 401 flows through the failure path that already exists.

Three details are load-bearing rather than incidental:

- **The exchange is `node:http`, not `fetch`.** undici keeps a pooled connection
  alive after the response, and a keep-alive socket is a live handle in a
  package that promises to own none. `agent: false` plus an `unref()`'d socket
  means an exchange in flight — or a token endpoint that never answers — can
  never be the reason a process fails to exit.
- **The expiry skew is proportional as well as absolute.** A flat five seconds
  against a two-second token means every export finds the cache spent and mints
  again; the skew is `min(5s, 10% of the lifetime)`.
- **`invalidate()` discards rather than degrades.** A token ingest has just
  refused is not something to fall back to. The stale-token fallback is for the
  other case — a refresh that failed for reasons of ours.

**`auth-retrying-exporter.ts`** — the 401 retry, as a `SpanExporter` /
`LogRecordExporter` wrapper, because a headers factory runs before a send and
never sees the response. It sits `Safe → Redacting → Spooling → AuthRetrying →
OTLP`: inside the spool, so a 401 the retry fixes never touches disk, and above
nothing, so a 401 that survives still spools. One retry per export call, never a
loop, and only in enrollment-token mode — re-sending a static key that was just
refused produces a second 401 and nothing else.

## The test that matters most

`auth.integration.test.ts` asserts that the error handed to a wrapper on a 401
carries a **numeric** `error.code === 401`, against the real pinned exporter.
Everything else in that file would keep passing off the proactive refresh if a
future exporter version moved Node onto the fetch transport, where the status is
prose inside a message string rather than a field — the retry would silently
never fire again. The canary is the assertion that fails when that happens.

## Deliberately not built

`auth: { kind: 'custom', getToken }` — the variant most likely to be shaped
wrongly before anyone has asked for it. Unverified JWT decoding after a second
401 to name an `iss`/`aud` mismatch: the generic warning names both configured
URLs, which narrows the common case, and deciding what is safe to print from a
credential deserves a real support ticket. An RFC 6749 client-credentials flow:
be-api takes custom JSON, which is also why a stock collector cannot
authenticate to ingest.

Spool-on-no-credential stays exactly as it was. A token manager reduces how
often it fires; it does not replace it.
