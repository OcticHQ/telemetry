# 001 — Batch processors and flush

Status: accepted

The third of the pull requests taking the Node SDK to `0.1.0`, after landing the
code and after non-interference. It is criterion 3 of the release gate:
*batching works, and the SDK holds no lifecycle*.

## Why

`SimpleSpanProcessor` is one HTTP round trip per span. Measured against the
proof of concept, 51 spans produced 51 queue entries of about 2.2 KB each,
because every export re-sends the whole resource block. The comment in the code
gave the reason as "batching lets a process exit unflushed", which is a
test-harness problem in production clothing — the answer to it is an explicit
flush, and this package already has one.

The reason this is its own pull request rather than part of the previous one is
that the review question is different. Non-interference asks *can this throw
into the host application*; this asks *is delivery timing still correct*. A
reviewer asked both at once answers neither well.

It has to come after non-interference, and not for file-conflict reasons: a
batch processor tracks in-flight exports by counting `resultCallback`
invocations and stalls permanently on a callback that never fires. Landing
batching before the exactly-once guard turns a dropped batch into a wedged
queue.

## What changes

**The processors.** `SimpleSpanProcessor` → `BatchSpanProcessor`,
`SimpleLogRecordProcessor` → `BatchLogRecordProcessor`, both inside the existing
`Safe*Processor` guards. The guard matters more here than it did before: a batch
processor's `forceFlush` and `shutdown` *reject* when a batch fails, and both
are reachable from a consumer's own shutdown path.

**The four knobs, always all four.** `maxQueueSize`, `maxExportBatchSize`,
`scheduledDelayMillis` and `exportTimeoutMillis` are exposed as
`init({ batch })` and resolved to explicit values before construction, never
left undefined. That last part is the decision worth recording: the
`BatchSpanProcessor` re-exported by `@opentelemetry/sdk-trace-base` fills any
undefined field from `OTEL_BSP_*`, and `BatchLogRecordProcessor` has no
equivalent. Honouring the variables would tune traces and silently leave logs
alone under the same environment. One `OTEL_BSP_SCHEDULE_DELAY` producing two
different delays is worse than not reading it at all.

Consequence: the span processor is imported from `@opentelemetry/sdk-trace`
rather than `@opentelemetry/sdk-trace-base`, because the latter's export is the
environment-reading shim and its config type does not carry
`selfObsMeterProvider`. Same package, same version, now declared directly.

**Queue overflow is counted.** A bounded queue drops, and a silent drop is the
failure mode this SDK exists to remove. The processors report drops to a meter
and to nothing else — there is no getter, and the private counter is reset every
time the warning is emitted — so `self-metrics.ts` supplies a `MeterProvider`
that forwards `error.type: 'queue_full'` into a new `queueDropped` counter. It
is a sink, not a metrics pipeline: nothing aggregates, nothing is exported, no
new dependency. `queueDropped` is separate from `spansDropped` because the two
say different things — one is a span this SDK could not handle, the other is a
pipeline that cannot keep up with the application.

**No lifecycle, and it is asserted.** No `beforeExit`, no `exit`, no signal
handlers, and no `flushOnExit` option — not even one defaulting to off. The
application calls `shutdown()` from its own graceful-shutdown path; what is lost
without that call is at most `scheduledDelayMillis` worth of queued spans, and
the README will say so. One test reads `process.getActiveResourcesInfo()` and
the listener counts for `beforeExit`, `exit`, `SIGTERM` and `SIGINT` before
`init()` and again after the first span, and requires them unchanged. That
single case covers the absence of exit hooks, the absence of signal handlers,
and a batch timer that does not hold the event loop, which is why it is worth
writing carefully rather than splitting into three.

The one documented exception is the spool, which installs a `process.on('exit')`
drain when it is enabled so the last batch reaches disk during an exit nobody
asked for. The lifecycle test runs credentialed, which leaves the spool off.

**The silence warning.** One `diag.warn`, once, when spans have been produced
for 30 seconds and none has been exported. It carries a rule the rest of the
observability work does not: the signal fires on *silence*, never merely on
error. Every failure here already logs; what none of them covers is a provider
registered too late, a host SDK that reached `setGlobalTracerProvider` first, or
a missing loader hook — all of which exit 0 having emitted nothing. It is a log
line rather than an API because the wording, the delay and the conditions should
stay free to change.

Its timer is `unref()`'d, cleared on the first successful export and cleared on
`shutdown()`. It is armed from `IdentitySpanProcessor.onStart` — the one hook
that runs per span in both entry modes — and disarmed from `SafeSpanExporter`'s
success path, so `spool: { mode: 'only' }` counts as working rather than silent.
First span only: re-arming per span would push the deadline out forever in
exactly the process worth warning about.

**Shutdown is idempotent.** The layers below already latch individually, so a
second call was never destructive — it was slow and misleading, because the
second caller awaits a fresh pass over an empty pipeline and any warning it
produces describes the wrong call. A consumer with both a `SIGTERM` handler and
a `finally` block has two callers and both are correct.

## Order

1. `self-metrics.ts`, `silence-watch.ts`, `batching.ts` — new, no callers yet.
2. `counters.ts` gains `queueDropped`; `processor.ts` and `safe-exporter.ts`
   gain the two silence-watch edges.
3. `init.ts` — the `batch` option, both processor swaps, the shutdown latch.
4. Tests, then the drift list, then `handbook/TODO.md`.

## Verification

`make check`. Beyond it, two things that a green suite would otherwise hide:

- The drift gate was exercised live rather than trusted — planting
  `gen_ai.input.messages` in the newly listed `self-metrics.ts` produces
  `drift: node/src/self-metrics.ts: restates …` and exit 1, and exit 0 again
  once reverted.
- The lifecycle assertion was checked for vacuity: a `setTimeout` that is not
  `unref()`'d does change `process.getActiveResourcesInfo()`, so the test can
  fail.

## Amendments

None yet.
