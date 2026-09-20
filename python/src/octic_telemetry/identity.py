"""Durable identity — the level above a single agent run.

A conversation spans many HTTP requests, many processes, possibly many days.
That cannot be a span: a span has to start and end inside one process, and a
conversation may never end. So identity is carried on the OTel Context and
stamped onto spans as attributes, with conversation membership resolved by query
later.

Under the governance framing these are filters rather than the headline — the
primary key is the agent, see :mod:`octic_telemetry.agent`. They stay optional
and they stay here, because "what did this customer experience and what did it
cost" is not answerable after the fact if nobody recorded it at the time.

Nothing here emits a span.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field

from .attributes import (
    ATTR_GEN_AI_CONVERSATION_ID,
    ATTR_SESSION_ID,
    ATTR_USER_ID,
    CUSTOMER_ATTRIBUTE_PREFIX,
)
from .context_scope import AttributeMap, ContextScope, ScopeBinding

CustomAttributeValue = str | int | float | bool


@dataclass(frozen=True)
class Identity:
    """Groups runs into something a person can ask a question about."""

    #: Groups many runs, across many requests, into one conversation.
    conversation_id: str | None = None
    #: The end user, as the tenant identifies them. Consider a pseudonymous id.
    user_id: str | None = None
    #: Tenant-side business identifiers, stamped under the customer prefix.
    attributes: Mapping[str, CustomAttributeValue] = field(default_factory=dict)


def _merge(existing: Identity, incoming: Identity) -> Identity:
    return Identity(
        conversation_id=incoming.conversation_id or existing.conversation_id,
        user_id=incoming.user_id or existing.user_id,
        attributes={**existing.attributes, **incoming.attributes},
    )


def _to_attributes(identity: Identity) -> AttributeMap:
    attributes: AttributeMap = {}

    if identity.conversation_id is not None:
        # Written twice on purpose. One is the GenAI-specific name; the other is
        # the general one that non-GenAI tooling already understands. Both are
        # experimental, and which survives is not ours to decide — writing both
        # costs one attribute and avoids a migration.
        attributes[ATTR_GEN_AI_CONVERSATION_ID] = identity.conversation_id
        attributes[ATTR_SESSION_ID] = identity.conversation_id

    if identity.user_id is not None:
        attributes[ATTR_USER_ID] = identity.user_id

    # Under the customer prefix, never the bare reserved one.
    #
    # These are the tenant's strings, and the reserved namespace is ours. With
    # one prefix a tenant passing a key that happens to collide with one of ours
    # would win, because span-option attributes are applied when the span is
    # constructed while this stamps in `on_start`, which runs after — so the
    # graph join key was overwritable by a caller who had no idea it existed.
    # Two prefixes make the collision unrepresentable rather than merely
    # unlikely. See AGENTS.md rule 7.
    for key, value in identity.attributes.items():
        attributes[f"{CUSTOMER_ATTRIBUTE_PREFIX}{key}"] = value

    return attributes


identity_scope = ContextScope[Identity](
    key="octic.identity",
    to_attributes=_to_attributes,
    merge=_merge,
)


def with_identity(
    *,
    conversation_id: str | None = None,
    user_id: str | None = None,
    attributes: Mapping[str, CustomAttributeValue] | None = None,
) -> ScopeBinding[Identity]:
    """Attach identity to every span started inside the returned scope.

    Usually set once at the request boundary rather than around each agent call,
    and it merges with anything already open — an outer middleware can name the
    conversation and an inner call can add a business id without clobbering it.
    """
    return identity_scope.bind(
        Identity(
            conversation_id=conversation_id,
            user_id=user_id,
            attributes=attributes or {},
        )
    )


def current_identity() -> Identity | None:
    """The identity in effect right here, if any."""
    return identity_scope.from_context()
