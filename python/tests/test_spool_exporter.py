"""The chain init() assembles, run over real spans without the global provider."""

from __future__ import annotations

import json
from pathlib import Path

from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExportResult
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from octic_telemetry.content import ContentOptions, resolve_policy
from octic_telemetry.counters import reset_counters, snapshot
from octic_telemetry.redacting_exporter import RedactingSpanExporter
from octic_telemetry.safe_exporter import SafeSpanExporter
from octic_telemetry.spool import SEGMENT_SUFFIX, ManifestInput, Spool, SpoolOptions
from octic_telemetry.spool_exporter import SpoolingSpanExporter, serialize_spans

SECRET = "the customer asked about their balance"


def raw_spans(**attributes: str) -> list[ReadableSpan]:
    """Spans exactly as a vendor's instrumentation would hand them over, unredacted."""
    memory = InMemorySpanExporter()
    provider = TracerProvider(resource=Resource({"service.name": "svc"}), shutdown_on_exit=False)
    provider.add_span_processor(SimpleSpanProcessor(memory))
    with provider.get_tracer("vendor-instrumentation").start_as_current_span(
        "vendor", attributes=attributes
    ):
        pass
    return list(memory.get_finished_spans())


def spool_in(directory: Path, capture: str = "full") -> Spool:
    return Spool(
        SpoolOptions(dir=str(directory), fsync=False),
        ManifestInput(
            endpoint="https://ingest.example.test",
            service_name="svc",
            octic_schema_version="1",
            sdk_name="octic-python",
            sdk_version="0.0.0",
            content_capture=capture,
        ),
    )


def only_segment(directory: Path) -> bytes:
    [path] = [path for path in directory.iterdir() if path.name.endswith(SEGMENT_SUFFIX)]
    return path.read_bytes()


def test_a_batch_lands_as_an_otlp_json_request(tmp_path: Path) -> None:
    exporter = SpoolingSpanExporter(spool_in(tmp_path / "spool"))

    assert exporter.export(raw_spans()) is SpanExportResult.SUCCESS

    body = json.loads(only_segment(tmp_path / "spool"))
    [resource_spans] = body["resourceSpans"]
    [scope_spans] = resource_spans["scopeSpans"]
    assert scope_spans["spans"][0]["name"] == "vendor"


def test_the_body_is_compact_ascii_with_no_trailing_newline(tmp_path: Path) -> None:
    body = serialize_spans(raw_spans(note="café \ud800"))

    assert not body.endswith(b"\n")
    assert b": " not in body
    body.decode("ascii")


def test_nothing_the_policy_withholds_reaches_disk(tmp_path: Path) -> None:
    """The ordering argument: the spool sits inside the redactor, never outside it."""
    policy = resolve_policy(ContentOptions(capture="none"))
    exporter = RedactingSpanExporter(SpoolingSpanExporter(spool_in(tmp_path / "spool")), policy)

    exporter.export(raw_spans(**{"gen_ai.input.messages": SECRET}))

    assert SECRET.encode() not in only_segment(tmp_path / "spool")


def test_a_refused_batch_is_a_failure_and_is_counted(tmp_path: Path) -> None:
    reset_counters()
    spool = spool_in(tmp_path / "spool")
    spool.shutdown()
    exporter = SafeSpanExporter(SpoolingSpanExporter(spool))

    assert exporter.export(raw_spans()) is SpanExportResult.FAILURE
    assert snapshot()["exports_failed"] == 1
    reset_counters()


def test_an_accepted_batch_counts_its_spans(tmp_path: Path) -> None:
    reset_counters()
    exporter = SafeSpanExporter(SpoolingSpanExporter(spool_in(tmp_path / "spool")))

    exporter.export(raw_spans() + raw_spans())

    assert snapshot()["spans_accepted"] == 2
    reset_counters()


def test_an_empty_batch_writes_nothing(tmp_path: Path) -> None:
    exporter = SpoolingSpanExporter(spool_in(tmp_path / "spool"))

    assert exporter.export([]) is SpanExportResult.SUCCESS
    assert not (tmp_path / "spool").exists()
