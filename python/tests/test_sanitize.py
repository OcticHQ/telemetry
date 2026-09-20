"""What we refuse to stamp, and the fact that refusing is never silent."""

from __future__ import annotations

import pytest

from conftest import Harness, attrs
from octic_telemetry import ATTR, with_identity
from octic_telemetry.counters import reset_counters, snapshot
from octic_telemetry.sanitize import MAX_ATTRIBUTES, MAX_KEY_LENGTH, sanitize_attributes


@pytest.mark.parametrize(
    "value",
    ["text", 7, 7.5, True, False, ["a", "b"], [1, 2], [True, False], [1.5, 2.5], ["a", None]],
)
def test_values_opentelemetry_can_carry_are_kept(value: object) -> None:
    attributes, dropped = sanitize_attributes({"k": value})
    assert dropped == 0
    assert "k" in attributes


@pytest.mark.parametrize(
    "value",
    [
        {"nested": 1},
        {1, 2},
        object(),
        ["a", 1],
        [True, 1],
        float("nan"),
        float("inf"),
        b"bytes",
    ],
)
def test_values_it_cannot_are_dropped_and_counted(value: object) -> None:
    reset_counters()
    attributes, dropped = sanitize_attributes({"k": value})
    assert attributes == {}
    assert dropped == 1
    assert snapshot()["attributes_dropped"] == 1
    reset_counters()


def test_none_is_skipped_without_being_counted_as_a_drop() -> None:
    reset_counters()
    attributes, dropped = sanitize_attributes({"k": None})
    assert (attributes, dropped) == ({}, 0)
    assert snapshot()["attributes_dropped"] == 0
    reset_counters()


def test_a_mixed_sequence_goes_whole_rather_than_in_part() -> None:
    """There is no partial form of it that means the same thing."""
    attributes, dropped = sanitize_attributes({"k": ["a", 1, "b"]})
    assert attributes == {}
    assert dropped == 1


def test_bool_is_not_an_int_here_even_though_python_says_it_is() -> None:
    attributes, _ = sanitize_attributes({"flag": True, "count": 1})
    assert attributes["flag"] is True
    assert attributes["count"] == 1


def test_an_empty_or_oversized_key_is_dropped_rather_than_truncated() -> None:
    """A truncated key is a different key, and a silent collision is worse than none."""
    attributes, dropped = sanitize_attributes({"": 1, "k" * (MAX_KEY_LENGTH + 1): 2, "fine": 3})
    assert attributes == {"fine": 3}
    assert dropped == 2


def test_the_per_map_cap_bounds_one_call() -> None:
    source: dict[str, object] = {f"k{i}": i for i in range(MAX_ATTRIBUTES + 5)}
    attributes, dropped = sanitize_attributes(source)
    assert len(attributes) == MAX_ATTRIBUTES
    assert dropped == 5


def test_strings_are_capped_at_the_policy_length(harness: Harness) -> None:
    attributes, _ = sanitize_attributes({"k": "x" * (harness.policy.max_length + 100)})
    capped = attributes["k"]
    assert isinstance(capped, str)
    assert capped.endswith("…[truncated]")


def test_a_value_the_sdk_cannot_carry_does_not_break_the_span(harness: Harness) -> None:
    """The consumer's call succeeds; only their unusable attribute is missing."""
    from opentelemetry import trace

    reset_counters()
    with with_identity(attributes={"good": "yes", "bad": object()}):  # type: ignore[dict-item]
        with trace.get_tracer("vendor-instrumentation").start_as_current_span("work"):
            pass

    attributes = attrs(harness.one())
    assert attributes["octic.custom.good"] == "yes"
    assert "octic.custom.bad" not in attributes
    assert snapshot()["attributes_dropped"] >= 1
    assert ATTR.OCTIC_RUN_ID not in attributes
    reset_counters()
