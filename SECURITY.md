# Security

## Reporting a vulnerability

Report privately through
[GitHub Security Advisories](https://github.com/OcticHQ/telemetry/security/advisories/new).
Do not open a public issue.

We aim to acknowledge within two working days.

## What is in scope

This package runs inside a customer's process and handles their prompts, their
model output and their credentials. The things we most want to hear about:

- **Content leaking past the policy.** `content.capture: 'none'` must mean
  nothing — no prompt, no completion, no tool argument — leaves the process. A
  path that carries content past it, on either the trace or the log signal, is
  the highest-severity report we can receive.
- **A credential on the wire.** The API key belongs in one place, the
  `authorization` header. Anything that puts it on a span, in a resource
  attribute, or in a log record is a vulnerability.
- **Resource attributes nobody asked for.** Detectors ship things like
  `process.command_args`, which is the full argv and a well-known place for
  secrets. The exporter drops a denylist of these; a gap in it is in scope.
- **Anything that lets a caller forge a governance attribute.** The `octic.`
  namespace is reserved, and customer-supplied keys are forced under
  `octic.custom.` precisely so a tenant value cannot overwrite `octic.run.id`.

## What is not in scope

- The content policy's **default**. It currently ships `capture: 'full'`, which
  is a deliberate early-stage choice, documented, and one option away from
  `none`. Tell us if you disagree — but as a design discussion, not a report.
- Denial of service against your own process by configuring an endpoint that
  does not answer. A dead endpoint must never take an application down; if you
  find one that does, that *is* a bug, and an ordinary issue is the right
  place.

## Supported versions

Pre-1.0. Only the latest published version of each SDK receives fixes.
