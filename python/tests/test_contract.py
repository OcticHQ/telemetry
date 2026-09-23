"""Nothing this SDK stamps may be a literal it made up."""

from __future__ import annotations

from dataclasses import fields

from octichq_airlock_sdk import ATTR, OCTIC_SDK_NAME_VALUES
from octichq_airlock_sdk import attributes_gen as gen
from octichq_airlock_sdk.annotations import TRACER_NAME
from octichq_airlock_sdk.attributes import _Attr
from octichq_airlock_sdk.version import SDK_NAME


def test_every_attr_member_is_the_generated_constant() -> None:
    for field in fields(_Attr):
        generated = getattr(gen, f"ATTR_{field.name}")
        assert getattr(ATTR, field.name) == generated


def test_attr_covers_every_generated_key() -> None:
    """A key added to the contract must not be reachable only by the long name."""
    generated = {name for name in dir(gen) if name.startswith("ATTR_")}
    exposed = {f"ATTR_{field.name}" for field in fields(_Attr)}
    assert generated == exposed


def test_this_sdk_names_itself_from_the_contract_enum() -> None:
    assert SDK_NAME == gen.OCTIC_SDK_NAME_VALUE_OCTICHQ_AIRLOCK_SDK
    assert SDK_NAME in OCTIC_SDK_NAME_VALUES


def test_the_instrumentation_scope_is_the_sdk_name() -> None:
    """So a span's scope and its resource cannot disagree about who wrote it.

    The drift check cannot guard this — it owns keys, not enum values — so this
    assertion is what pins it.
    """
    assert TRACER_NAME == SDK_NAME


def test_the_sibling_sdk_is_still_in_the_enum() -> None:
    """The foreign-span test is set membership, and a one-member set is a literal."""
    assert gen.OCTIC_SDK_NAME_VALUE_OCTIC_NODE in OCTIC_SDK_NAME_VALUES


def test_the_capture_levels_are_the_contract_s() -> None:
    assert set(gen.OCTIC_CONTENT_CAPTURE_VALUES) == {"none", "metadata", "full"}
