"""The outermost link of the exporter chain, and the only place that knows it is one.

Node's version exists mostly to make ``resultCallback`` fire exactly once. Python's
``export()`` returns its result, so that half has no counterpart; what is left is
the other half — a raise becomes a ``FAILURE`` — plus the counters, because this
is the one point every batch passes through exactly once however the chain
underneath is arranged.

A raise matters more here than it looks. ``BatchSpanProcessor`` catches exporter
exceptions itself, but ``force_flush()`` and ``shutdown()`` export on the
*caller's* thread, which under ``init()`` is the customer's shutdown path, and a
host SDK arranging its own processors may catch nothing at all.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence

from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult

from . import silence_watch
from .counters import count

log = logging.getLogger("octichq_airlock_sdk")


class SafeSpanExporter(SpanExporter):
    def __init__(self, inner: SpanExporter) -> None:
        self._inner = inner

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        try:
            result = self._inner.export(spans)
        except Exception:
            log.warning("octichq-airlock-sdk: traces export raised", exc_info=True)
            result = SpanExportResult.FAILURE

        if result is SpanExportResult.SUCCESS:
            # Spans rather than batches, so the number is comparable with what a
            # consumer counts at the other end.
            count("spans_accepted", len(spans))
            # "Accepted" is the bar for the silence warning, not "delivered": the
            # spool is the sink, and a batch on disk is the pipeline working.
            silence_watch.note_export_succeeded()
        else:
            count("exports_failed")
            log.warning(
                "octichq-airlock-sdk: a traces batch of %d spans was not accepted", len(spans)
            )
        return result

    def shutdown(self) -> None:
        try:
            self._inner.shutdown()
        except Exception:
            log.warning("octichq-airlock-sdk: traces exporter shutdown failed", exc_info=True)

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        try:
            return self._inner.force_flush(timeout_millis)
        except Exception:
            log.warning("octichq-airlock-sdk: traces exporter flush failed", exc_info=True)
            return False
