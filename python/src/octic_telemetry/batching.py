"""How much telemetry is held, for how long, before it is written.

What this SDK does **not** do, and will not: register an ``atexit`` hook or a
signal handler. A library installing either silently changes its host's shutdown
semantics, and OpenTelemetry's own ``TracerProvider`` registers ``atexit`` by
default for exactly that reason to be wrong — ``init()`` passes
``shutdown_on_exit=False``. The contract is the other way round: the application
calls ``shutdown()`` from its own graceful-shutdown path, and what is lost without
that call is at most ``schedule_delay_millis`` worth of queued spans.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class BatchOptions:
    """The four knobs, with the meanings OpenTelemetry gives them.

    Every field is always passed to the processor, which has a consequence worth
    knowing: ``BatchSpanProcessor`` fills any argument left as ``None`` from the
    ``OTEL_BSP_*`` environment variables. Passing all four takes that fallback
    out of play, so ``init(batch=...)`` is the one place these are set and it is
    visible in the caller's own source. The values are OpenTelemetry's defaults.
    """

    #: Spans held before new ones are dropped.
    max_queue_size: int = 2048
    #: Most spans in one export — one spool segment. Must be <= ``max_queue_size``.
    max_export_batch_size: int = 512
    #: How long a partial batch waits for company.
    schedule_delay_millis: float = 5000
    #: Ceiling on one export attempt.
    export_timeout_millis: float = 30000
