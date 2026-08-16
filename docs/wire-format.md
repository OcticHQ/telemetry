# Wire format

What the SDKs send, where, and how it is authenticated. Language-neutral —
useful if you are porting the SDK, debugging an integration, or sending OTLP
without an SDK at all.

## Transport

**OTLP over HTTP.** Two endpoints, derived from the configured base:

```
POST <endpoint>/v1/traces
POST <endpoint>/v1/logs
```

The logs endpoint is not optional. Some instrumentation emits every piece of
content as log records rather than span attributes, so an SDK that wired only
traces would silently carry no content for those users.

### Encoding

The SDKs send **OTLP/JSON**, pinned deliberately rather than by accident. Note
that OTLP over HTTP defaults to **protobuf** in most stock exporters, so if you
are sending without one of our SDKs, that is probably what you are sending.

Both are accepted. `Content-Encoding: gzip` is accepted on either.

## Authentication

A bearer token on every request:

```
authorization: Bearer <token>
```

The token is short-lived and obtained by exchanging a tenant enrollment token:

```
POST <api>/v1/ingest/token
{ "enrollmentToken": "octic_et_…" }
→ { "accessToken": "eyJ…", "expiresIn": 900 }
```

The result is an EdDSA JWT carrying the tenant. Ingest verifies it statelessly
against a published JWKS — there is no revocation lookback, so a revoked token
stops working within one token lifetime rather than immediately.

**Because the token expires, an integration needs something that renews it.**
That is one of the reasons the SDK exists rather than a documented curl
snippet: a static credential pasted into an exporter config would stop working
mid-run.

For consumers who cannot run an SDK, a long-lived key branch is planned; until
it exists, that path is not supported.

## What ingest does with it

Ingest is a **transport boundary**, not a parser. It authenticates the request,
checks framing, and queues the body verbatim for downstream processing. It
stores nothing and offers no read-back.

Two consequences:

- A malformed body is not rejected at the edge on every path. JSON framing is
  checked; protobuf bodies are queued unvalidated, so the first place a
  malformed protobuf export is noticed is downstream.
- Nothing is echoed back to you. A `200` means "accepted and queued", not
  "parsed and understood".

## Two clocks

Every payload carries two timestamps, and confusing them is the most common
mistake when reading this data:

- **`occurredAt`** — asserted by the client. Never range-checked, never
  corrected. A sensor with a wrong clock produces wrong values here, and that
  is deliberate: silently rewriting a customer's timestamps destroys the only
  evidence that their clock is wrong.
- **`receivedAt`** — stamped by ingest. Authoritative for ordering and
  retention.

## Sending without an SDK

Supported, and deliberately so — a customer already running OpenTelemetry can
point an exporter at the endpoint and get the commodity half of the data:
model, tokens, latency, and whatever their instrumentation emits.

What they will not get is the layer above interception: no run grouping, no
conversation, no prompt version, no asset references. Those attributes must be
set by something that knows them, and if you are setting them by hand, the
[attribute contract](../contract/ATTRIBUTES.md) is the list.

Two caveats for this path:

- The bearer token expires. See above.
- Resource detectors ship attributes you may not intend to send —
  `process.command_args` is the full argv. The SDKs drop a denylist of these
  before export; without an SDK, nothing does.

## The attribute names

All of them, with types and ownership, are in
[`contract/ATTRIBUTES.md`](../contract/ATTRIBUTES.md). Three populations:
attributes our SDKs **emit** (frozen — renaming one is a major version),
attributes we **consume** from foreign instrumentation (the reader is frozen,
not the writer), and attributes we **deny**.
