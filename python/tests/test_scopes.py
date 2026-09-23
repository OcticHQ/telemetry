"""Identity, agent, prompt and run — the four non-span scopes, on real spans."""

from __future__ import annotations

import re

import pytest
from opentelemetry import trace

from conftest import Harness, attrs
from octichq_airlock_sdk import (
    ATTR,
    CUSTOMER_ATTRIBUTE_PREFIX,
    RESERVED_ATTRIBUTE_PREFIX,
    current_identity,
    current_run_id,
    mint_run_id,
    with_agent,
    with_identity,
    with_prompt,
    with_run,
)


def _span(tracer: trace.Tracer, name: str = "work") -> None:
    with tracer.start_as_current_span(name):
        pass


def test_identity_lands_on_a_span_from_foreign_instrumentation(
    harness: Harness, tracer: trace.Tracer
) -> None:
    with with_identity(conversation_id="conv-1", user_id="user-7"):
        _span(tracer)

    attributes = attrs(harness.one())
    assert attributes[ATTR.GEN_AI_CONVERSATION_ID] == "conv-1"
    # Written twice on purpose: the GenAI name and the general one.
    assert attributes[ATTR.SESSION_ID] == "conv-1"
    assert attributes[ATTR.USER_ID] == "user-7"


def test_customer_attributes_cannot_reach_the_reserved_namespace(
    harness: Harness, tracer: trace.Tracer
) -> None:
    """A tenant key that collides with ours must not be able to overwrite it."""
    with with_run("run-real"), with_identity(attributes={"run.id": "run-forged", "tier": "gold"}):
        _span(tracer)

    attributes = attrs(harness.one())
    assert attributes[ATTR.OCTIC_RUN_ID] == "run-real"
    assert attributes[f"{CUSTOMER_ATTRIBUTE_PREFIX}run.id"] == "run-forged"
    assert attributes[f"{CUSTOMER_ATTRIBUTE_PREFIX}tier"] == "gold"
    assert CUSTOMER_ATTRIBUTE_PREFIX.startswith(RESERVED_ATTRIBUTE_PREFIX)


def test_identity_merges_and_the_inner_call_does_not_clobber_the_outer(
    harness: Harness, tracer: trace.Tracer
) -> None:
    with with_identity(conversation_id="conv-1", attributes={"tier": "gold"}):
        with with_identity(user_id="user-7", attributes={"region": "eu"}):
            _span(tracer)

    attributes = attrs(harness.one())
    assert attributes[ATTR.GEN_AI_CONVERSATION_ID] == "conv-1"
    assert attributes[ATTR.USER_ID] == "user-7"
    assert attributes[f"{CUSTOMER_ATTRIBUTE_PREFIX}tier"] == "gold"
    assert attributes[f"{CUSTOMER_ATTRIBUTE_PREFIX}region"] == "eu"


def test_current_identity_reads_back_what_is_open() -> None:
    assert current_identity() is None
    with with_identity(user_id="user-7"):
        identity = current_identity()
        assert identity is not None
        assert identity.user_id == "user-7"


def test_agent_replaces_rather_than_merging(harness: Harness, tracer: trace.Tracer) -> None:
    with with_agent(agent_id="agent-outer", name="Outer", asset_ref="asset-1"):
        with with_agent(agent_id="agent-inner"):
            _span(tracer)

    attributes = attrs(harness.one())
    assert attributes[ATTR.GEN_AI_AGENT_ID] == "agent-inner"
    # Two agents are two agents: the outer name must not survive onto the inner.
    assert ATTR.GEN_AI_AGENT_NAME not in attributes
    assert ATTR.OCTIC_AGENT_ASSET_REF not in attributes


def test_prompt_stamps_template_and_version(harness: Harness, tracer: trace.Tracer) -> None:
    with with_prompt(template="compliance-report", version="v3"):
        _span(tracer)

    attributes = attrs(harness.one())
    assert attributes[ATTR.GEN_AI_PROMPT_NAME] == "compliance-report"
    assert attributes[ATTR.OCTIC_PROMPT_VERSION] == "v3"


def test_prompt_version_is_optional(harness: Harness, tracer: trace.Tracer) -> None:
    with with_prompt(template="compliance-report"):
        _span(tracer)

    attributes = attrs(harness.one())
    assert ATTR.OCTIC_PROMPT_VERSION not in attributes


def test_run_id_reaches_a_span_that_is_not_a_child(harness: Harness, tracer: trace.Tracer) -> None:
    """Scoping rather than parent-walking is the whole point."""
    with with_run("run-abc"):
        _span(tracer, "first")
        _span(tracer, "second")

    assert [attrs(s)[ATTR.OCTIC_RUN_ID] for s in harness.spans()] == ["run-abc", "run-abc"]


def test_current_run_id() -> None:
    assert current_run_id() is None
    with with_run("run-abc"):
        assert current_run_id() == "run-abc"
    assert current_run_id() is None


@pytest.mark.parametrize(
    ("name", "expected_slug"),
    [
        ("chat turn", "chat-turn"),
        ("Chat  Turn!!", "chat-turn"),
        ("---", "run"),
        ("", "run"),
        ("a" * 60, "a" * 24),
    ],
)
def test_minted_run_ids_are_readable_and_bounded(name: str, expected_slug: str) -> None:
    minted = mint_run_id(name)
    assert re.fullmatch(rf"run-{re.escape(expected_slug)}-[0-9a-f]{{16}}", minted)


def test_minted_run_ids_do_not_repeat() -> None:
    assert len({mint_run_id("chat") for _ in range(200)}) == 200
