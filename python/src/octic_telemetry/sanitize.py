"""The attribute pass applied to everything *this SDK* stamps onto a span.

Not a crash guard, and worth stating so the next person does not re-derive it.
OpenTelemetry's own ``Span.set_attribute`` validates the value and, on one it
will not take, logs a warning and returns; a set, a dict, a mixed sequence and a
``None`` all vanish without raising anything. The problem is the vanishing, not a
raise: a consumer who put a business id in an identity scope and never sees it on
a span has no way to find out why, and OpenTelemetry's warning names the key
without naming us.

So this drops the same values OpenTelemetry would, and *counts* them, and says
which key under the debug flag. Silence is the failure this package exists to
remove; a guard that produces silence of its own is the same bug wearing our
name.

The rules are re-derived from :mod:`opentelemetry.attributes`, not translated
from the Node SDK's list. The two languages disagree about what a primitive is —
``bool`` is a subclass of ``int`` here and is not there — and a transliteration
would be right by accident at best.

Deliberately scoped to maps we author: the processor's per-span defaults and each
context scope's output. Attributes a customer or foreign instrumentation put on
their own span are not ours to rewrite.
"""

from __future__ import annotations

import math
from collections.abc import Sequence

from opentelemetry.util.types import AttributeValue

from .content import active_policy, truncate
from .counters import count, debug

# Matches OpenTelemetry's own per-span attribute count limit. Ours applies per
# map rather than per span, so it bounds what one `set_attributes` call can add;
# the SDK still enforces the real per-span total underneath.
MAX_ATTRIBUTES = 128

# Long enough for any key a convention defines, short enough that a key built by
# string concatenation from customer data cannot become the payload. Dropped
# rather than truncated: a truncated key is a different key, and a different key
# that silently collides with a real one is worse than no key.
MAX_KEY_LENGTH = 255


def _is_primitive(value: object) -> bool:
    # `bool` first: it is a subclass of `int`, so every ordering question in this
    # package has the same answer, and getting it wrong here is invisible.
    if isinstance(value, bool):
        return True
    if isinstance(value, int):
        return True
    if isinstance(value, float):
        # NaN and infinity are floats, so OpenTelemetry accepts them and the
        # JSON encoder then writes a token no strict parser will read back. A
        # number that arrives as null is worse than an absent attribute, because
        # it reads as "measured, and empty".
        return math.isfinite(value)
    return isinstance(value, str)


def _is_homogeneous_sequence(value: Sequence[object]) -> bool:
    """OpenTelemetry takes a sequence only when its elements share one type.

    ``None`` is a hole and does not decide the type. A mixed sequence is dropped
    whole — there is no partial form of it that means the same thing.
    """
    kind: type | None = None
    for element in value:
        if element is None:
            continue
        if not _is_primitive(element):
            return False
        # bool before int again: a list of `[True, 1]` is mixed, and `type()`
        # is what says so.
        current = type(element)
        if kind is None:
            kind = current
        elif current is not kind:
            return False
    return True


def _cap_strings(value: AttributeValue, limit: int) -> AttributeValue:
    if isinstance(value, str):
        return truncate(value, limit)
    if isinstance(value, (list, tuple)):
        return [truncate(e, limit) if isinstance(e, str) else e for e in value]
    return value


def _describe(value: object) -> str:
    """Names the type without stringifying the value, which may itself raise."""
    if isinstance(value, (list, tuple)):
        return "a mixed sequence"
    if isinstance(value, float):
        return "a non-finite number"
    return f"a {type(value).__name__}"


def _drop(key: str, why: str) -> None:
    count("attributes_dropped")
    debug("octic-telemetry: dropped attribute %s — %s", key, why)


def sanitize_attributes(source: dict[str, object]) -> tuple[dict[str, AttributeValue], int]:
    """Returns a new map and the number dropped.

    The count comes back as well as being counted, so a caller can report per
    span rather than only per process.
    """
    max_length = active_policy().max_length
    attributes: dict[str, AttributeValue] = {}
    dropped = 0
    kept = 0

    for key, value in source.items():
        if value is None:
            continue

        if not key or len(key) > MAX_KEY_LENGTH:
            dropped += 1
            # Truncated in the message too — the oversized key is the payload here.
            _drop(truncate(key, 64, "…"), f"the key is empty or over {MAX_KEY_LENGTH} characters")
            continue

        if kept >= MAX_ATTRIBUTES:
            dropped += 1
            _drop(key, f"more than {MAX_ATTRIBUTES} attributes in one map")
            continue

        if isinstance(value, (list, tuple)):
            usable = _is_homogeneous_sequence(value)
        else:
            usable = _is_primitive(value)

        if not usable:
            dropped += 1
            _drop(key, f"{_describe(value)} is not something OpenTelemetry can carry")
            continue

        attributes[key] = _cap_strings(value, max_length)  # type: ignore[arg-type]
        kept += 1

    return attributes, dropped
