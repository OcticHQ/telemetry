"""The exporter that hands each batch to the spool.

Placement is the whole design. This sits *inside* ``RedactingSpanExporter``, so
everything it sees has already been through the content policy; a spool above the
redactor would write raw prompts to a customer's disk under ``capture: "none"``.

With no HTTP transport there is no "try to send, fall back" branch and no
decision about which statuses are worth spooling — the Node exporter's
``isSpoolable`` has nothing to classify here. The spool *is* the exporter. The
plain ``SpanExporter`` shape is kept anyway, because that is the seam an HTTP
exporter gets inserted in front of when a Python consumer needs be-ingest.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Sequence

from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult

from .otlp_json import encode_spans
from .spool import Spool

log = logging.getLogger("octic_telemetry")


def serialize_spans(spans: Sequence[ReadableSpan]) -> bytes:
    """The segment body: exactly what an OTLP/JSON exporter would have POSTed.

    Compact, and no trailing newline, because SPOOL.md says the file *is* the
    body. ``ensure_ascii`` is what makes this total: a lone surrogate in a span
    attribute is a legal Python ``str`` and an illegal UTF-8 sequence, so encoding
    it raw would fail the whole batch over one character. Escaped, it is valid
    JSON that says what it contained.
    """
    return json.dumps(encode_spans(spans), separators=(",", ":"), ensure_ascii=True).encode("ascii")


class SpoolingSpanExporter(SpanExporter):
    def __init__(self, spool: Spool) -> None:
        self._spool = spool

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        if not spans:
            return SpanExportResult.SUCCESS
        try:
            body = serialize_spans(spans)
        except Exception:
            # A batch the encoder cannot represent is lost; the batches after it
            # are not. Reported as a failure so the counters say so.
            log.warning("octic-telemetry: could not encode a span batch", exc_info=True)
            return SpanExportResult.FAILURE
        return (
            SpanExportResult.SUCCESS
            if self._spool.write("traces", body)
            else SpanExportResult.FAILURE
        )

    def shutdown(self) -> None:
        self._spool.shutdown()

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        # Writes are synchronous: by the time `export` returned, the batch was on
        # disk or refused. There is nothing held here to flush.
        return True
