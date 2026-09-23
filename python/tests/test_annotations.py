"""The four call forms, the attributes each annotation writes, and failure."""

from __future__ import annotations

import asyncio

import pytest

from conftest import Harness, attrs
from octichq_airlock_sdk import (
    ATTR,
    GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
    GEN_AI_OPERATION_NAME_VALUE_INVOKE_WORKFLOW,
    GEN_AI_OPERATION_NAME_VALUE_RETRIEVAL,
    GEN_AI_TOOL_TYPE_VALUE_FUNCTION,
    Target,
    current_run_id,
    with_retrieval,
    with_tool,
    with_workflow,
)
from octichq_airlock_sdk.annotations import TRACER_NAME, TRACER_VERSION
from octichq_airlock_sdk.version import SDK_NAME, SDK_VERSION


def test_the_tracer_scope_is_the_sdk_pair() -> None:
    """One name for both, so a span's scope and its resource cannot disagree."""
    assert (TRACER_NAME, TRACER_VERSION) == (SDK_NAME, SDK_VERSION)


def test_workflow_span_shape(harness: Harness) -> None:
    with with_workflow(name="chat-turn", input={"q": "hello"}) as run:
        run.set_output({"a": "hi"})

    span = harness.one()
    attributes = attrs(span)
    assert span.name == f"{GEN_AI_OPERATION_NAME_VALUE_INVOKE_WORKFLOW} chat-turn"
    assert attributes[ATTR.GEN_AI_OPERATION_NAME] == GEN_AI_OPERATION_NAME_VALUE_INVOKE_WORKFLOW
    assert attributes[ATTR.GEN_AI_WORKFLOW_NAME] == "chat-turn"
    assert attributes[ATTR.OCTIC_ENTITY_INPUT] == '{"q": "hello"}'
    assert attributes[ATTR.OCTIC_ENTITY_OUTPUT] == '{"a": "hi"}'
    assert attributes[ATTR.OCTIC_RUN_ID].startswith("run-chat-turn-")


def test_workflow_opens_the_run_scope_for_everything_underneath(harness: Harness) -> None:
    with with_workflow(name="chat-turn") as run:
        inside = current_run_id()
        with with_tool(name="lookup"):
            pass

    assert inside == run.run_id
    assert attrs(harness.named("lookup"))[ATTR.OCTIC_RUN_ID] == run.run_id


def test_a_supplied_run_id_is_used_as_given(harness: Harness) -> None:
    with with_workflow(name="chat-turn", run_id="run-from-the-app"):
        pass
    assert attrs(harness.one())[ATTR.OCTIC_RUN_ID] == "run-from-the-app"


def test_tool_span_shape(harness: Harness) -> None:
    with with_tool(
        name="lookup_account",
        input={"id": 7},
        target=Target(name="accounts", type="datastore", asset_ref="asset-9"),
    ):
        pass

    attributes = attrs(harness.one())
    assert attributes[ATTR.GEN_AI_OPERATION_NAME] == GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL
    assert attributes[ATTR.GEN_AI_TOOL_NAME] == "lookup_account"
    assert attributes[ATTR.GEN_AI_TOOL_TYPE] == GEN_AI_TOOL_TYPE_VALUE_FUNCTION
    assert attributes[ATTR.OCTIC_TARGET_NAME] == "accounts"
    assert attributes[ATTR.OCTIC_TARGET_TYPE] == "datastore"
    assert attributes[ATTR.OCTIC_TARGET_ASSET_REF] == "asset-9"


def test_tool_type_is_not_taken_from_the_target(harness: Harness) -> None:
    """They answer different questions: what the model called, and what it reached."""
    with with_tool(name="lookup", target=Target(name="accounts", type="datastore")):
        pass

    attributes = attrs(harness.one())
    assert attributes[ATTR.GEN_AI_TOOL_TYPE] == GEN_AI_TOOL_TYPE_VALUE_FUNCTION
    assert attributes[ATTR.OCTIC_TARGET_TYPE] == "datastore"


def test_retrieval_puts_a_text_query_on_the_semconv_key(harness: Harness) -> None:
    with with_retrieval(name="policies", input="what is the refund window"):
        pass

    attributes = attrs(harness.one())
    assert attributes[ATTR.GEN_AI_OPERATION_NAME] == GEN_AI_OPERATION_NAME_VALUE_RETRIEVAL
    assert attributes[ATTR.GEN_AI_DATA_SOURCE_ID] == "policies"
    assert attributes[ATTR.GEN_AI_RETRIEVAL_QUERY_TEXT] == "what is the refund window"
    assert ATTR.OCTIC_ENTITY_INPUT not in attributes


def test_retrieval_puts_a_structured_query_on_the_honest_generic_key(harness: Harness) -> None:
    with with_retrieval(name="policies", input={"q": "refunds", "k": 5}):
        pass

    attributes = attrs(harness.one())
    assert ATTR.GEN_AI_RETRIEVAL_QUERY_TEXT not in attributes
    assert attributes[ATTR.OCTIC_ENTITY_INPUT] == '{"q": "refunds", "k": 5}'


async def test_async_with_form(harness: Harness) -> None:
    async with with_workflow(name="chat-turn") as run:
        await asyncio.sleep(0)
        run.set_output("done")

    assert attrs(harness.one())[ATTR.OCTIC_ENTITY_OUTPUT] == "done"


def test_sync_decorator_form_records_the_return_value(harness: Harness) -> None:
    @with_tool(name="lookup_account")
    def lookup(account_id: str) -> dict[str, str]:
        return {"id": account_id}

    assert lookup("acc-1") == {"id": "acc-1"}
    attributes = attrs(harness.one())
    assert attributes[ATTR.GEN_AI_TOOL_NAME] == "lookup_account"
    assert attributes[ATTR.OCTIC_ENTITY_OUTPUT] == '{"id": "acc-1"}'


async def test_async_decorator_form_records_the_return_value(harness: Harness) -> None:
    @with_tool(name="lookup_account")
    async def lookup(account_id: str) -> dict[str, str]:
        await asyncio.sleep(0)
        return {"id": account_id}

    assert await lookup("acc-1") == {"id": "acc-1"}
    assert attrs(harness.one())[ATTR.OCTIC_ENTITY_OUTPUT] == '{"id": "acc-1"}'


def test_a_decorated_workflow_called_twice_is_two_runs(harness: Harness) -> None:
    @with_workflow(name="chat-turn")
    def turn() -> None:
        return None

    turn()
    turn()

    run_ids = {attrs(span)[ATTR.OCTIC_RUN_ID] for span in harness.spans()}
    assert len(run_ids) == 2


async def test_concurrent_calls_to_one_decorated_function_do_not_share_a_span(
    harness: Harness,
) -> None:
    @with_tool(name="lookup_account")
    async def lookup(account_id: str) -> str:
        await asyncio.sleep(0)
        return account_id

    assert list(await asyncio.gather(lookup("a"), lookup("b"))) == ["a", "b"]
    outputs = {attrs(span)[ATTR.OCTIC_ENTITY_OUTPUT] for span in harness.spans()}
    assert outputs == {"a", "b"}


def test_the_customers_exception_comes_back_unchanged(harness: Harness) -> None:
    original = ValueError("the account is closed")

    with pytest.raises(ValueError) as raised:
        with with_tool(name="lookup_account"):
            raise original

    assert raised.value is original


def test_a_failure_is_recorded_as_a_status_and_never_as_an_event(harness: Harness) -> None:
    """`record_exception` writes the message and the stacktrace into an event.

    That is content arriving without anyone deciding to send it, so it is off.
    The status still says the run failed, which is not content.
    """
    with pytest.raises(ValueError):
        with with_tool(name="lookup_account"):
            raise ValueError("the account is closed")

    span = harness.one()
    assert span.events == ()
    assert span.status.status_code.name == "ERROR"


def test_an_unserializable_input_does_not_break_the_call(harness: Harness) -> None:
    with with_tool(name="lookup", input={"fn": object()}):
        pass

    # `default=str` keeps it encodable rather than dropping the whole attribute.
    assert ATTR.OCTIC_ENTITY_INPUT in attrs(harness.one())


def test_a_none_return_records_no_output(harness: Harness) -> None:
    @with_tool(name="fire_and_forget")
    def go() -> None:
        return None

    go()
    assert ATTR.OCTIC_ENTITY_OUTPUT not in attrs(harness.one())
