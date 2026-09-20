"""One OTLP/JSON ``ExportTraceServiceRequest``, built by hand.

Python has no OTLP/JSON exporter. The one HTTP exporter upstream ships
hard-codes ``application/x-protobuf``, and this SDK's wire format is JSON — which
is not a preference but a consequence: a spool segment *is* the OTLP/JSON body,
byte for byte, and an external reader POSTs the file verbatim. Protobuf would be
a different spool format version.

That is also why this encoder is complete rather than convenient. Whatever it
drops is dropped for good, including from instrumentation we did not write, and
nobody downstream can tell the difference between a field the producer never set
and a field this file forgot. The proof of concept this grew out of deliberately
omitted events, links, the status message, the dropped counts, flags, trace state
and the scope's own attributes — correct for a service that owns every span it
emits, wrong for an SDK that carries other people's.

Nothing here applies policy. By the time a span reaches this module the redacting
exporter has already decided what may leave.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import Any, cast

from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import Event, ReadableSpan
from opentelemetry.sdk.util.instrumentation import InstrumentationScope
from opentelemetry.trace import Link, SpanContext, SpanKind
from opentelemetry.util.types import AttributeValue

# Python's SpanKind and OTLP's differ by one, and OTLP has an UNSPECIFIED member
# Python does not. Mapped by name rather than by arithmetic on the enum value,
# which would be right today and silently wrong after any upstream reordering.
_KIND_TO_OTLP = {
    SpanKind.INTERNAL: 1,
    SpanKind.SERVER: 2,
    SpanKind.CLIENT: 3,
    SpanKind.PRODUCER: 4,
    SpanKind.CONSUMER: 5,
}

# https://opentelemetry.io/docs/specs/otel/trace/api/#spancontext — the low byte
# is the W3C trace flags; the two bits above it say whether "is remote" is known
# and what it is.
_FLAGS_TRACE_MASK = 0x000000FF
_FLAGS_HAS_IS_REMOTE = 0x00000100
_FLAGS_IS_REMOTE = 0x00000200


def _any_value(value: object) -> dict[str, Any]:
    """Wrap a Python value in OTLP's AnyValue union.

    ``bool`` is checked before ``int`` on purpose: it is a subclass of ``int``,
    so the obvious ordering encodes ``True`` as an integer.
    """
    if isinstance(value, bool):
        return {"boolValue": value}
    if isinstance(value, str):
        return {"stringValue": value}
    if isinstance(value, int):
        # 64-bit fields travel as strings in OTLP/JSON — a JSON number cannot
        # hold an int64 without loss once a reader parses it as a double.
        return {"intValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    if isinstance(value, bytes):
        return {"bytesValue": value.decode("utf-8", "replace")}
    if isinstance(value, (list, tuple)):
        return {"arrayValue": {"values": [_any_value(item) for item in value]}}
    return {"stringValue": str(value)}


def _attributes(source: Mapping[str, AttributeValue] | None) -> list[dict[str, Any]]:
    return [{"key": key, "value": _any_value(value)} for key, value in (source or {}).items()]


def _flags(context: SpanContext, parent: SpanContext | None) -> int:
    flags = int(context.trace_flags) & _FLAGS_TRACE_MASK
    if parent is not None:
        flags |= _FLAGS_HAS_IS_REMOTE
        if parent.is_remote:
            flags |= _FLAGS_IS_REMOTE
    return flags


def _trace_state(context: SpanContext) -> str | None:
    state = context.trace_state
    if not state:
        return None
    return str(state.to_header())


def _encode_event(event: Event) -> dict[str, Any]:
    encoded: dict[str, Any] = {
        "timeUnixNano": str(event.timestamp),
        "name": event.name,
        "attributes": _attributes(event.attributes),
    }
    dropped = getattr(event, "dropped_attributes", 0)
    if dropped:
        encoded["droppedAttributesCount"] = dropped
    return encoded


def _encode_link(link: Link) -> dict[str, Any]:
    encoded: dict[str, Any] = {
        "traceId": format(link.context.trace_id, "032x"),
        "spanId": format(link.context.span_id, "016x"),
        "attributes": _attributes(link.attributes),
        # A link knows its own remoteness, so the "is remote" bit is always
        # meaningful here — unlike on a span, where it describes the parent.
        "flags": (
            (int(link.context.trace_flags) & _FLAGS_TRACE_MASK)
            | _FLAGS_HAS_IS_REMOTE
            | (_FLAGS_IS_REMOTE if link.context.is_remote else 0)
        ),
    }
    state = _trace_state(link.context)
    if state is not None:
        encoded["traceState"] = state
    dropped = getattr(link, "dropped_attributes", 0)
    if dropped:
        encoded["droppedAttributesCount"] = dropped
    return encoded


def _encode_span(span: ReadableSpan) -> dict[str, Any]:
    # Not-None by construction: `encode_spans` drops context-less spans before
    # grouping, because a span with no trace id and no span id has nothing to
    # encode and no consumer could place it.
    context = cast(SpanContext, span.get_span_context())
    encoded: dict[str, Any] = {
        # Lowercase hex, which is OTLP/JSON's documented departure from proto3's
        # base64 mapping for `bytes`. Base64 ids are accepted by a lenient
        # receiver and unreadable downstream.
        "traceId": format(context.trace_id, "032x"),
        "spanId": format(context.span_id, "016x"),
        "name": span.name,
        "kind": _KIND_TO_OTLP.get(span.kind, 0),
        "startTimeUnixNano": str(span.start_time),
        "endTimeUnixNano": str(span.end_time),
        "attributes": _attributes(span.attributes),
        "flags": _flags(context, span.parent),
        "status": _encode_status(span),
    }

    if span.parent is not None:
        encoded["parentSpanId"] = format(span.parent.span_id, "016x")

    state = _trace_state(context)
    if state is not None:
        encoded["traceState"] = state

    if span.events:
        encoded["events"] = [_encode_event(event) for event in span.events]
    if span.links:
        encoded["links"] = [_encode_link(link) for link in span.links]

    # Omitted when zero, which is what proto3 JSON does with a default anyway —
    # but present when non-zero, because "we dropped some of this" is exactly the
    # kind of thing a consumer debugging a gap needs to see.
    for field, value in (
        ("droppedAttributesCount", span.dropped_attributes),
        ("droppedEventsCount", span.dropped_events),
        ("droppedLinksCount", span.dropped_links),
    ):
        if value:
            encoded[field] = value

    return encoded


def _encode_status(span: ReadableSpan) -> dict[str, Any]:
    status: dict[str, Any] = {"code": span.status.status_code.value}
    if span.status.description is not None:
        status["message"] = span.status.description
    return status


def _encode_scope(scope: InstrumentationScope | None) -> dict[str, Any]:
    if scope is None:
        return {}
    encoded: dict[str, Any] = {"name": scope.name, "version": scope.version or ""}
    if scope.attributes:
        encoded["attributes"] = _attributes(scope.attributes)
    return encoded


def _encode_resource(resource: Resource) -> dict[str, Any]:
    return {"attributes": _attributes(resource.attributes)}


_ScopeGroup = dict[int, "tuple[InstrumentationScope | None, list[ReadableSpan]]"]


def _group(spans: Iterable[ReadableSpan]) -> dict[int, tuple[Resource, _ScopeGroup]]:
    """Group by resource, then by instrumentation scope.

    Keyed by identity rather than by value: a `Resource` is not hashable in
    every version, and within one export the objects are shared anyway. Grouping
    at all is the part that matters — the proof of concept assumed one resource
    and one scope per batch, which holds for a service that owns all its spans
    and stops holding the moment a second instrumentation package is installed.
    """
    grouped: dict[int, tuple[Resource, _ScopeGroup]] = {}
    for span in spans:
        resource = span.resource
        _, scopes = grouped.setdefault(id(resource), (resource, {}))
        scope = span.instrumentation_scope
        _, members = scopes.setdefault(id(scope), (scope, []))
        members.append(span)
    return grouped


def encode_spans(spans: Sequence[ReadableSpan]) -> dict[str, Any]:
    """Build one OTLP/JSON ``ExportTraceServiceRequest``."""
    resource_spans: list[dict[str, Any]] = []
    encodable = [span for span in spans if span.get_span_context() is not None]

    for resource, scopes in _group(encodable).values():
        scope_spans: list[dict[str, Any]] = []
        for scope, members in scopes.values():
            entry: dict[str, Any] = {
                "scope": _encode_scope(scope),
                "spans": [_encode_span(span) for span in members],
            }
            if scope is not None and scope.schema_url:
                entry["schemaUrl"] = scope.schema_url
            scope_spans.append(entry)

        block: dict[str, Any] = {
            "resource": _encode_resource(resource),
            "scopeSpans": scope_spans,
        }
        if resource.schema_url:
            block["schemaUrl"] = resource.schema_url
        resource_spans.append(block)

    return {"resourceSpans": resource_spans}
