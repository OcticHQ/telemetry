# 0007 — Ship the Node SDK as `@octichq/airlock-sdk`, spool-only by default

- **Status**: accepted
- **Date**: 2026-10-26
- **Deciders**: platform maintainers

## Context and problem

The Node SDK was written to deliver telemetry over OTLP/HTTP: it holds a
credential, renews it, and falls back to a spool directory when delivery fails.
The Python SDK was ported from it for a consumer that never talks to ingest and
reads only the spool, and so ships spool-only
([ADR 0006](0006-python-ships-spool-only.md)).

The Node SDK now has the same first consumer as the Python one. Out of the box it
would do the wrong thing there in four ways: it requires an `endpoint` nothing
reads, it warns about a missing credential that is not missing but unneeded, it
captures content in `full` and writes it to that consumer's disk, and it writes
`logs-*` segments the consumer's reader deletes unread.

The obvious answer is a second, spool-only Node package. The constraint that
makes it wrong is that the parts both would share — the processor, the
annotations, the content policy and the spool writer — are most of the code,
and are what the contract's drift check guards. A second copy is a third
implementation of the same contract to keep in step.

## Decision

**The existing Node SDK takes the Python SDK's defaults, and is renamed to match
it.**

- **Package `@octichq/airlock-sdk`**, replacing `@octichq/telemetry`, which was
  never published to public npm. The registry and the scope chosen in
  [ADR 0004](0004-public-npm-and-the-octic-scope.md) stand; only the name
  changes.
- **`octic.sdk.name` is `octichq-airlock-sdk-node`**, replacing `octic-node`, and
  is the tracer scope name as before.
- **The defaults:** `spool.mode` is `'only'`, `auth` is `'none'`, `endpoint` is
  optional and defaults to Octic's ingest, recorded in the manifest and not
  contacted, and `content.capture` is `'none'`.
- **The logs signal is wired only when the HTTP transport is.** A spool-only
  process writes traces and nothing else, as the Python SDK does.
- **The transport stays.** `spool: { mode: 'fallback' }` plus a credential gives
  back the OTLP/HTTP delivery, token renewal and logs exactly as before. A
  credential passed under `'only'` is unused, and the SDK warns once saying so.

## Consequences

- **Positive**: one Node implementation of the contract, and the two SDKs now
  behave the same out of the box — same output, same content default, same
  signals. A consumer moving between them changes syntax, not expectations.
- **Negative**: the package carries code the default path never runs — the
  OTLP/HTTP exporters, the token manager and the logs SDK are installed and
  imported regardless. In a deployment that treats every installed package as
  attack surface, that is surface bought for a transport it does not use.
- **Negative**: a consumer who wants direct delivery has to know to ask for it.
  `mode: 'fallback'` is the switch, and nothing about the package name says it
  exists.
- **Neutral**: the content default the two SDKs disagreed on
  ([ADR 0006](0006-python-ships-spool-only.md)) is now `none` in both.

## Alternatives considered

- **A separate spool-only Node package beside this one.** Would drop the
  transport's dependencies from the default install. Rejected because it
  restates the shared core a second time in the same language; if the dependency
  surface becomes the problem, splitting the transport into its own package is
  the cheaper fix, and still leaves one core.
- **Keep the name and the defaults, and document the spool-only configuration.**
  The smallest change. Rejected because the default is what a consumer gets when
  they forget, and forgetting here means prompts on disk and a warning about a
  credential that was never wanted.
- **Keep `octic-node` as the SDK name.** No contract change. Rejected because the
  value is what a reader sees as the scope of every span, and it would name a
  package that no longer exists.
