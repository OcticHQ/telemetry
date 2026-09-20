"""The mechanism this whole package is built on.

``SpanProcessor.on_start`` fires for *every* span the tracer provider creates —
including spans created by instrumentation that has never heard of us. It
receives the Context the span was started in, which is where the scopes put their
values.

That is what makes "bring your own instrumentation" viable: we do not need to
patch, wrap or even know about a vendor's OpenTelemetry package. We only need its
spans to be created through the registered tracer provider, and enriching them is
then a hook the SDK already offers us.

Four scopes share one loop. That the list grew from one to four without the
mechanism changing is the evidence that it generalises: identity was not a
special case, it was the first instance of the pattern.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Protocol

from opentelemetry.context import Context
from opentelemetry.sdk.trace import ReadableSpan, Span, SpanProcessor
from opentelemetry.util.types import AttributeValue

from .agent import agent_scope
from .attributes import ATTR_OCTIC_CONTENT_CAPTURE
from .content import active_policy, content_scope, record_span_capture
from .context_scope import AttributeMap
from .identity import identity_scope
from .prompt import prompt_scope
from .run import run_scope
from .sanitize import sanitize_attributes


class _AttributeSource(Protocol):
    """Structural, so the loop below does not care which scope it is holding."""

    def attributes_from(self, context: Context | None = None) -> AttributeMap | None: ...


# Listed explicitly rather than self-registered on creation. A registry populated
# by import side effects would depend on every scope module having been loaded
# before the first span starts — silently stamping nothing when it has not, which
# is exactly the class of failure this package exists to remove.
#
# The content scope is deliberately not in this list. It carries policy rather
# than data, so it is resolved separately below: always, and not only when an
# override happens to be open. See `on_start`.
_SCOPES: Sequence[_AttributeSource] = (identity_scope, agent_scope, run_scope, prompt_scope)


class OcticSpanProcessor(SpanProcessor):
    """Stamps the contract's attributes onto every span the provider creates.

    Enrichment only — export is somebody else's processor.
    """

    def __init__(self, defaults: Mapping[str, object] | None = None) -> None:
        """``defaults`` are attributes that would normally live on the resource.

        Applied per span instead, which is what the external-provider case needs:
        when a host SDK owns the tracer provider the resource is *theirs*, and
        everything we would have put on ours — the agent, the environment, which
        SDK produced this — never reaches a span.

        Applied before the context scopes, so a per-run agent scope still wins.
        Fixed for the life of the process, so it is sanitized once here rather
        than on every span.
        """
        sanitized, _ = sanitize_attributes(dict(defaults or {}))
        self._defaults: dict[str, AttributeValue] = sanitized

    def on_start(self, span: Span, parent_context: Context | None = None) -> None:
        span.set_attributes(self._defaults)

        # The scope maps go through the sanitizer first — not because
        # `set_attribute` would raise on a bad value (it does not; see
        # sanitize.py) but because it would drop one without telling anyone whose
        # value it was. These maps are ours, so the accounting is ours.
        for scope in _SCOPES:
            attributes = scope.attributes_from(parent_context)
            if attributes:
                clean, _ = sanitize_attributes(dict(attributes))
                span.set_attributes(clean)

        # The capture level, recorded off-span as well as on it, for every span
        # rather than only when an override is open.
        #
        # Both halves matter. Recording against the span object is what makes the
        # level unforgeable at export — an attribute is writable by anyone who
        # can write attributes. Stamping unconditionally closes the same hole
        # from the other side: span-option attributes are applied when the span
        # is constructed and `on_start` runs after, so writing here overwrites
        # whatever the caller supplied rather than leaving it in place whenever
        # no scope happens to be open.
        #
        # Only the override is recorded. The resolved level would make this
        # processor's view of the default outrank the policy the exporter holds,
        # which are not the same object in every arrangement; the exporter owns
        # the fallback. The attribute stays because the contract declares it and
        # a host SDK that copies spans before export loses the weak-map entry —
        # and it is stripped before the span leaves either way.
        override = content_scope.from_context(parent_context)
        record_span_capture(span, override)
        span.set_attribute(ATTR_OCTIC_CONTENT_CAPTURE, override or active_policy().capture)

    # `SpanProcessor` requires all three, and this one owns no queue, no
    # transport and no timer, so there is genuinely nothing for them to do. Empty
    # on purpose, not unfinished.

    def on_end(self, span: ReadableSpan) -> None:
        return

    def shutdown(self) -> None:
        return

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        return True
