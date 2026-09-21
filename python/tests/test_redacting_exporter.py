"""The export-time enforcement point, including the paths a span can go wrong on."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import Status, StatusCode

from conftest import Harness, attrs, build
from octic_telemetry import (
    ATTR,
    OCTIC_SDK_NAME_VALUES,
    ContentOptions,
    RedactingSpanExporter,
    resolve_policy,
    with_tool,
)
from octic_telemetry.counters import reset_counters, snapshot
from octic_telemetry.redacting_exporter import _OUR_SCOPES

SECRET = "the customer asked about their balance"


def test_our_scopes_are_the_whole_contract_enum() -> None:
    """One SDK renaming itself must not silently exempt another's spans."""
    assert frozenset(OCTIC_SDK_NAME_VALUES) == _OUR_SCOPES
    assert len(_OUR_SCOPES) > 1


def test_an_exception_event_is_redacted(tracer: trace.Tracer) -> None:
    """`record_exception` puts the message and the stacktrace in an event.

    Our annotations switch that off; nothing stops a customer or a vendor's
    instrumentation calling it, and an error message quoting the prompt is
    content reached by a different field.
    """
    harness = build(ContentOptions(capture="none"))

    with tracer.start_as_current_span("vendor") as span:
        span.record_exception(ValueError(SECRET))

    event = harness.one().events[0]
    assert event.name == "exception"
    assert "exception.message" not in attrs(event)
    assert "exception.stacktrace" not in attrs(event)


def test_content_inside_an_event_still_flags_the_span(tracer: trace.Tracer) -> None:
    harness = build(ContentOptions(capture="none"))

    with tracer.start_as_current_span("vendor") as span:
        span.add_event("vendor.thing", attributes={"gen_ai.input.messages": SECRET})

    assert attrs(harness.one())[ATTR.OCTIC_REDACTED] is True


def test_the_status_message_is_content_and_the_code_is_not(tracer: trace.Tracer) -> None:
    harness = build(ContentOptions(capture="none"))

    with tracer.start_as_current_span("vendor") as span:
        span.set_status(Status(StatusCode.ERROR, SECRET))

    exported = harness.one()
    assert exported.status.status_code is StatusCode.ERROR
    assert exported.status.description is None


def test_a_status_message_survives_under_full(harness: Harness, tracer: trace.Tracer) -> None:
    with tracer.start_as_current_span("vendor") as span:
        span.set_status(Status(StatusCode.ERROR, "the account is closed"))

    assert harness.one().status.description == "the account is closed"


def test_fields_we_do_not_touch_ride_through_unchanged(harness: Harness) -> None:
    """The copy is a delegating proxy so an upstream field addition survives it.

    Rebuilding a ReadableSpan from its constructor would drop whatever a future
    release adds, quietly — which is the failure this package exists to remove.
    """
    with with_tool(name="outer"):
        with with_tool(name="inner"):
            pass

    inner = harness.named("inner")
    outer = harness.named("outer")

    assert inner.parent is not None
    assert inner.parent.span_id == outer.context.span_id
    assert inner.kind is trace.SpanKind.INTERNAL
    assert inner.instrumentation_scope is not None
    assert inner.start_time is not None and inner.end_time is not None
    assert inner.dropped_attributes == 0
    assert inner.context is not None and outer.context is not None
    assert inner.context.trace_id == outer.context.trace_id
    # An arbitrary method that reads private state through the proxy.
    assert '"name":' in inner.to_json()


def test_to_json_reads_the_redacted_attributes_not_the_originals(
    tracer: trace.Tracer,
) -> None:
    """`to_json` reads the private fields, so the copy has to replace those too."""
    harness = build(ContentOptions(capture="none"))
    with tracer.start_as_current_span("vendor", attributes={"gen_ai.input.messages": SECRET}):
        pass

    assert SECRET not in harness.one().to_json()


class _Exploding(ReadableSpan):
    """A span whose attributes cannot be read. One of the ways to reach the fallback."""

    def __init__(self, inner: ReadableSpan) -> None:
        super().__init__(name=inner.name, context=inner.context, resource=inner.resource)
        self._inner = inner

    @property
    def attributes(self) -> dict[str, Any]:
        raise RuntimeError("this span cannot be read")


def test_one_unreadable_span_does_not_cost_the_batch() -> None:
    reset_counters()
    memory = InMemorySpanExporter()
    exporter = RedactingSpanExporter(memory, resolve_policy())

    provider_spans: list[ReadableSpan] = []
    tracer = trace.get_tracer("vendor-instrumentation")
    for name in ("good-one", "good-two"):
        with tracer.start_as_current_span(name) as span:
            provider_spans.append(span)  # type: ignore[arg-type]

    broken = _Exploding(provider_spans[0])
    batch = [provider_spans[0], broken, provider_spans[1]]
    assert exporter.export(batch) is SpanExportResult.SUCCESS

    exported = memory.get_finished_spans()
    assert len(exported) == 3
    # The unreadable one keeps its identity and carries nothing that could be content.
    stripped = exported[1]
    assert attrs(stripped) == {}
    assert stripped.name == "good-one"
    reset_counters()


class _Recording(SpanExporter):
    def __init__(self) -> None:
        self.batches: list[Sequence[ReadableSpan]] = []
        self.shutdowns = 0
        self.flushes = 0

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        self.batches.append(list(spans))
        return SpanExportResult.SUCCESS

    def shutdown(self) -> None:
        self.shutdowns += 1

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        self.flushes += 1
        return True


def test_lifecycle_calls_pass_straight_through() -> None:
    inner = _Recording()
    exporter = RedactingSpanExporter(inner, resolve_policy())

    assert exporter.export([]) is SpanExportResult.SUCCESS
    assert exporter.force_flush() is True
    exporter.shutdown()

    assert (inner.shutdowns, inner.flushes) == (1, 1)


def test_the_resource_is_scrubbed_once_and_reused(tracer: trace.Tracer) -> None:
    harness = build()
    resource = Resource({"service.name": "svc", "process.command_args": ["--token", "s3cret"]})
    from opentelemetry.sdk.trace import TracerProvider

    provider = TracerProvider(resource=resource, shutdown_on_exit=False)
    local = provider.get_tracer("vendor-instrumentation")

    spans: list[ReadableSpan] = []
    for name in ("one", "two"):
        with local.start_as_current_span(name) as span:
            spans.append(span)  # type: ignore[arg-type]

    exporter = RedactingSpanExporter(InMemorySpanExporter(), harness.policy)
    first = exporter._sanitize(spans[0])
    second = exporter._sanitize(spans[1])

    assert "process.command_args" not in first.resource.attributes
    assert first.resource is second.resource


def test_counters_start_and_stay_at_zero_on_the_happy_path(harness: Harness) -> None:
    with with_tool(name="lookup", input={"q": "hello"}):
        pass
    assert all(value == 0 for value in snapshot().values())
