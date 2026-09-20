"""The enforcement point for span content.

Why the exporter and not ``SpanProcessor.on_end``, which looks like the obvious
place: the SDK hands *the same span instance* to every processor and exporter, so
editing it in ``on_end`` is action at a distance on anyone else's pipeline. So we
copy.

The second reason is the decisive one. When a host SDK owns the tracer provider
the processor list is theirs to arrange; the exporter is the one surface that is
still ours in both entry modes. One implementation covers both, and
:class:`~octic_telemetry.processor.OcticSpanProcessor` stays enrichment-only.
"""

from __future__ import annotations

import contextlib
import weakref
from collections.abc import Mapping, Sequence

from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import Event, ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult
from opentelemetry.trace import Status
from opentelemetry.util.types import AttributeValue

from .attributes import (
    ATTR_OCTIC_CONTENT_CAPTURE,
    ATTR_OCTIC_REDACTED,
    OCTIC_SDK_NAME_VALUES,
)
from .content import (
    ContentCapture,
    ContentPolicy,
    apply_capture,
    is_content,
    is_denied_resource_attribute,
    span_capture_for,
)
from .counters import count, debug

# The key the status message is classified under. Not a real attribute — the
# message travels in its own field — but `apply_capture` takes a key so a
# customer's redactor can branch on where a value came from, and this is what
# that value is.
STATUS_MESSAGE_KEY = "status.message"

# The instrumentation scopes that are ours, so everything else is foreign.
#
# Foreign is the interesting half: a span we did not create can carry an entire
# conversation in a bare string under a key nobody has named, so the content
# heuristic runs on those and not on ours. Getting the test wrong in the
# permissive direction is a leak, which is why the vocabulary is the contract's
# enum rather than a literal — one SDK renaming itself cannot silently exempt
# another's spans. Every member, not just this SDK's own, because the rule is
# "did one of our SDKs make this", and that sentence should read the same in
# every language that implements it.
_OUR_SCOPES = frozenset(OCTIC_SDK_NAME_VALUES)


class _SanitizedSpan(ReadableSpan):
    """A copy of a span with the content fields replaced and nothing else touched.

    The Node SDK builds this with ``Object.create``, so a ``ReadableSpan`` field
    added in a future release still rides through. Python has no equivalent, and
    rebuilding one from its constructor drops whatever upstream added — quietly,
    which is the failure mode this package exists to remove.

    So: subclass for the sake of anything downstream that type-checks, populate
    the four private fields the inherited properties read, and forward every
    other attribute to the original span through ``__getattr__``. Writing to the
    private names rather than overriding the public properties matters — methods
    like ``to_json`` read ``self._attributes`` directly, and an override would
    leave that path reading the unredacted original.
    """

    def __init__(
        self,
        span: ReadableSpan,
        *,
        attributes: Mapping[str, AttributeValue],
        events: Sequence[Event],
        status: Status,
        resource: Resource,
    ) -> None:
        state = self.__dict__
        state["_octic_span"] = span
        state["_attributes"] = attributes
        state["_events"] = events
        state["_status"] = status
        state["_resource"] = resource

    def __getattr__(self, name: str) -> object:
        try:
            span = self.__dict__["_octic_span"]
        except KeyError:  # pragma: no cover - only reachable mid-construction
            raise AttributeError(name) from None
        return getattr(span, name)


# One resource serves every span from a process; scrub it once.
_scrubbed_resources: weakref.WeakKeyDictionary[Resource, Resource] = weakref.WeakKeyDictionary()


def _scrub_resource(resource: Resource) -> Resource:
    try:
        cached = _scrubbed_resources.get(resource)
    except TypeError:
        cached = None
    if cached is not None:
        return cached

    kept = {k: v for k, v in resource.attributes.items() if not is_denied_resource_attribute(k)}
    # `Resource(...)` rather than `Resource.create(...)`: create runs the
    # detectors again, which is how a scrub ends up re-adding what it removed.
    scrubbed = resource if len(kept) == len(resource.attributes) else Resource(kept)

    with contextlib.suppress(TypeError):
        _scrubbed_resources[resource] = scrubbed
    return scrubbed


def _resolve_capture(span: ReadableSpan, policy: ContentPolicy) -> ContentCapture:
    """Which capture level applies, in order of how much we trust the source.

    An entry in the weak map means our processor started this span, so the
    question is settled there: either an override was open, or the policy this
    exporter was built with applies. The stamped attribute is not consulted at
    all in that case — it is writable by anything that can write an attribute,
    which is the hole this closes.

    The attribute is the fallback only when there is no entry, which means a host
    SDK copied the span between processor and exporter. An unrecognised value is
    still safe: `apply_capture` treats anything it does not know as "drop", so an
    unknown level fails closed rather than open.
    """
    seen, override = span_capture_for(span)
    if seen:
        return override if override is not None else policy.capture

    stamped = (span.attributes or {}).get(ATTR_OCTIC_CONTENT_CAPTURE)
    return stamped if isinstance(stamped, str) else policy.capture  # type: ignore[return-value]


class RedactingSpanExporter(SpanExporter):
    """Applies the content policy to every span on its way out."""

    def __init__(self, inner: SpanExporter, policy: ContentPolicy) -> None:
        self._inner = inner
        self._policy = policy

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        return self._inner.export(self._sanitize_all(spans))

    def shutdown(self) -> None:
        self._inner.shutdown()

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        return self._inner.force_flush(timeout_millis)

    def _sanitize_all(self, spans: Sequence[ReadableSpan]) -> list[ReadableSpan]:
        """Per span, not per batch.

        A span the copy cannot be built from is one span; letting it raise here
        would lose every other span in the batch, and — since ``export`` is
        called from inside the batch processor's worker thread — take the
        exception somewhere nothing can act on it.
        """
        sanitized: list[ReadableSpan] = []

        for span in spans:
            try:
                sanitized.append(self._sanitize(span))
            except Exception as error:  # noqa: BLE001 - one bad span must not cost the batch
                debug(
                    "octic-telemetry: a span could not be sanitized (%s); sending it stripped",
                    type(error).__name__,
                )
                try:
                    # Content is the thing that must not leak, so the fallback
                    # keeps the span's identity and drops everything that could
                    # carry content. The status code survives: "this run failed"
                    # is not content.
                    sanitized.append(
                        _SanitizedSpan(
                            span,
                            attributes={},
                            events=(),
                            status=Status(span.status.status_code),
                            resource=_scrub_resource(span.resource),
                        )
                    )
                except Exception:  # noqa: BLE001 - nothing left to try; drop the one span
                    count("spans_dropped")

        return sanitized

    def _sanitize_attributes(
        self,
        source: Mapping[str, AttributeValue] | None,
        foreign: bool,
        capture: ContentCapture,
    ) -> tuple[dict[str, AttributeValue], bool]:
        """Shared by the span's own attributes and every event's.

        Returns a new map and whether anything was withheld, because the caller
        has to raise the redaction flag on the span even when the thing withheld
        was three levels down inside an event.
        """
        attributes: dict[str, AttributeValue] = {}
        redacted = False

        for key, value in (source or {}).items():
            # Carried on the span only to get the policy here; not something we ship.
            if key == ATTR_OCTIC_CONTENT_CAPTURE or value is None:
                continue

            if not is_content(key, value, foreign, self._policy):
                attributes[key] = value
                continue

            kept = apply_capture(value, key, capture, self._policy)
            if kept is None:
                redacted = True
                continue
            if kept != value:
                redacted = True
            attributes[key] = kept

        return attributes, redacted

    def _sanitize(self, span: ReadableSpan) -> ReadableSpan:
        scope = span.instrumentation_scope
        foreign = scope is None or scope.name not in _OUR_SCOPES
        capture = _resolve_capture(span, self._policy)

        attributes, redacted = self._sanitize_attributes(span.attributes, foreign, capture)

        # Events, which is where `record_exception` puts the exception message
        # and stacktrace. Our annotations switch that off, but nothing stops a
        # customer or a vendor's instrumentation calling it — and an error
        # message quoting the prompt is content reached by a different field.
        # Event attributes are classified by the same rules as span attributes:
        # the contract lists the two exception keys explicitly, because our own
        # spans are not foreign and the length heuristic never fires on them.
        events: list[Event] = []
        for event in span.events:
            event_attributes, event_redacted = self._sanitize_attributes(
                event.attributes, foreign, capture
            )
            redacted = redacted or event_redacted
            events.append(
                Event(name=event.name, attributes=event_attributes, timestamp=event.timestamp)
            )

        # And the status message, which upstream sets from the exception on an
        # escaping error — the same string as the exception event, reached by a
        # different field. Always treated as content: it is free-form text
        # authored by application or vendor code, which is exactly the population
        # the policy governs. The status *code* is untouched.
        status = span.status
        if status.description is not None:
            kept = apply_capture(status.description, STATUS_MESSAGE_KEY, capture, self._policy)
            if kept != status.description:
                redacted = True
                status = (
                    Status(status.status_code)
                    if kept is None
                    else Status(status.status_code, str(kept))
                )

        # So a consumer can say "withheld by policy" rather than "this agent sent
        # nothing".
        if redacted:
            attributes[ATTR_OCTIC_REDACTED] = True

        return _SanitizedSpan(
            span,
            attributes=attributes,
            events=events,
            status=status,
            resource=_scrub_resource(span.resource),
        )
