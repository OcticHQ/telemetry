# 0006 — Ship the Python SDK spool-only, with no transport

- **Status**: accepted
- **Date**: 2026-09-22
- **Deciders**: platform maintainers

## Context and problem

The Node SDK delivers telemetry over OTLP/HTTP: it exchanges an enrollment token
for a short-lived credential, renews it at half its life, retries on 401, and
falls back to a spool directory when delivery fails. That is most of the
package by volume, and roughly half of it exists to hold a credential safely.

The obvious answer for a second SDK is to port that. The constraint that makes
it wrong is that the first Python consumer **never talks to ingest**. It reads
the spool and nothing else — the spool is not its fallback, it is its delivery
mechanism. Porting the transport would mean building, testing and supporting an
HTTP client, a token manager and a retrying exporter that the only known
consumer would never execute, and holding a credential in a process that has no
use for one.

There is a second constraint pointing the same way. `contract/SPOOL.md` already
specifies the on-disk format precisely and names a reader process as the other
side of that contract. The reader exists and is owned elsewhere. So the delivery
problem is already solved for this consumer, by something that is not this
package.

## Decision

**The first Python release writes to a spool directory and makes no network
call.** No HTTP exporter, no enrollment token, no credential, no refresh.
`SPOOL.md` v1 conformance is the acceptance criterion.

`endpoint` **defaults** to Octic's ingest and is not contacted. `SPOOL.md` v1
requires the field and hashes it into the manifest id, so it must have a value —
but requiring a consumer to supply one asks them to make a decision they have no
information for, about a value nothing in their process reads. It stays a
parameter, so a consumer delivering somewhere else can say so, and the signature
is stable when a transport arrives.

The spooling exporter is a plain `SpanExporter`, so an auth-retrying HTTP
exporter can later be inserted in front of it without the spool changing.

### Consequent packaging choices

These follow from the above rather than deserving their own record:

- **PyPI, `octic-telemetry`, module `octic_telemetry`,** published by a trusted
  publisher (OIDC, no long-lived token). Per-SDK versioning and the
  `python/vX.Y.Z` tag come from [ADR 0002](0002-per-sdk-versioning.md).
- **Python 3.10 floor**, tested on the floor and on a current release, because a
  floor nothing runs is how a package comes to claim a version it has never
  seen.
- **`opentelemetry-api` and `opentelemetry-sdk` are the whole runtime dependency
  set.** A package with no transport needs no HTTP client; if one is ever
  needed, the standard library has one, and a pooled keep-alive connection is a
  live handle in a package that promises to hold none.
- **Traces only.** `SPOOL.md` already names `logs` segments, so the seam is
  there.

### Where the documentation lives

There are two per-language documents, because they have different readers.
`docs/python-consumer-guide.md` is what a consumer is sent: install, initialise,
annotate, and nothing they did not ask for. `docs/python-guide.md` is the
complete one — every option, the failure modes, running under a host SDK. Both
sit beside the language-neutral documents rather than inside `python/`. `AGENTS.md` scopes
`docs/` to language-neutral prose, so this is a deliberate exception: `docs/` is
where a reader is sent, and the alternative — a second long document inside
`python/` — competes with `python/README.md`, which is the registry page and has
to stay short. The language-neutral documents stay language-neutral; a
`docs/node-guide.md` is the expected successor.

## Consequences

- **Positive**: the package that ships is the package the consumer runs. No
  credential exists in a Python process, so none can leak from one. The largest
  and riskiest body of Node's work is not translated, and the spool — which
  would otherwise be the expensive optional half — is the point of the package
  and gets the attention.
- **Negative**: **the SDK alone does not deliver telemetry.** A consumer must
  run the reader, and until they do, their data is on local disk and nowhere
  else. This is the cost, it is not obvious from the package name, and every
  piece of user-facing documentation has to say it plainly. A second consumer
  who wants direct delivery is blocked until the transport is written.
- **Neutral**: content capture defaults to `none` here and to `full` in Node.
  The SDKs disagree deliberately: content written by a spool-only SDK sits at
  rest on the consumer's disk, which is a property Node has only on its failure
  path and this one has always. The cost is that the two SDKs behave differently
  out of the box, so neither README can state the default on the other's
  behalf.
- **Neutral**: the two SDKs have genuinely different surfaces, so
  language-neutral prose has to stop claiming both do the same thing. `docs/`
  now names which SDK it means where they differ.

## Alternatives considered

- **Port the transport too, and treat the spool as a fallback as Node does.**
  Would have given one architecture across both languages and a Python SDK that
  works for a consumer who wants direct delivery. Rejected because no such
  consumer exists yet: it is a large, credential-handling body of code written
  speculatively, and the shape it should take is best decided by the consumer
  that needs it.
- **Drop `endpoint` entirely, since nothing contacts it.** The smallest surface,
  and the one a consumer reading the signature would expect. Rejected because
  `SPOOL.md` v1 makes it a manifest field and part of the manifest id hash, so
  removing it would either break the format or hardcode one ingest host into the
  package — and a consumer whose data goes somewhere else would then have no way
  to say so. Defaulting it costs nothing and keeps that door open.
- **Ship the reader in this package.** Would make one install sufficient.
  Rejected because the reader is a separate long-lived process with different
  operational properties, it is owned elsewhere, and `SPOOL.md` exists precisely
  so the two sides can ship independently.
