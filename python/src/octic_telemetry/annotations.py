"""Run-scoped annotations: the part no instrumentation can produce for us.

Patching a provider SDK can only ever see one HTTP call. It cannot know that five
of those calls were one agent doing one job, which is why an unannotated two-call
run arrives as two unrelated traces. Only the application knows where the work
starts and ends, so only the application can say so.

Each annotation is one object usable four ways — ``with``, ``async with``, and as
a decorator over a sync or an async function:

    with with_workflow(name="chat-turn", input=payload) as run:
        result = do_work()
        run.set_output(result)

    @with_tool(name="lookup_account")
    def lookup(account_id: str) -> dict: ...

The ``with`` forms set the output explicitly because a block has no return value
to read. The decorator forms take it from what the function returned.

Note that ``input`` is an explicit parameter rather than something inferred from
the decorated function's arguments. A wrapper that serializes the wrapped
callable's arguments records nothing when it is handed a zero-argument closure —
which is exactly what a measured vendor wrapper does, producing a tool span whose
input reads as an empty argument list. Making the input explicit removes the trap.
"""

from __future__ import annotations

import functools
import inspect
import json
from collections.abc import Awaitable, Callable, Mapping
from contextlib import ExitStack
from dataclasses import dataclass
from types import TracebackType
from typing import Any, TypeVar, cast

from opentelemetry import trace
from opentelemetry.sdk.trace import Span
from opentelemetry.util.types import AttributeValue

from .attributes import (
    ATTR_GEN_AI_DATA_SOURCE_ID,
    ATTR_GEN_AI_OPERATION_NAME,
    ATTR_GEN_AI_RETRIEVAL_QUERY_TEXT,
    ATTR_GEN_AI_TOOL_NAME,
    ATTR_GEN_AI_TOOL_TYPE,
    ATTR_GEN_AI_WORKFLOW_NAME,
    ATTR_OCTIC_ENTITY_INPUT,
    ATTR_OCTIC_ENTITY_OUTPUT,
    ATTR_OCTIC_TARGET_ASSET_REF,
    ATTR_OCTIC_TARGET_NAME,
    ATTR_OCTIC_TARGET_TYPE,
    GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
    GEN_AI_OPERATION_NAME_VALUE_INVOKE_WORKFLOW,
    GEN_AI_OPERATION_NAME_VALUE_RETRIEVAL,
    GEN_AI_TOOL_TYPE_VALUE_FUNCTION,
    OCTIC_CONTENT_CAPTURE_VALUE_NONE,
)
from .content import current_capture, truncate
from .run import Run, mint_run_id, run_scope
from .version import SDK_NAME, SDK_VERSION

# The instrumentation scope our own annotation spans are created under.
#
# It is the SDK's name and version, not a third pair: the scope on a span and the
# `octic.sdk.*` pair on its resource then cannot disagree about who wrote it, and
# the exporter's foreign-span test is reading the same contract-owned vocabulary
# that produced them.
TRACER_NAME = SDK_NAME
TRACER_VERSION = SDK_VERSION

# Attributes have to be primitives, and an unbounded blob is nobody's friend.
MAX_SERIALIZED = 8192

T = TypeVar("T")


@dataclass(frozen=True)
class Target:
    """What a span touched: a datastore, another service, an external tool.

    The governance product needs this per span, not per run — "this agent read
    the transactions store" is a different statement from "this agent ran".
    """

    name: str
    #: One of the contract's target types.
    type: str | None = None
    #: The graph join key, so a policy can be evaluated against what was touched.
    asset_ref: str | None = None


def _serialize(value: object) -> str:
    try:
        text = value if isinstance(value, str) else json.dumps(value, default=str)
    except (TypeError, ValueError):
        return "[unserializable]"
    return truncate(text, MAX_SERIALIZED)


def _capture_content(value: object) -> str | None:
    """Our own content is the one kind we can decline to produce.

    Worth doing rather than producing it and stripping it later: serializing an
    8KB object costs real CPU, and a value that was never created cannot escape
    through a bug in the exporter. Above the lowest level the raw value is
    serialized here and the exporter applies the capture level, so the transform
    lives in exactly one place.
    """
    if current_capture() == OCTIC_CONTENT_CAPTURE_VALUE_NONE:
        return None
    return _serialize(value)


def _target_attributes(target: Target | None) -> dict[str, AttributeValue]:
    if target is None:
        return {}
    attributes: dict[str, AttributeValue] = {ATTR_OCTIC_TARGET_NAME: target.name}
    if target.type is not None:
        attributes[ATTR_OCTIC_TARGET_TYPE] = target.type
    if target.asset_ref is not None:
        attributes[ATTR_OCTIC_TARGET_ASSET_REF] = target.asset_ref
    return attributes


class AnnotationScope:
    """The handle a ``with`` block gets. Carries the span and the run id."""

    __slots__ = ("run_id", "span")

    def __init__(self, span: Span, run_id: str | None) -> None:
        self.span = span
        self.run_id = run_id

    def set_output(self, value: object) -> None:
        """Record what this unit of work produced, subject to the content policy."""
        captured = _capture_content(value)
        if captured is not None:
            self.span.set_attribute(ATTR_OCTIC_ENTITY_OUTPUT, captured)


class _Annotation:
    """One annotation, entered as a block or applied as a decorator.

    The attributes are built in :meth:`_open` rather than in the constructor,
    because the content policy can be set after import and a decorator is
    constructed at import time. Serializing the input when the decorator was
    *defined* would record content under whatever level happened to be in force
    before the application configured one.
    """

    __slots__ = (
        "_extra",
        "_input",
        "_input_key",
        "_mints_run",
        "_name",
        "_name_key",
        "_operation",
        "_run_id",
        "_scopes",
        "_stacks",
        "_target",
    )

    def __init__(
        self,
        operation: str,
        name: str,
        name_key: str,
        input_key: str,
        input_value: object,
        target: Target | None,
        extra: Mapping[str, AttributeValue] | None = None,
        *,
        mints_run: bool = False,
        run_id: str | None = None,
    ) -> None:
        self._operation = operation
        self._name = name
        self._name_key = name_key
        self._input_key = input_key
        self._input = input_value
        self._target = target
        self._extra = dict(extra or {})
        self._mints_run = mints_run
        self._run_id = run_id
        self._stacks: list[ExitStack] = []
        self._scopes: list[AnnotationScope] = []

    def _attributes(self) -> dict[str, AttributeValue]:
        attributes: dict[str, AttributeValue] = {
            **self._extra,
            **_target_attributes(self._target),
            ATTR_GEN_AI_OPERATION_NAME: self._operation,
            self._name_key: self._name,
        }
        if self._input is not None:
            captured = _capture_content(self._input)
            if captured is not None:
                attributes[self._input_key] = captured
        return attributes

    def _open(self) -> AnnotationScope:
        run_id = self._run_id
        if run_id is None and self._mints_run:
            run_id = mint_run_id(self._name)

        stack = ExitStack()
        if run_id is not None:
            # The run scope wraps the span rather than the other way round, so
            # every span started underneath carries the run id whether or not it
            # is a direct child — and so a consumer can attribute any span to its
            # run without walking the parent chain.
            stack.enter_context(run_scope.bind(Run(id=run_id)))

        tracer = trace.get_tracer(TRACER_NAME, TRACER_VERSION)
        span = stack.enter_context(
            tracer.start_as_current_span(
                f"{self._operation} {self._name}",
                attributes=self._attributes(),
                # Upstream's default writes `exception.message` and
                # `exception.stacktrace` into a span event, which is content
                # arriving without anyone deciding to send it. The status is
                # still set on an escaping exception, which costs nothing and is
                # right: "this run failed" survives at every capture level.
                record_exception=False,
            )
        )
        self._stacks.append(stack)
        scope = AnnotationScope(cast(Span, span), run_id)
        self._scopes.append(scope)
        return scope

    def _close(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self._scopes.pop()
        # The customer's exception, unchanged — same object, same traceback, same
        # `__cause__`. Recording it is telemetry, and telemetry is never allowed
        # to alter it, so the stack unwinds with the exception in hand and raises
        # nothing of its own.
        self._stacks.pop().__exit__(exc_type, exc, traceback)

    def __enter__(self) -> AnnotationScope:
        return self._open()

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self._close(exc_type, exc, traceback)

    async def __aenter__(self) -> AnnotationScope:
        return self._open()

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self._close(exc_type, exc, traceback)

    def __call__(self, fn: Callable[..., Any]) -> Callable[..., Any]:
        """Decorator form. The return value becomes the recorded output.

        A decorated workflow called twice is two runs, so the id is minted per
        invocation rather than shared by everything the decorator wraps.
        """
        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def async_wrapper(*args: object, **kwargs: object) -> object:
                async with self._copy() as scope:
                    result = await cast(Callable[..., Awaitable[object]], fn)(*args, **kwargs)
                    if result is not None:
                        scope.set_output(result)
                    return result

            return async_wrapper

        @functools.wraps(fn)
        def wrapper(*args: object, **kwargs: object) -> object:
            with self._copy() as scope:
                result = fn(*args, **kwargs)
                if result is not None:
                    scope.set_output(result)
                return result

        return wrapper

    def _copy(self) -> _Annotation:
        """One per invocation: a decorated function may be called concurrently,
        and one object holding one span is the shape that breaks when it is."""
        return _Annotation(
            self._operation,
            self._name,
            self._name_key,
            self._input_key,
            self._input,
            self._target,
            self._extra,
            mints_run=self._mints_run,
            run_id=self._run_id,
        )


def with_workflow(
    *,
    name: str,
    input: object = None,  # noqa: A002 - "input" is the contract's word for it
    target: Target | None = None,
    run_id: str | None = None,
) -> _Annotation:
    """One unit of agent work — the root span the model calls nest under.

    This is the span that makes a run visible as a run. It also opens the run
    scope, so every span underneath carries the run id and whoever created it.
    Supply ``run_id`` to correlate with an id the application already minted.
    """
    return _Annotation(
        GEN_AI_OPERATION_NAME_VALUE_INVOKE_WORKFLOW,
        name,
        ATTR_GEN_AI_WORKFLOW_NAME,
        ATTR_OCTIC_ENTITY_INPUT,
        input,
        target,
        mints_run=True,
        run_id=run_id,
    )


def with_tool(
    *,
    name: str,
    input: object = None,  # noqa: A002 - "input" is the contract's word for it
    target: Target | None = None,
    tool_type: str | None = None,
) -> _Annotation:
    """One tool execution. Plain application code, invisible to instrumentation.

    ``tool_type`` is what kind of thing the *model* called, and it defaults to a
    plain function, which is what this wraps. It is deliberately not derived from
    ``target.type``: that answers a different question — what the tool reached,
    which is the asset-graph one — and feeding it here is what makes our spans
    disagree with a vendor's about the same call.
    """
    return _Annotation(
        GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
        name,
        ATTR_GEN_AI_TOOL_NAME,
        ATTR_OCTIC_ENTITY_INPUT,
        input,
        target,
        {ATTR_GEN_AI_TOOL_TYPE: tool_type or GEN_AI_TOOL_TYPE_VALUE_FUNCTION},
    )


def with_retrieval(
    *,
    name: str,
    input: object = None,  # noqa: A002 - "input" is the contract's word for it
    target: Target | None = None,
) -> _Annotation:
    """One retrieval — a vector search, a document lookup, anything that fetched
    context for the model.

    A text query goes on the semantic convention's query key, which only promises
    to carry text; anything else goes on the generic entity input, which is honest
    about being arbitrary. The *result* deliberately does not go on the matching
    documents key: this wrapper records whatever the application produced, and
    calling that "documents" would assert a shape nobody validates.
    """
    return _Annotation(
        GEN_AI_OPERATION_NAME_VALUE_RETRIEVAL,
        name,
        ATTR_GEN_AI_DATA_SOURCE_ID,
        ATTR_GEN_AI_RETRIEVAL_QUERY_TEXT if isinstance(input, str) else ATTR_OCTIC_ENTITY_INPUT,
        input,
        target,
    )
