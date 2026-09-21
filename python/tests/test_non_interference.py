"""An SDK callback must not take out the call the customer was actually making.

The other half of the rule matters just as much: a customer's own failure must
reach them unchanged. A package that swallows both is quieter and useless.
"""

from __future__ import annotations

import pytest
from opentelemetry import trace

from conftest import Harness, attrs, build
from octic_telemetry import (
    ATTR,
    ContentOptions,
    OcticSpanProcessor,
    with_identity,
    with_tool,
    with_workflow,
)
from octic_telemetry.content import record_span_capture, span_capture_for


def test_a_customers_exception_reaches_them_unchanged(harness: Harness) -> None:
    original = ValueError("the account is closed")
    original.__cause__ = KeyError("root")

    with pytest.raises(ValueError) as raised:
        with with_workflow(name="chat-turn"):
            raise original

    assert raised.value is original
    assert raised.value.__cause__ is original.__cause__


def test_a_base_exception_propagates_and_the_span_still_ends(harness: Harness) -> None:
    with pytest.raises(KeyboardInterrupt):
        with with_tool(name="lookup"):
            raise KeyboardInterrupt

    assert harness.one().end_time is not None


def test_a_broken_redactor_never_becomes_the_customers_problem() -> None:
    def wrong_type(value: str, key: str) -> str:
        return 7  # type: ignore[return-value]

    harness = build(ContentOptions(redact=wrong_type))
    with with_tool(name="lookup", input="hello"):
        pass

    assert attrs(harness.one())[ATTR.OCTIC_ENTITY_INPUT] == "[redaction-failed]"


def test_an_unusable_identity_value_does_not_break_span_creation(harness: Harness) -> None:
    with with_identity(attributes={"bad": object()}):  # type: ignore[dict-item]
        with with_tool(name="lookup"):
            pass

    assert attrs(harness.one())[ATTR.GEN_AI_TOOL_NAME] == "lookup"


def test_the_processor_survives_a_span_it_cannot_weak_reference() -> None:
    """Then the stamped attribute is the fallback, which is the host-SDK path."""

    class NoWeakref:
        __slots__ = ()

    subject = NoWeakref()
    record_span_capture(subject, "none")
    assert span_capture_for(subject) == (False, None)


def test_the_processor_callbacks_are_inert(harness: Harness) -> None:
    """It owns no queue, no transport and no timer, so there is nothing to do."""
    processor = OcticSpanProcessor()
    assert processor.force_flush() is True
    processor.shutdown()


def test_a_span_started_with_no_scope_open_is_still_exported(
    harness: Harness, tracer: trace.Tracer
) -> None:
    with tracer.start_as_current_span("bare"):
        pass

    attributes = attrs(harness.one())
    assert ATTR.OCTIC_RUN_ID not in attributes
    assert ATTR.GEN_AI_CONVERSATION_ID not in attributes


def test_exporting_an_empty_batch_is_fine(harness: Harness) -> None:
    from opentelemetry.sdk.trace.export import SpanExportResult
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    from octic_telemetry import RedactingSpanExporter, resolve_policy

    exporter = RedactingSpanExporter(InMemorySpanExporter(), resolve_policy())
    assert exporter.export([]) is SpanExportResult.SUCCESS


def test_a_raising_processor_behind_the_guard_cannot_break_a_span() -> None:
    """What `init()` actually installs: the enricher inside `SafeSpanProcessor`.

    The processor is called from inside `start_span`, inside the customer's own
    code, so a raise there would be theirs to catch. It never gets that far.
    """
    from opentelemetry.sdk.trace import TracerProvider

    from octic_telemetry.safe_processor import SafeSpanProcessor

    class Exploding(OcticSpanProcessor):
        def on_start(self, span: object, parent_context: object = None) -> None:
            raise RuntimeError("our bug")

    provider = TracerProvider(shutdown_on_exit=False)
    provider.add_span_processor(SafeSpanProcessor(Exploding()))

    with provider.get_tracer("customer").start_as_current_span("request") as span:
        assert span.is_recording()
