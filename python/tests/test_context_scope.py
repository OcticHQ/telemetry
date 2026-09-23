"""The mechanism everything else is built on."""

from __future__ import annotations

import asyncio

from opentelemetry import context as context_api

from octichq_airlock_sdk.context_scope import ContextScope

merging = ContextScope[dict[str, int]](
    key="test.merging",
    to_attributes=lambda value: dict(value),
    merge=lambda existing, incoming: {**existing, **incoming},
)

replacing = ContextScope[dict[str, int]](
    key="test.replacing",
    to_attributes=lambda value: dict(value),
)


def test_absent_outside_a_scope() -> None:
    assert merging.from_context() is None
    assert merging.attributes_from() is None


def test_value_is_visible_inside_and_gone_outside() -> None:
    with merging.bind({"a": 1}):
        assert merging.from_context() == {"a": 1}
    assert merging.from_context() is None


def test_nesting_merges_when_a_merge_is_given() -> None:
    with merging.bind({"a": 1}):
        with merging.bind({"b": 2}):
            assert merging.from_context() == {"a": 1, "b": 2}
        assert merging.from_context() == {"a": 1}


def test_nesting_replaces_when_no_merge_is_given() -> None:
    with replacing.bind({"a": 1}):
        with replacing.bind({"b": 2}):
            assert replacing.from_context() == {"b": 2}
        assert replacing.from_context() == {"a": 1}


def test_scopes_are_independent() -> None:
    with merging.bind({"a": 1}), replacing.bind({"b": 2}):
        assert merging.from_context() == {"a": 1}
        assert replacing.from_context() == {"b": 2}


def test_the_value_rides_the_otel_context_not_a_bare_contextvar() -> None:
    """The reason this is not a `ContextVar`: it has to survive `attach`.

    A host SDK propagating its own captured Context is the real version of this,
    and a bare module-level variable would not come with it.
    """
    with merging.bind({"a": 1}):
        captured = context_api.get_current()

    assert merging.from_context() is None
    assert merging.from_context(captured) == {"a": 1}

    token = context_api.attach(captured)
    try:
        assert merging.from_context() == {"a": 1}
    finally:
        context_api.detach(token)


async def test_async_form_binds_the_same_value() -> None:
    async with merging.bind({"a": 1}):
        assert merging.from_context() == {"a": 1}
    assert merging.from_context() is None


async def test_a_scope_does_not_leak_between_concurrent_tasks() -> None:
    seen: dict[str, dict[str, int] | None] = {}

    async def worker(name: str, value: int) -> None:
        with merging.bind({name: value}):
            await asyncio.sleep(0)
            seen[name] = merging.from_context()

    await asyncio.gather(worker("first", 1), worker("second", 2))

    assert seen == {"first": {"first": 1}, "second": {"second": 2}}


async def test_a_scope_opened_outside_reaches_into_a_task() -> None:
    with merging.bind({"outer": 1}):
        result = await asyncio.create_task(_read())
    assert result == {"outer": 1}


async def _read() -> dict[str, int] | None:
    await asyncio.sleep(0)
    return merging.from_context()
