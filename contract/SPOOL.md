# The spool format, version 1

`spoolFormatVersion: 1` · produced by `octic-telemetry/src/spool.ts`

When the SDK cannot deliver — no credential, a token exchange that is failing,
ingest refusing connections or answering 5xx after the exporter's own retries —
it writes each undeliverable export batch to a directory instead of dropping it.
A **separate reader process** delivers those files. This document is the contract
between the two. It is deliberately dull: the file *is* the HTTP body, and the
reader's job is to POST it.

## Layout

```
<dir>/manifest-<id>.json                              how to deliver; written once per configuration
<dir>/traces-<epochMs>-<seq>-<writer>-<id>.otlp.json  one export batch
<dir>/logs-<epochMs>-<seq>-<writer>-<id>.otlp.json    one export batch
<dir>/<anything>.otlp.json.tmp                        a write in progress
```

| field | meaning |
|---|---|
| `traces` / `logs` | the OTLP signal, which selects the path from the manifest |
| `<epochMs>` | when the batch was written. Ordering hint only — mtime is authoritative |
| `<seq>` | per-writer counter, zero-padded, so one millisecond can hold many batches |
| `<writer>` | opaque per-instance id. Not a pid: worker threads share those |
| `<id>` | the manifest this batch belongs to |

Everything but the leading signal and the `.otlp.json` suffix is opaque. A reader
that parses the middle is a reader that breaks on version 2.

## The segment

The bytes are exactly what the SDK's OTLP/HTTP exporter would have sent: a single
OTLP/JSON `ExportTraceServiceRequest` or `ExportLogsServiceRequest`
(`{"resourceSpans":[…]}` / `{"resourceLogs":[…]}`), unframed, uncompressed, no
trailing newline, no header block, no envelope of ours.

Deliver it by POSTing the file verbatim to
`<manifest.endpoint><manifest.signalPaths[signal]>` with
`content-type: <manifest.contentType>` and whatever credential the reader holds.

The content policy has already been applied. A segment contains only what the
process was configured to let out — `manifest.contentCapture` says which level
that was, so an operator can tell whether a directory holds customer prompts
without opening a file. Nothing re-redacts on the way out, and nothing needs to.

One export batch per file. Under the SDK's current `SimpleSpanProcessor` that is
one span per file; with a `BatchSpanProcessor` in front it is a batch. The format
does not change either way.

## The manifest

```json
{
  "spoolFormatVersion": 1,
  "endpoint": "https://ingest.octic.ai",
  "signalPaths": { "traces": "/v1/traces", "logs": "/v1/logs" },
  "contentType": "application/json",
  "contentEncoding": "identity",
  "serviceName": "svc-otel",
  "octicSchemaVersion": "1",
  "sdkName": "octic-node",
  "sdkVersion": "0.0.0",
  "contentCapture": "full",
  "createdAt": "2026-08-16T12:00:00.000Z"
}
```

`<id>` is a hash of everything above except `createdAt`, so two processes with
the same configuration share one manifest and two with different endpoints keep
their segments apart in a shared directory. Written once, with `O_EXCL`; an
existing file is left alone.

**It never contains a credential.** Not a token, not a header, not an API key.
The reader brings its own, and a manifest that grows one is a bug.

A reader that finds a `spoolFormatVersion` it does not know must leave those
segments alone rather than guess.

## Rules for the reader

1. **Glob `*.otlp.json` only.** A `.tmp` is a write in progress. The final name
   appears by `rename(2)` after every byte is on disk, so a file you can see is a
   file that is complete.
2. **Deliver oldest first**, by mtime. Ordering is a courtesy, not a guarantee —
   OTLP has no ordering requirement and neither does this.
3. **Unlink after a 2xx.** Not before.
4. **`ENOENT` is success, not an error.** The SDK evicts the oldest segments when
   the directory hits its bounds, including one you are mid-way through
   delivering. An open descriptor stays valid after `unlink`, so finish the POST
   and move on.
5. **A permanent rejection is not a retry loop.** The SDK already declines to
   spool bodies ingest refuses on their merits (400, 413, 415, …), so a segment
   that gets one has usually gone stale rather than malformed — 401 after a
   credential rotation, for instance. Give up on a file rather than posting it
   forever; log it, move it aside, or delete it.
6. **Never write into the directory except to delete.** The SDK owns the naming,
   the accounting and the bounds.
7. **The directory is 0700 and the files 0600, owned by the user the SDK ran as.**
   A reader running as someone else needs that arranged deliberately — do not
   loosen the modes to make it work.
8. **Reading a segment is reading customer prompts** at `capture: 'full'`. It is
   a production data-access path and deserves the same authorization and audit
   the span store gets.

## Bounds the writer enforces

Defaults: 64 MiB, 10,000 segments, 72 hours. On overflow the oldest segments are
deleted (`onOverflow: 'evict-oldest'`) or the new batch is refused
(`'drop-new'`); segments older than the age limit go on the next scan whether
they were delivered or not. A spool that grows without limit is an outage in the
consumer's application, which is the one thing this may never cause.

If the directory turns unwritable — permissions, full disk, read-only mount — the
SDK warns once, stops spooling, and retries the directory a minute later. It does
not throw, and it does not keep the batches in memory waiting.
