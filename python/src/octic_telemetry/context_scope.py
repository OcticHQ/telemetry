"""The one pattern this package is built out of.

Identity, agent, run id, prompt template and the content-capture override are
all the same thing: knowledge only the application has, scoped to a region of
execution, that has to end up on spans somebody else created. The mechanism is
always

    put a value on the OTel Context  ->  SpanProcessor.on_start reads it  ->  attributes

and ``on_start`` fires for every span the tracer provider makes, including spans
from instrumentation that has never heard of us. That is the whole architecture,
so it is worth having exactly once.

The alternative — a wrapper span per concept — would work but adds a row to the
waterfall for every piece of metadata, and cannot attach anything to a span that
instrumentation opened and closed on its own.

The value goes on the OTel Context and not on a bare :class:`contextvars.ContextVar`.
A plain ``ContextVar`` is enough for an application and wrong for a library: it
does not ride ``context.attach``, so the moment a host SDK propagates *its*
context across a boundary — a thread pool, a task group, its own instrumentation
— the scopes stop composing and spans come through unstamped.
"""

from __future__ import annotations

from collections.abc import Callable
from types import TracebackType
from typing import Any, Generic, TypeVar, cast

from opentelemetry import context as context_api
from opentelemetry.context import Context
from opentelemetry.util.types import AttributeValue

AttributeMap = dict[str, AttributeValue]

T = TypeVar("T")


class ScopeBinding(Generic[T]):
    """One activation of a scope, usable as ``with`` or ``async with``.

    Both protocols do exactly the same thing — attaching a Context is not I/O
    and never blocks. The async form exists so that a caller writing
    ``async with`` throughout does not have to remember which of our scopes is
    the one that breaks the rhythm.

    A fresh instance per activation, and the token stack is what makes nesting
    the same scope inside itself safe. Do not hold one of these and enter it
    from two tasks at once: build another.
    """

    __slots__ = ("_context", "_tokens")

    def __init__(self, context: Context) -> None:
        self._context = context
        self._tokens: list[Any] = []

    def __enter__(self) -> None:
        self._tokens.append(context_api.attach(self._context))

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        context_api.detach(self._tokens.pop())

    async def __aenter__(self) -> None:
        self.__enter__()

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.__exit__(exc_type, exc, traceback)


class ContextScope(Generic[T]):
    """A typed value carried on the OTel Context and stamped onto spans.

    ``merge`` decides how a nested activation combines with an enclosing one.
    Leave it out to replace. Identity merges — an outer middleware sets the
    conversation and an inner call adds a business id without clobbering it;
    agent and prompt replace, because an inner declaration means "this part is
    different".
    """

    __slots__ = ("_key", "_merge", "_to_attributes")

    def __init__(
        self,
        key: str,
        to_attributes: Callable[[T], AttributeMap],
        merge: Callable[[T, T], T] | None = None,
    ) -> None:
        # Namespaced by the caller, since the Context is shared with everyone.
        self._key = context_api.create_key(key)
        self._to_attributes = to_attributes
        self._merge = merge

    def from_context(self, context: Context | None = None) -> T | None:
        value = context_api.get_value(self._key, context)
        # A cast rather than a runtime check, and the key is what makes it
        # sound: `create_key` mints a unique name and nothing outside this
        # object ever holds it, so nobody else can put a different shape here.
        return None if value is None else cast(T, value)

    def context_with(self, value: T, context: Context | None = None) -> Context:
        existing = self.from_context(context)
        combined = self._merge(existing, value) if existing is not None and self._merge else value
        return context_api.set_value(self._key, combined, context)

    def attributes_from(self, context: Context | None = None) -> AttributeMap | None:
        value = self.from_context(context)
        return None if value is None else self._to_attributes(value)

    def bind(self, value: T) -> ScopeBinding[T]:
        """Attach ``value`` to every span started inside the returned scope."""
        return ScopeBinding(self.context_with(value, context_api.get_current()))
