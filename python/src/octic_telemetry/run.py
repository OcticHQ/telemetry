"""The run id — one agent run, named by something a person can quote.

A trace id would technically identify a run, but it is opaque, chosen by the SDK
rather than the application, and unusable as the thing a ticket refers to or a
later write — an evaluation score, a thumbs-up arriving an hour after the trace
closed — keys off. So the id has to be ours to mint.

It lives in its own scope, separate from the annotation that sets it, because the
workflow annotation writes it and the processor reads it; putting it in
:mod:`octic_telemetry.annotations` would make the two import each other.

Scoping it rather than only stamping the workflow span is what lets a consumer
attribute any span to its run without walking the parent chain.
"""

from __future__ import annotations

import re
import secrets
from dataclasses import dataclass

from .attributes import ATTR_OCTIC_RUN_ID
from .context_scope import AttributeMap, ContextScope, ScopeBinding

_NOT_SLUG = re.compile(r"[^a-z0-9]+")


@dataclass(frozen=True)
class Run:
    id: str


def _to_attributes(run: Run) -> AttributeMap:
    return {ATTR_OCTIC_RUN_ID: run.id}


run_scope = ContextScope[Run](key="octic.run", to_attributes=_to_attributes)


def current_run_id() -> str | None:
    """The run id in effect right now.

    Read it inside a workflow annotation to log it or return it in the response.
    The annotation deliberately does not hand it back — it returns whatever the
    wrapped work returns, and distorting that to carry metadata would make every
    call site unwrap a tuple for the benefit of the few that care.
    """
    run = run_scope.from_context()
    return None if run is None else run.id


def _slug(name: str) -> str:
    return _NOT_SLUG.sub("-", name.lower()).strip("-")[:24] or "run"


def mint_run_id(name: str) -> str:
    """`run-chat-turn-a3f9c1`. Readable prefix, enough entropy to not collide."""
    return f"run-{_slug(name)}-{secrets.token_hex(8)}"


def with_run(run_id: str) -> ScopeBinding[Run]:
    """Adopt an id the application already minted for every span started inside."""
    return run_scope.bind(Run(id=run_id))
