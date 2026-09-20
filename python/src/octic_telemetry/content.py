"""What leaves the customer's process, and in what form.

Message content is the one thing here that is unambiguously the customer's data
rather than telemetry about their data — prompts, tool arguments, model output.
Under a governance framing none of it is required: the agent, the run, the prompt
*name*, the token counts and the asset refs answer every question the product
asks, and all of them survive with content switched off.

The default is nonetheless ``full``, and that is a deliberate early-stage choice
rather than a claim that content is harmless. A product nobody can see the inside
of is impossible to evaluate — a first customer whose traces show no prompts and
no outputs cannot tell rich telemetry from a broken pipeline. So content is
opt-*out* for now: the other two levels are one option away, per process or per
run, and the whole product still works at either. The proof of concept this SDK
grew out of hardcoded the opposite, which is the right call for one lending
service and the wrong default for a library.

Three places produce content:

    our annotation spans      the entity input/output keys     preventable at source
    foreign span attributes   whatever a vendor writes         not preventable
    span events               an exception message             not preventable

We cannot stop foreign instrumentation writing content; we can stop it leaving.
That makes the export path the enforcement point, not the call site.
"""

from __future__ import annotations

import hashlib
import json
import weakref
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Literal

from opentelemetry.util.types import AttributeValue

from .attributes import (
    ATTR_OCTIC_CONTENT_CAPTURE,
    CONTENT_HEURISTIC_MIN_LENGTH,
    CONTENT_KEYS,
    CONTENT_PATTERNS,
    OCTIC_CONTENT_CAPTURE_VALUE_FULL,
    OCTIC_CONTENT_CAPTURE_VALUE_METADATA,
    RESOURCE_DENY,
)
from .context_scope import AttributeMap, ContextScope, ScopeBinding

#: ``none`` drops it — token counts, latency, model and every governance
#: attribute are unaffected, and the product works at this setting. ``metadata``
#: replaces it with a length and a hash, enough to answer "is this the same
#: system prompt as last run" without storing a byte of it. ``full`` sends it,
#: after the customer's redactor and the length cap.
ContentCapture = Literal["none", "metadata", "full"]

TRUNCATION_MARKER = "…[truncated]"

#: Redactors take the value and the key it arrived under, and return a
#: replacement or ``None`` to drop the value entirely.
Redactor = Callable[[str, str], "str | None"]


@dataclass(frozen=True)
class ContentOptions:
    capture: ContentCapture = "full"
    #: Last chance to scrub a value the customer knows the shape of better than
    #: we do. Runs only under ``full``. MUST NOT raise — and if it does we drop
    #: the value rather than falling through to the original, because a broken
    #: redactor must fail closed.
    redact: Redactor | None = None
    #: Hard cap under ``full``.
    max_length: int = 4096
    #: Exact keys to treat as non-content even if they look like content.
    allow_attributes: Sequence[str] = ()
    #: Extra keys to treat as content — for instrumentation we have not measured.
    content_attributes: Sequence[str] = ()


@dataclass(frozen=True)
class ContentPolicy:
    capture: ContentCapture = "full"
    redact: Redactor | None = None
    max_length: int = 4096
    allow: frozenset[str] = field(default_factory=frozenset)
    extra: frozenset[str] = field(default_factory=frozenset)


def resolve_policy(options: ContentOptions | None = None) -> ContentPolicy:
    settings = options or ContentOptions()
    return ContentPolicy(
        capture=settings.capture,
        redact=settings.redact,
        max_length=settings.max_length,
        allow=frozenset(settings.allow_attributes),
        extra=frozenset(settings.content_attributes),
    )


# The policy startup settled on, readable from the annotations without threading
# it through every call. Process state, and one process has one policy.
#
# The pre-startup value is the same default, which is worth stating plainly: an
# annotation that runs before the SDK is configured serializes its input. That is
# only reachable with no provider registered, so nothing exports it — but it
# stops being harmless the day the default goes back to dropping content.
_active = resolve_policy()


def set_active_policy(policy: ContentPolicy) -> None:
    global _active
    _active = policy


def active_policy() -> ContentPolicy:
    return _active


content_scope = ContextScope[ContentCapture](
    key="octic.content",
    to_attributes=lambda capture: {ATTR_OCTIC_CONTENT_CAPTURE: capture},
)


def with_content(capture: ContentCapture) -> ScopeBinding[ContentCapture]:
    """Per-run override, on the same Context mechanism as identity and prompt.

    Stamped onto every span by the processor — including foreign ones, which is
    the point — read back at export, and stripped before the span leaves. Lets a
    customer run one level globally and open up, or close down, one agent.
    """
    return content_scope.bind(capture)


def current_capture() -> ContentCapture:
    """The level in effect right here: an override if one is open, else the policy."""
    override = content_scope.from_context()
    return override if override is not None else _active.capture


# The capture level the processor resolved for a span, keyed by the span object
# itself rather than by an attribute on it.
#
# The attribute is still stamped — the contract declares it, and a host SDK that
# copies spans before export needs something to fall back on — but it cannot be
# the authority, because anything that can write a span attribute can write that
# one. A caller passing the permissive level in span options would otherwise
# reopen a process configured to send nothing, from application code that had no
# idea the key existed.
#
# A weak map closes it because the identity is not forgeable: the SDK hands the
# exporter the same object the processor saw, and nothing on the wire can point
# at an entry it did not create. Weak so a dropped span is still collectable.
#
# What is recorded is the *override* — what an open scope asked for at this span
# — and not the level the processor resolved. Those are different claims, and
# conflating them makes the processor's idea of the default outrank the policy
# the exporter holds. An entry with no override still means something: it says
# our processor saw this span, so the exporter knows the stamped attribute is
# redundant rather than authoritative.
_span_capture: weakref.WeakKeyDictionary[object, ContentCapture | None] = (
    weakref.WeakKeyDictionary()
)

# Distinguishes "our processor saw this span and there was no override" from
# "we have never seen this span", which a plain `None` cannot.
_MISSING = object()


def record_span_capture(span: object, capture: ContentCapture | None) -> None:
    try:
        _span_capture[span] = capture
    except TypeError:
        # A span implementation that cannot be weak-referenced. The stamped
        # attribute is the fallback, which is the same path a host SDK copying
        # spans already takes.
        return


def span_capture_for(span: object) -> tuple[bool, ContentCapture | None]:
    """``(seen, override)``. ``seen`` is what settles which side is authoritative."""
    try:
        entry = _span_capture.get(span, _MISSING)
    except TypeError:
        return (False, None)
    if entry is _MISSING:
        return (False, None)
    return (True, entry)  # type: ignore[return-value]


_CONTENT_KEY_SET = frozenset(CONTENT_KEYS)
_RESOURCE_DENY_SET = frozenset(RESOURCE_DENY)


def is_content(
    key: str,
    value: AttributeValue | None,
    foreign_scope: bool,
    policy: ContentPolicy,
) -> bool:
    """Known keys, shape patterns, and a length bound — all three, not one.

    The keys, the patterns and the bound all come from the contract: this module
    decides what to *do* about content, not what content is. The classification
    has to be shared, because the same list has to reach ingest, which redacts
    for customers who do not run this SDK at all.

    A denylist alone fails open the day a vendor ships a key we have never seen.
    An allowlist of non-content keys fails the other way and drops every new
    token-count field. So the length bound backs both up, and only on spans from
    a scope we do not control — ours cannot carry a surprise.
    """
    if key in policy.allow:
        return False
    if key in _CONTENT_KEY_SET or key in policy.extra:
        return True
    if any(pattern.search(key) for pattern in CONTENT_PATTERNS):
        return True
    return foreign_scope and _text_length(value) > CONTENT_HEURISTIC_MIN_LENGTH


def _text_length(value: AttributeValue | None) -> int:
    """How much free text a value carries, for the length bound.

    Sequences count too. OTel attributes are primitives *or* sequences of them,
    and several stacks write the conversation as a list of strings — measuring
    only bare strings would let a foreign span carry the whole thing under a key
    we had never seen and sail past the heuristic.
    """
    if isinstance(value, str):
        return len(value)
    if isinstance(value, (list, tuple)):
        return sum(len(entry) for entry in value if isinstance(entry, str))
    return 0


def truncate(value: str, limit: int, marker: str = TRUNCATION_MARKER) -> str:
    """Cut to ``limit`` characters.

    No surrogate-pair guard, unlike the Node SDK: a JavaScript string slices
    UTF-16 code units and can cut a pair in half, leaving something that is not
    valid UTF-8 for a JSON encoder to choke on. A Python ``str`` indexes code
    points, so a plain slice cannot produce a lone surrogate. Do not port the
    guard back in.
    """
    if len(value) <= limit:
        return value
    return f"{value[:limit]}{marker}"


def _summarize(value: object) -> str:
    text = value if isinstance(value, str) else _stringify(value)
    return json.dumps(
        {
            "redacted": True,
            "chars": len(text),
            "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest()[:16],
        },
        separators=(",", ":"),
    )


def _stringify(value: object) -> str:
    try:
        return json.dumps(value, separators=(",", ":"))
    except (TypeError, ValueError):
        return str(value)


def apply_capture(
    value: AttributeValue,
    key: str,
    capture: ContentCapture,
    policy: ContentPolicy,
) -> AttributeValue | None:
    """The value to send, or ``None`` to drop the key entirely.

    Fails closed in every direction: an unexpected capture level, a raising
    redactor and a redactor returning ``None`` all end in no content leaving.
    """
    if capture == OCTIC_CONTENT_CAPTURE_VALUE_METADATA:
        return _summarize(value)
    if capture != OCTIC_CONTENT_CAPTURE_VALUE_FULL:
        return None

    if isinstance(value, str):
        return _redact_string(value, key, policy)

    # Sequences element by element, rather than a blanket pass-through.
    #
    # The permissive level is the one a customer picks *because* they are
    # relying on their redactor, so handing a list straight to the wire is the
    # one shape where the redactor and the length cap both silently do nothing —
    # and it is a shape real instrumentation writes. If any element redacts away
    # entirely the whole attribute goes: a sparse list is a hole a consumer
    # cannot interpret, and failing closed is the rule everywhere else here.
    if isinstance(value, (list, tuple)):
        kept: list[object] = []
        for entry in value:
            if not isinstance(entry, str):
                kept.append(entry)
                continue
            redacted = _redact_string(entry, key, policy)
            if redacted is None:
                return None
            kept.append(redacted)
        return kept  # type: ignore[return-value]

    return value


def _redact_string(value: str, key: str, policy: ContentPolicy) -> str | None:
    """The single-value pass: the customer's redactor, then the hard length cap."""
    try:
        redacted = value if policy.redact is None else policy.redact(value, key)
        if redacted is None:
            return None
        # Inside the same guard as the call: a redactor that returns something
        # other than a string is the same failure as one that raises, and it
        # must not become a customer's exception either.
        return truncate(redacted, policy.max_length)
    except Exception:  # noqa: BLE001 - a broken redactor must fail closed, not crash the export
        return "[redaction-failed]"


def is_denied_resource_attribute(key: str) -> bool:
    """Resource attributes nobody asked for.

    Some default detectors ship the full argv, which is a well-known place for
    secrets in real deployments, plus host and process identity we have no use
    for. Scrubbed at the same chokepoint because it is the same problem: data
    leaving that nobody chose to send. The list is the contract's, so a customer
    without our SDK gets the same scrub at ingest.
    """
    return key in _RESOURCE_DENY_SET


def content_attributes(capture: ContentCapture) -> AttributeMap:
    """The capture level as the attribute the contract declares for it."""
    return {ATTR_OCTIC_CONTENT_CAPTURE: capture}
