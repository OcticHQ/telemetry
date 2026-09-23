"""The encoder. Whatever it drops is dropped for good, so this checks the shape.

The proof of concept this grew out of omitted events, links, the status message,
the dropped counts, flags, trace state and the scope's own attributes. Every one
of those has a test here, because an SDK carries spans it did not author and a
consumer cannot tell a field the producer never set from a field we forgot.
"""

from __future__ import annotations

import json
import re
from typing import Any

import pytest
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import Link, SpanContext, SpanKind, Status, StatusCode, TraceFlags
from opentelemetry.trace.span import TraceState

from octichq_airlock_sdk import encode_spans
from octichq_airlock_sdk.otlp_json import _any_value

HEX32 = re.compile(r"^[0-9a-f]{32}$")
HEX16 = re.compile(r"^[0-9a-f]{16}$")


def _provider(resource: Resource | None = None) -> tuple[TracerProvider, InMemorySpanExporter]:
    memory = InMemorySpanExporter()
    provider = TracerProvider(
        resource=resource or Resource({"service.name": "svc"}),
        shutdown_on_exit=False,
    )
    provider.add_span_processor(SimpleSpanProcessor(memory))
    return provider, memory


def _one(**kwargs: object) -> ReadableSpan:
    provider, memory = _provider()
    tracer = provider.get_tracer("scope-under-test", "1.2.3")
    with tracer.start_as_current_span("work", **kwargs):  # type: ignore[arg-type]
        pass
    return memory.get_finished_spans()[0]


def _encoded(span: ReadableSpan) -> dict[str, Any]:
    encoded: dict[str, Any] = encode_spans([span])["resourceSpans"][0]["scopeSpans"][0]["spans"][0]
    return encoded


def test_ids_are_lowercase_hex_not_base64() -> None:
    """OTLP/JSON's documented departure from proto3's mapping for bytes."""
    encoded = _encoded(_one())
    assert HEX32.match(encoded["traceId"])
    assert HEX16.match(encoded["spanId"])


def test_timestamps_are_strings() -> None:
    encoded = _encoded(_one())
    assert isinstance(encoded["startTimeUnixNano"], str)
    assert isinstance(encoded["endTimeUnixNano"], str)


@pytest.mark.parametrize(
    ("kind", "expected"),
    [
        (SpanKind.INTERNAL, 1),
        (SpanKind.SERVER, 2),
        (SpanKind.CLIENT, 3),
        (SpanKind.PRODUCER, 4),
        (SpanKind.CONSUMER, 5),
    ],
)
def test_span_kind_is_mapped_by_name(kind: SpanKind, expected: int) -> None:
    assert _encoded(_one(kind=kind))["kind"] == expected


def test_bool_is_encoded_before_int() -> None:
    """`bool` is a subclass of `int`, so the obvious ordering encodes True as 1."""
    assert _any_value(True) == {"boolValue": True}
    assert _any_value(1) == {"intValue": "1"}


def test_int64_travels_as_a_string() -> None:
    """A JSON number cannot hold an int64 once a reader parses it as a double."""
    assert _any_value(2**62) == {"intValue": str(2**62)}


def test_the_any_value_union_covers_what_opentelemetry_carries() -> None:
    assert _any_value("s") == {"stringValue": "s"}
    assert _any_value(1.5) == {"doubleValue": 1.5}
    assert _any_value(["a", "b"]) == {
        "arrayValue": {"values": [{"stringValue": "a"}, {"stringValue": "b"}]}
    }


def test_events_are_encoded() -> None:
    provider, memory = _provider()
    tracer = provider.get_tracer("scope-under-test")
    with tracer.start_as_current_span("work") as span:
        span.add_event("checkpoint", attributes={"n": 1})

    encoded = _encoded(memory.get_finished_spans()[0])
    assert encoded["events"][0]["name"] == "checkpoint"
    assert encoded["events"][0]["attributes"] == [{"key": "n", "value": {"intValue": "1"}}]
    assert isinstance(encoded["events"][0]["timeUnixNano"], str)


def test_links_are_encoded() -> None:
    linked = SpanContext(
        trace_id=0x1234_5678_9ABC_DEF0_1234_5678_9ABC_DEF0,
        span_id=0x1122_3344_5566_7788,
        is_remote=True,
        trace_flags=TraceFlags(TraceFlags.SAMPLED),
    )
    provider, memory = _provider()
    tracer = provider.get_tracer("scope-under-test")
    with tracer.start_as_current_span("work", links=[Link(linked, {"why": "retry"})]):
        pass

    link = _encoded(memory.get_finished_spans()[0])["links"][0]
    assert link["traceId"] == "123456789abcdef0123456789abcdef0"
    assert link["spanId"] == "1122334455667788"
    assert link["attributes"] == [{"key": "why", "value": {"stringValue": "retry"}}]
    # Sampled, plus "is remote is known" and "is remote".
    assert link["flags"] == 0x1 | 0x100 | 0x200


def test_the_status_message_is_encoded_not_only_the_code() -> None:
    provider, memory = _provider()
    tracer = provider.get_tracer("scope-under-test")
    with tracer.start_as_current_span("work") as span:
        span.set_status(Status(StatusCode.ERROR, "the account is closed"))

    status = _encoded(memory.get_finished_spans()[0])["status"]
    assert status == {"code": StatusCode.ERROR.value, "message": "the account is closed"}


def test_an_unset_status_carries_a_code_and_no_message() -> None:
    assert _encoded(_one())["status"] == {"code": StatusCode.UNSET.value}


def test_trace_state_survives() -> None:
    provider, memory = _provider()
    tracer = provider.get_tracer("scope-under-test")
    parent = SpanContext(
        trace_id=0x1234_5678_9ABC_DEF0_1234_5678_9ABC_DEF0,
        span_id=0x1122_3344_5566_7788,
        is_remote=True,
        trace_flags=TraceFlags(TraceFlags.SAMPLED),
        trace_state=TraceState([("vendor", "value")]),
    )
    with tracer.start_as_current_span(
        "work", context=trace.set_span_in_context(trace.NonRecordingSpan(parent))
    ):
        pass

    encoded = _encoded(memory.get_finished_spans()[0])
    assert encoded["traceState"] == "vendor=value"
    assert encoded["parentSpanId"] == "1122334455667788"
    # The parent is remote, so both remote bits are set.
    assert encoded["flags"] & 0x300 == 0x300


def test_a_root_span_does_not_claim_to_know_about_a_remote_parent() -> None:
    encoded = _encoded(_one())
    assert encoded["flags"] & 0x100 == 0
    assert "parentSpanId" not in encoded


def test_dropped_counts_appear_only_when_something_was_dropped() -> None:
    encoded = _encoded(_one())
    assert "droppedAttributesCount" not in encoded
    assert "droppedEventsCount" not in encoded
    assert "droppedLinksCount" not in encoded


def test_the_scope_carries_its_name_version_and_attributes() -> None:
    provider, memory = _provider()
    tracer = provider.get_tracer("scope-under-test", "1.2.3", attributes={"team": "core"})
    with tracer.start_as_current_span("work"):
        pass

    scope = encode_spans(memory.get_finished_spans())["resourceSpans"][0]["scopeSpans"][0]["scope"]
    assert scope["name"] == "scope-under-test"
    assert scope["version"] == "1.2.3"
    assert scope["attributes"] == [{"key": "team", "value": {"stringValue": "core"}}]


def test_the_resource_schema_url_survives() -> None:
    resource = Resource({"service.name": "svc"}, schema_url="https://example.invalid/v1")
    provider, memory = _provider(resource)
    with provider.get_tracer("scope-under-test").start_as_current_span("work"):
        pass

    block = encode_spans(memory.get_finished_spans())["resourceSpans"][0]
    assert block["schemaUrl"] == "https://example.invalid/v1"


def test_spans_are_grouped_by_resource_and_then_by_scope() -> None:
    """The proof of concept assumed one of each, which stops holding the moment a
    second instrumentation package is installed."""
    provider, memory = _provider()
    for scope_name in ("scope-a", "scope-b"):
        with provider.get_tracer(scope_name).start_as_current_span("work"):
            pass

    other_provider, other_memory = _provider(Resource({"service.name": "other"}))
    with other_provider.get_tracer("scope-a").start_as_current_span("work"):
        pass

    payload = encode_spans([*memory.get_finished_spans(), *other_memory.get_finished_spans()])

    assert len(payload["resourceSpans"]) == 2
    first, second = payload["resourceSpans"]
    assert len(first["scopeSpans"]) == 2
    assert {s["scope"]["name"] for s in first["scopeSpans"]} == {"scope-a", "scope-b"}
    assert len(second["scopeSpans"]) == 1


def test_an_empty_batch_encodes_to_an_empty_list() -> None:
    assert encode_spans([]) == {"resourceSpans": []}


def test_the_payload_is_strict_json() -> None:
    """`allow_nan=False` is the assertion: NaN is not JSON any reader will take."""
    provider, memory = _provider()
    tracer = provider.get_tracer("scope-under-test")
    with tracer.start_as_current_span("work", attributes={"n": 1.5, "s": "x", "b": True}):
        pass

    body = json.dumps(encode_spans(memory.get_finished_spans()), allow_nan=False)
    assert json.loads(body)["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["name"] == "work"
