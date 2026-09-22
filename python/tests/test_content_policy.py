"""What leaves the process, and in what form. The tests that must never regress."""

from __future__ import annotations

import json

import pytest
from opentelemetry import trace

from conftest import Harness, attrs, build
from octic_telemetry import (
    ATTR,
    OCTIC_CONTENT_CAPTURE_VALUE_FULL,
    ContentOptions,
    current_capture,
    with_content,
    with_tool,
    with_workflow,
)

PROMPT = "the customer asked about their balance"


def test_the_default_is_none_and_no_content_is_sent(harness_default: Harness) -> None:
    """Pinned, so the default cannot change by accident in either direction."""
    with with_tool(name="lookup", input={"q": PROMPT}) as scope:
        scope.set_output({"a": PROMPT})

    attributes = attrs(harness_default.one())
    assert ATTR.OCTIC_ENTITY_INPUT not in attributes
    assert ATTR.OCTIC_ENTITY_OUTPUT not in attributes
    assert attributes[ATTR.GEN_AI_TOOL_NAME] == "lookup"


def test_full_sends_content(harness: Harness) -> None:
    with with_tool(name="lookup", input={"q": PROMPT}):
        pass
    assert PROMPT in attrs(harness.one())[ATTR.OCTIC_ENTITY_INPUT]


def test_none_produces_no_content_at_all() -> None:
    harness = build(ContentOptions(capture="none"))
    with with_tool(name="lookup", input={"q": PROMPT}) as scope:
        scope.set_output({"a": PROMPT})

    attributes = attrs(harness.one())
    assert ATTR.OCTIC_ENTITY_INPUT not in attributes
    assert ATTR.OCTIC_ENTITY_OUTPUT not in attributes
    # The governance half is untouched: the product works at this setting.
    assert attributes[ATTR.GEN_AI_TOOL_NAME] == "lookup"


def test_metadata_replaces_content_with_a_length_and_a_hash() -> None:
    harness = build(ContentOptions(capture="metadata"))
    with with_tool(name="lookup", input={"q": PROMPT}):
        pass

    summary = json.loads(attrs(harness.one())[ATTR.OCTIC_ENTITY_INPUT])
    assert summary["redacted"] is True
    assert summary["chars"] > 0
    assert len(summary["sha256"]) == 16
    assert PROMPT not in json.dumps(summary)


def test_a_span_the_exporter_withheld_from_is_flagged(tracer: trace.Tracer) -> None:
    """So a consumer can say "withheld by policy" rather than "this agent sent nothing"."""
    harness = build(ContentOptions(capture="none"))
    with tracer.start_as_current_span("vendor", attributes={"gen_ai.input.messages": PROMPT}):
        pass
    assert attrs(harness.one())[ATTR.OCTIC_REDACTED] is True


def test_our_own_content_is_declined_at_source_and_carries_no_flag() -> None:
    """The one kind we can decline to produce, rather than produce and strip.

    Worth doing: serializing an 8KB object costs real CPU, and a value that was
    never created cannot escape through a bug in the exporter. The consequence
    is that nothing was withheld at export, so there is nothing to flag.
    """
    harness = build(ContentOptions(capture="none"))
    with with_tool(name="lookup", input={"q": PROMPT}):
        pass

    attributes = attrs(harness.one())
    assert ATTR.OCTIC_ENTITY_INPUT not in attributes
    assert ATTR.OCTIC_REDACTED not in attributes


def test_the_capture_attribute_never_reaches_the_wire(harness: Harness) -> None:
    with with_tool(name="lookup"):
        pass
    assert ATTR.OCTIC_CONTENT_CAPTURE not in attrs(harness.one())


def test_a_caller_cannot_reopen_a_closed_process_through_span_options(
    tracer: trace.Tracer,
) -> None:
    """Span-option attributes are applied at construction; `on_start` runs after."""
    harness = build(ContentOptions(capture="none"))

    with tracer.start_as_current_span(
        "forged",
        attributes={
            ATTR.OCTIC_CONTENT_CAPTURE: OCTIC_CONTENT_CAPTURE_VALUE_FULL,
            "gen_ai.input.messages": PROMPT,
        },
    ):
        pass

    attributes = attrs(harness.one())
    assert "gen_ai.input.messages" not in attributes
    assert ATTR.OCTIC_CONTENT_CAPTURE not in attributes


def test_an_override_can_open_one_run_inside_a_closed_process() -> None:
    harness = build(ContentOptions(capture="none"))

    with with_content("full"):
        with with_tool(name="opened", input={"q": PROMPT}):
            pass
    with with_tool(name="closed", input={"q": PROMPT}):
        pass

    assert PROMPT in attrs(harness.named("opened"))[ATTR.OCTIC_ENTITY_INPUT]
    assert ATTR.OCTIC_ENTITY_INPUT not in attrs(harness.named("closed"))


def test_an_override_can_close_one_run_inside_an_open_process(harness: Harness) -> None:
    with with_content("none"):
        with with_tool(name="closed", input={"q": PROMPT}):
            pass

    assert ATTR.OCTIC_ENTITY_INPUT not in attrs(harness.named("closed"))


def test_current_capture_reads_the_override_then_the_policy() -> None:
    build(ContentOptions(capture="none"))
    assert current_capture() == "none"
    with with_content("full"):
        assert current_capture() == "full"
    assert current_capture() == "none"


def test_a_customer_redactor_runs_and_can_drop_a_value() -> None:
    harness = build(
        ContentOptions(
            capture="full", redact=lambda value, key: None if "balance" in value else value
        )
    )
    with with_tool(name="lookup", input={"q": PROMPT}):
        pass

    attributes = attrs(harness.one())
    assert ATTR.OCTIC_ENTITY_INPUT not in attributes
    assert attributes[ATTR.OCTIC_REDACTED] is True


def test_a_raising_redactor_fails_closed() -> None:
    def explode(value: str, key: str) -> str:
        raise RuntimeError("redactor is broken")

    harness = build(ContentOptions(capture="full", redact=explode))
    with with_tool(name="lookup", input={"q": PROMPT}):
        pass

    assert attrs(harness.one())[ATTR.OCTIC_ENTITY_INPUT] == "[redaction-failed]"


def test_max_length_caps_what_leaves() -> None:
    harness = build(ContentOptions(capture="full", max_length=32))
    with with_tool(name="lookup", input="x" * 500):
        pass

    value = attrs(harness.one())[ATTR.OCTIC_ENTITY_INPUT]
    assert value.startswith("x" * 32)
    assert value.endswith("…[truncated]")


def test_allow_attributes_exempts_a_key_that_looks_like_content(
    tracer: trace.Tracer,
) -> None:
    harness = build(ContentOptions(capture="full", allow_attributes=["gen_ai.input.messages"]))
    with tracer.start_as_current_span("vendor", attributes={"gen_ai.input.messages": PROMPT}):
        pass
    assert attrs(harness.one())["gen_ai.input.messages"] == PROMPT


def test_content_attributes_adds_a_key_we_have_not_measured(tracer: trace.Tracer) -> None:
    harness = build(
        ContentOptions(
            capture="none",
            content_attributes=["vendor.secret_field"],
        )
    )
    with tracer.start_as_current_span("vendor", attributes={"vendor.secret_field": "x"}):
        pass
    assert "vendor.secret_field" not in attrs(harness.one())


@pytest.mark.parametrize(
    "key",
    ["gen_ai.input.messages", "ai.prompt", "gen_ai.prompt.0.content", "vendor.messages"],
)
def test_known_and_pattern_matched_keys_are_treated_as_content(
    key: str, tracer: trace.Tracer
) -> None:
    harness = build(ContentOptions(capture="none"))
    with tracer.start_as_current_span("vendor", attributes={key: PROMPT}):
        pass
    assert key not in attrs(harness.one())


def test_a_long_string_on_a_foreign_span_is_content_whatever_it_is_called(
    tracer: trace.Tracer,
) -> None:
    harness = build(ContentOptions(capture="none"))
    with tracer.start_as_current_span("vendor", attributes={"vendor.unknown": "x" * 400}):
        pass
    assert "vendor.unknown" not in attrs(harness.one())


def test_a_long_list_on_a_foreign_span_is_measured_too(tracer: trace.Tracer) -> None:
    """Several stacks write the conversation as a list of strings."""
    harness = build(ContentOptions(capture="none"))
    with tracer.start_as_current_span("vendor", attributes={"vendor.turns": ["x" * 150] * 3}):
        pass
    assert "vendor.turns" not in attrs(harness.one())


def test_a_long_string_on_our_own_span_is_not_guessed_at(harness: Harness) -> None:
    """Our spans carry no surprises, so the heuristic does not run on them."""
    with with_workflow(name="chat-turn") as run:
        run.span.set_attribute("octic.custom.notes", "x" * 400)

    assert len(attrs(harness.one())["octic.custom.notes"]) == 400


def test_a_sequence_under_full_is_redacted_element_by_element(tracer: trace.Tracer) -> None:
    harness = build(
        ContentOptions(capture="full", redact=lambda value, key: value.replace("secret", "***"))
    )
    with tracer.start_as_current_span(
        "vendor", attributes={"gen_ai.input.messages": ["a secret", "b secret"]}
    ):
        pass
    assert list(attrs(harness.one())["gen_ai.input.messages"]) == ["a ***", "b ***"]


def test_a_sequence_with_one_dropped_element_is_dropped_whole(tracer: trace.Tracer) -> None:
    """A sparse list is a hole a consumer cannot interpret."""
    harness = build(
        ContentOptions(capture="full", redact=lambda value, key: None if "drop" in value else value)
    )
    with tracer.start_as_current_span(
        "vendor", attributes={"gen_ai.input.messages": ["keep", "drop me"]}
    ):
        pass
    assert "gen_ai.input.messages" not in attrs(harness.one())


def test_denied_resource_attributes_are_scrubbed(tracer: trace.Tracer) -> None:
    """Some default detectors ship the full argv, which is where secrets live."""
    from opentelemetry.sdk.resources import Resource

    from octic_telemetry.content import is_denied_resource_attribute

    assert is_denied_resource_attribute("process.command_args")
    assert not is_denied_resource_attribute("service.name")

    harness = build()
    with tracer.start_as_current_span("vendor"):
        pass
    resource: Resource = harness.one().resource
    assert "process.command_args" not in resource.attributes
