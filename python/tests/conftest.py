"""One pipeline, assembled the way a consumer's process would assemble it.

The global tracer provider can only be set once per process — a second call is
ignored with a warning — so it is set once for the session and the *exporter* is
what each test swaps. That is closer to the real arrangement than rebuilding a
provider per test anyway: the processor a consumer registers outlives every
individual policy decision.
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from typing import Any

import pytest
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExporter, SpanExportResult
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from octic_telemetry.content import ContentOptions, ContentPolicy, resolve_policy, set_active_policy
from octic_telemetry.counters import reset_counters, snapshot
from octic_telemetry.processor import OcticSpanProcessor
from octic_telemetry.redacting_exporter import RedactingSpanExporter


class _Swappable(SpanExporter):
    """Lets a test replace the whole export half without touching the provider."""

    def __init__(self) -> None:
        self.inner: SpanExporter | None = None

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        if self.inner is None:
            return SpanExportResult.SUCCESS
        return self.inner.export(spans)

    def shutdown(self) -> None:
        return

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        return True


_swappable = _Swappable()

_provider = TracerProvider(
    resource=Resource({"service.name": "test-suite"}),
    shutdown_on_exit=False,
)
_provider.add_span_processor(OcticSpanProcessor())
_provider.add_span_processor(SimpleSpanProcessor(_swappable))
trace.set_tracer_provider(_provider)


@dataclass
class Harness:
    memory: InMemorySpanExporter
    policy: ContentPolicy

    def spans(self) -> list[ReadableSpan]:
        """Everything exported so far, after redaction."""
        return list(self.memory.get_finished_spans())

    def one(self) -> ReadableSpan:
        spans = self.spans()
        assert len(spans) == 1, f"expected exactly one span, got {len(spans)}"
        return spans[0]

    def named(self, suffix: str) -> ReadableSpan:
        matches = [span for span in self.spans() if span.name.endswith(suffix)]
        assert len(matches) == 1, f"expected one span ending {suffix!r}, got {len(matches)}"
        return matches[0]

    def counters(self) -> dict[str, int]:
        return snapshot()


def build(options: ContentOptions | None = None) -> Harness:
    """Install a policy for this test and hand back what it exported."""
    policy = resolve_policy(options)
    set_active_policy(policy)
    memory = InMemorySpanExporter()
    _swappable.inner = RedactingSpanExporter(memory, policy)
    return Harness(memory=memory, policy=policy)


@pytest.fixture
def harness() -> Iterator[Harness]:
    reset_counters()
    yield build()
    _swappable.inner = None
    set_active_policy(resolve_policy())
    reset_counters()


@pytest.fixture
def tracer() -> trace.Tracer:
    """A tracer under a scope that is not ours, for the foreign-span paths."""
    return trace.get_tracer("vendor-instrumentation", "9.9.9")


def attrs(subject: object) -> dict[str, Any]:
    """Attributes as a plain dict.

    ``ReadableSpan.attributes`` is an optional mapping of a wide union, so every
    assertion in the suite would otherwise carry the same two narrowing steps.
    """
    return dict(getattr(subject, "attributes", None) or {})
