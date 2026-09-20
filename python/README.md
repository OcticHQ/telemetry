# `octic-telemetry`

Agent telemetry for [Octic](https://octic.ai) — OpenTelemetry spans, stamped
with the Octic attribute contract.

> **Not published yet.** This package is under construction; the first release
> writes telemetry to a local spool directory and does not talk to any Octic
> service. The full README lands with that release.

## What it does

Your application already knows things no instrumentation can work out for
itself: that five model calls were one agent doing one job, which prompt
template produced a completion, which end user a conversation belongs to. This
package carries that knowledge on the OpenTelemetry context and stamps it onto
every span your process produces — including spans from instrumentation that has
never heard of Octic.

It ships no instrumentation of its own. Register whichever OpenTelemetry
instrumentation you already use; this enriches what it emits.

## Status

| | |
|---|---|
| Python | 3.10+ |
| Runtime dependencies | `opentelemetry-api`, `opentelemetry-sdk` |
| Signals | traces |

## Licence

Apache-2.0. See
[LICENSE](https://github.com/octichq/octic-telemetry/blob/main/LICENSE).
