"""The wrappers: nothing of ours raises into the caller, and what they swallow is counted."""

from __future__ import annotations

from collections.abc import Iterator, Sequence

import pytest
from opentelemetry.context import Context
from opentelemetry.sdk.trace import ReadableSpan, Span, SpanProcessor
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult

from octichq_airlock_sdk.counters import reset_counters, snapshot
from octichq_airlock_sdk.safe_exporter import SafeSpanExporter
from octichq_airlock_sdk.safe_processor import SafeSpanProcessor


@pytest.fixture(autouse=True)
def counters() -> Iterator[None]:
    reset_counters()
    yield
    reset_counters()


class _ExplodingProcessor(SpanProcessor):
    def on_start(self, span: Span, parent_context: Context | None = None) -> None:
        raise RuntimeError("on_start")

    def on_end(self, span: ReadableSpan) -> None:
        raise RuntimeError("on_end")

    def shutdown(self) -> None:
        raise RuntimeError("shutdown")

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        raise RuntimeError("force_flush")


class _ExplodingExporter(SpanExporter):
    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        raise RuntimeError("export")

    def shutdown(self) -> None:
        raise RuntimeError("shutdown")

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        raise RuntimeError("force_flush")


def test_no_processor_callback_escapes() -> None:
    processor = SafeSpanProcessor(_ExplodingProcessor())

    processor.on_start(None)  # type: ignore[arg-type]
    processor.on_end(None)  # type: ignore[arg-type]
    assert processor.force_flush() is False
    processor.shutdown()

    assert snapshot()["processor_errors"] == 4


def test_a_raising_export_is_a_failure_not_an_exception() -> None:
    exporter = SafeSpanExporter(_ExplodingExporter())

    assert exporter.export([]) is SpanExportResult.FAILURE
    assert exporter.force_flush() is False
    exporter.shutdown()

    assert snapshot()["exports_failed"] == 1
