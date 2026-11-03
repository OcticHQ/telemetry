# 0008 — Agent receipts ride the spool, outside the batch queue and the content policy

- **Status**: accepted
- **Date**: 2026-11-03
- **Deciders**: platform maintainers

## Context and problem

Some callers of the SDK run an agent inside an enclave that must not see the
data the agent processes, yet needs evidence of what the agent did with it: it
fetched, it verified, it returned. The agent is the only party that knows. It
can say so, and a reader of the spool can record that it said so.

Spans are the wrong carrier. They go through a bounded batch queue that drops
under pressure, which is right for telemetry and wrong for evidence. They pass
through the content policy, which redacts or drops values by key, so what
arrives depends on configuration and on the heuristics. And they are free-form:
a span attribute is whatever the caller put there.

## Decision

**A receipt is a separate call and a separate file.** `record_receipt` (Python)
and `recordReceipt` (Node) take a type and a set of attributes, check them
against the vocabulary in `contract/receipts.yaml`, and write one
`receipt-*.json` file to the spool directory inside the call: fsynced, renamed
from `.tmp`, at most 4096 bytes, at most 256 per process. The format is in
[`contract/SPOOL.md`](../../contract/SPOOL.md).

- **No batch queue.** A full queue cannot drop a receipt, because a receipt
  never enters it. The file exists when the call returns.
- **No content policy.** The policy classifies keys and scans values for
  patterns, which suits open-ended telemetry. A receipt has no open end, so the
  vocabulary check replaces the policy rather than sitting under it.
- **No free text.** Every value must match a named shape: a hostname, a byte
  count, a digest, a short lowercase code, a three-digit purpose. No shape
  admits a consent id, a customer identifier, a date range or a sentence, so a
  receipt cannot carry the data it describes however the caller fills it in.
  This is the property that lets a reader treat receipts as safe to store. A
  field that took free text would need the policy back, and the policy is a
  heuristic.
- **The spool's own rules are untouched.** Bounds, eviction and the age sweep
  match `*.otlp.json`, so none of them sees a receipt. A reader that follows
  SPOOL.md's rules, which glob `*.otlp.json`, ignores receipts and loses
  nothing.
- **The vocabulary is versioned on its own.** `vocabulary_version` is an
  integer in `receipts.yaml`, as `schema_version` is for attributes. A consumer
  pins `contract/receipts.json` byte for byte.

## Consequences

- **Positive**: receipts are durable where spans are best-effort, and safe to
  store because their values cannot hold data.
- **Negative**: an agent cannot explain itself. A refusal is a code from a
  small set, not a message. A new kind of fact needs a new type or attribute,
  released through this repository, before any agent can report it.
- **Negative**: a reader written before receipts existed may treat the files as
  unrecognised and delete them. Only a reader that follows SPOOL.md exactly is
  safe.
- **Neutral**: both SDKs write receipts whenever they resolve a safe spool
  directory, whether or not the span exporter is enabled.

## Alternatives considered

- **Spans with a reserved attribute prefix.** Reuses the pipeline. Rejected
  because the queue can drop them and the content policy can alter them, and
  because span attributes cannot be constrained to shapes.
- **A separate transport.** Rejected: the spool directory is already the
  agreed boundary, and a second channel is a second thing to secure.
- **Free-text fields behind the content policy.** Rejected: evidence that
  depends on a heuristic holding is not evidence that the data stayed out.
