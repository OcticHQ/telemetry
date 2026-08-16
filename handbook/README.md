# handbook/

Internal documentation for `octic-telemetry` — for contributors building the
SDKs, not for the developers who install them. Consumers read each SDK's
`README.md`, `contract/ATTRIBUTES.md` and `docs/`; those are the published
contract.

## What lives where

| folder | contents | rules |
|---|---|---|
| [`adr/`](adr/) | Architectural Decision Records, MADR-style, numbered `0001`, `0002`, … | append-only; new decisions supersede old ones |
| [`plans/`](plans/) | Implementation specs (`001-…`, `002-…`); written before work begins | edited during scoping, marked `Status: accepted` once execution starts |
| [`TODO.md`](TODO.md) | Cross-cutting follow-ups that don't deserve their own plan yet | living document |

## The golden rule

> Decisions go in `adr/`. In-flight work goes in `plans/`. Loose ends go in
> `TODO.md`.

Same rule as every other Octic repo. If you find yourself writing prose
anywhere else — a long comment in a source file, a thread you would link to —
it probably belongs in one of these three places.

## One rule specific to this repo

**This repository is public, and what it publishes cannot be recalled.** An npm
version is immutable and unpublishable after 72 hours; an attribute name, once
customers have written queries against it, is an API. So the bar for "write an
ADR" is lower here than in the backend repos: if a choice would be expensive to
reverse *for someone who does not work here*, it gets an ADR even when the code
expressing it is twenty lines.

Note also that these documents are **visible to anyone**. That is fine — they
are decision records, not secrets — but write them for a reader outside the
company, and keep customer names and unannounced plans out of them.
