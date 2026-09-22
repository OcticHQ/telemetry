"""The pipeline, pre-assembled.

Ships no instrumentation. The consumer brings their own; ``OcticSpanProcessor``
enriches whatever they bring.

    init()                          creates and registers the global TracerProvider
    init_with_external_provider()   when another SDK owns it — returns the parts to
                                    hand over, and is not complete until you do

The chain is the same in both modes, and the order is the design:

    SafeSpanExporter( RedactingSpanExporter( SpoolingSpanExporter( Spool ) ) )

The redactor sits outside the spool so nothing reaches disk that the content
policy has not already seen, and the safe wrapper sits outside everything so no
link can raise into whoever called ``export()``.

This is the Node ``init.ts`` minus everything this release does not have: no
credential, no HTTP, no logs signal and no loader hook. What it keeps is the part
that was expensive to learn — run once, never raise, and never register a
lifecycle hook in somebody else's process.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal

from opentelemetry import trace
from opentelemetry.context import Context
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan, Span, SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExporter, SpanExportResult

from . import silence_watch
from .agent import Agent, agent_attributes
from .attributes import (
    ATTR_OCTIC_SCHEMA_VERSION,
    ATTR_OCTIC_SDK_NAME,
    ATTR_OCTIC_SDK_VERSION,
    ATTR_SERVICE_NAME,
    ATTR_SERVICE_VERSION,
    OCTIC_SCHEMA_VERSION,
)
from .attributes_gen import ATTR_DEPLOYMENT_ENVIRONMENT_NAME
from .batching import BatchOptions
from .content import ContentOptions, ContentPolicy, resolve_policy, set_active_policy
from .counters import debug_enabled
from .processor import OcticSpanProcessor
from .redacting_exporter import RedactingSpanExporter
from .safe_exporter import SafeSpanExporter
from .safe_processor import SafeSpanProcessor
from .spool import ManifestInput, Spool, SpoolOptions, SpoolStats
from .spool_exporter import SpoolingSpanExporter
from .version import SDK_NAME, SDK_VERSION

log = logging.getLogger("octic_telemetry")

#: Where the reader delivers, recorded in the spool manifest.
#:
#: ``SPOOL.md`` v1 requires the field and hashes it into the manifest id, so it
#: has to have a value — but this SDK never contacts it, so making a consumer
#: supply one was asking for a decision they have no way to make. Override it
#: only if your telemetry goes somewhere other than Octic's ingest.
DEFAULT_ENDPOINT = "https://ingest.octic.ai"


class SpoolHandle:
    """The public view of the spool, so nothing outside this package holds the object.

    There is no ``flush()`` here, unlike Node's handle: writes are synchronous,
    so the spool never holds anything. What holds spans is the batch processor,
    and ``Telemetry.force_flush()`` is what drains that.
    """

    def __init__(self, spool: Spool) -> None:
        self._spool = spool

    def directory(self) -> str | None:
        """``None`` until the first batch resolves it, and if nothing usable was found."""
        return self._spool.directory

    def stats(self) -> SpoolStats:
        return self._spool.stats()


@dataclass
class _Parts:
    resource: Resource
    #: The enricher, guarded. Stamps provenance per span only in external mode.
    span_processor: SpanProcessor
    #: The whole redacting, spooling chain, guarded.
    span_exporter: SpanExporter
    #: A guarded ``BatchSpanProcessor`` over ``span_exporter``.
    export_processor: SpanProcessor
    policy: ContentPolicy
    spool: Spool


def _configure_debug_logging() -> None:
    """``OCTIC_TELEMETRY_DEBUG=1`` makes this package's log lines visible.

    Otherwise no handler is added: logging is the application's to configure,
    and a library that attaches handlers duplicates every line of a host that
    already has them.
    """
    if not debug_enabled():
        return
    if any(getattr(handler, "_octic", False) for handler in log.handlers):
        return
    handler = logging.StreamHandler()
    handler._octic = True  # type: ignore[attr-defined]
    handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    log.addHandler(handler)
    log.setLevel(logging.DEBUG)


def _setup(
    *,
    service_name: str,
    endpoint: str,
    service_version: str,
    agent: Agent | None,
    environment: str | None,
    resource_attributes: Mapping[str, str] | None,
    content: ContentOptions | None,
    spool: SpoolOptions | None,
    batch: BatchOptions | None,
    provenance_on_spans: bool,
) -> _Parts:
    """Builds every part and registers nothing global except the content policy.

    ``provenance_on_spans`` is for the case where a host SDK owns the provider:
    the resource then belongs to that SDK, so the agent, environment and SDK
    version would never reach a span. The processor applies them per span instead.
    """
    _configure_debug_logging()

    provenance: dict[str, str] = {
        # Which version of the attribute contract these spans were written
        # against. Without it a missing attribute and an older SDK are
        # indistinguishable.
        ATTR_OCTIC_SCHEMA_VERSION: OCTIC_SCHEMA_VERSION,
        # From version.py, never a literal: Node shipped `0.0.0` on the wire for
        # exactly that mistake.
        ATTR_OCTIC_SDK_NAME: SDK_NAME,
        ATTR_OCTIC_SDK_VERSION: SDK_VERSION,
    }
    if environment is not None:
        provenance[ATTR_DEPLOYMENT_ENVIRONMENT_NAME] = environment
    if agent is not None:
        provenance.update({key: str(value) for key, value in agent_attributes(agent).items()})

    # `Resource.create` rather than `Resource(...)`: it adds OpenTelemetry's own
    # `telemetry.sdk.*` block and honours `OTEL_RESOURCE_ATTRIBUTES`, which is
    # what a Python operator expects. What is passed here wins over both.
    resource = Resource.create(
        {
            ATTR_SERVICE_NAME: service_name,
            ATTR_SERVICE_VERSION: service_version,
            **provenance,
            **dict(resource_attributes or {}),
        }
    )

    # Set before anything can emit: the annotations read it to decide whether to
    # serialize their input and output at all.
    policy = resolve_policy(content)
    set_active_policy(policy)

    # Armed by the first span, not by this call — a process that legitimately
    # produces no telemetry has nothing to warn about.
    silence_watch.configure()

    spool_instance = Spool(
        spool or SpoolOptions(),
        ManifestInput(
            endpoint=endpoint,
            service_name=service_name,
            octic_schema_version=OCTIC_SCHEMA_VERSION,
            sdk_name=SDK_NAME,
            sdk_version=SDK_VERSION,
            content_capture=policy.capture,
        ),
    )
    span_exporter = SafeSpanExporter(
        RedactingSpanExporter(SpoolingSpanExporter(spool_instance), policy)
    )

    # Batch, always — never Simple. `SimpleSpanProcessor` exports on the thread
    # that ended the span, which is a customer's request thread, and a blocking
    # disk write there is their latency. Every field is passed so no `OTEL_BSP_*`
    # variable can fill one in; see batching.py.
    settings = batch or BatchOptions()
    export_processor = SafeSpanProcessor(
        BatchSpanProcessor(
            span_exporter,
            max_queue_size=settings.max_queue_size,
            schedule_delay_millis=settings.schedule_delay_millis,
            max_export_batch_size=settings.max_export_batch_size,
            export_timeout_millis=settings.export_timeout_millis,
        )
    )

    return _Parts(
        resource=resource,
        span_processor=SafeSpanProcessor(
            OcticSpanProcessor(provenance if provenance_on_spans else None)
        ),
        span_exporter=span_exporter,
        export_processor=export_processor,
        policy=policy,
        spool=spool_instance,
    )


class Telemetry:
    """What ``init()`` returns. Both methods are safe to call more than once and
    neither raises."""

    def __init__(
        self,
        *,
        flush_target: SpanProcessor | TracerProvider | None,
        spool: Spool | None,
    ) -> None:
        self._flush_target = flush_target
        self.spool: SpoolHandle | None = None if spool is None else SpoolHandle(spool)

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        """Writes everything queued to the spool, on the calling thread."""
        if self._flush_target is None:
            return True
        try:
            return bool(self._flush_target.force_flush(timeout_millis))
        except Exception:
            log.warning("octic-telemetry: flushing did not complete cleanly", exc_info=True)
            return False

    def shutdown(self) -> None:
        """Flushes and stops the pipeline. Call it from your own shutdown path.

        Latched, because a consumer with both a signal handler and a ``finally``
        has two callers, and both are right to call it. Bounded by the batch
        processor's export timeout.
        """
        _shutdown_once(self._flush_target)


@dataclass
class ExternalProviderTelemetry:
    """The parts to hand to the SDK that owns the tracer provider.

    Hand over ``span_processor`` and ``export_processor``, in that order. Until
    both reach the host's provider, no span is enriched and none is written.
    """

    #: The enricher, guarded so it cannot raise into the host SDK's ``start_span``.
    span_processor: SpanProcessor
    #: A batch processor over ``span_exporter``: **the one to hand over**. It is
    #: how "batch, never simple" survives a host that arranges its own processors.
    export_processor: SpanProcessor
    #: For a host that only accepts an exporter. Wrap it in a
    #: ``BatchSpanProcessor``, never a ``SimpleSpanProcessor`` — Simple writes to
    #: disk on the thread that ended the span.
    span_exporter: SpanExporter
    #: For host SDKs with their own content switch — pass it through so content is
    #: never produced rather than produced and stripped.
    capture_content: bool
    spool: SpoolHandle | None = None
    _flush_target: SpanProcessor | None = field(default=None, repr=False)

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        """Drains ``export_processor``. Spans in the host's own processors are the host's."""
        if self._flush_target is None:
            return True
        try:
            return bool(self._flush_target.force_flush(timeout_millis))
        except Exception:
            log.warning("octic-telemetry: flushing did not complete cleanly", exc_info=True)
            return False

    def shutdown(self) -> None:
        """Stops ``export_processor`` and closes the spool. Call it after the host
        SDK's own shutdown, which is the only signal we get that the process is
        stopping — anything the host exports through ``span_exporter`` after this
        is refused."""
        _shutdown_once(self._flush_target)


_StateKind = Literal["own", "external", "degraded", "failed"]


@dataclass
class _State:
    """What this process has already done, so it is never done twice.

    ``_setup()`` is not idempotent, and its non-idempotence is invisible rather
    than loud: Python's ``set_tracer_provider`` *ignores* a second registration
    with a log line, a second ``set_active_policy`` re-points the global policy
    while the first pipeline's exporter still holds the old one, and a second
    ``Spool`` would take custody of the same directory with its own accounting.

    ``degraded`` is the case worth naming: the parts were built and something
    after them did not work out, so the handle keeps the halves that exist rather
    than orphaning a live batch processor nothing could then flush or stop.
    """

    kind: _StateKind
    parts: _Parts | None = None
    provider: TracerProvider | None = None


_state_lock = threading.Lock()
_state: _State | None = None
_shutdown_lock = threading.Lock()
_shut_down = False


def _shutdown_once(target: SpanProcessor | TracerProvider | None) -> None:
    global _shut_down
    with _shutdown_lock:
        if _shut_down:
            return
        _shut_down = True
        # Before the flush: the pipeline is stopping, so silence is expected.
        silence_watch.cancel()
        if target is None:
            return
        try:
            target.shutdown()
        except Exception:
            log.warning("octic-telemetry: shutdown did not complete cleanly", exc_info=True)


def _flush_target(state: _State) -> SpanProcessor | TracerProvider | None:
    if state.provider is not None:
        return state.provider
    return None if state.parts is None else state.parts.export_processor


def _telemetry_from(state: _State) -> Telemetry:
    return Telemetry(
        flush_target=_flush_target(state),
        spool=None if state.parts is None else state.parts.spool,
    )


class _InertProcessor(SpanProcessor):
    """Enough of a processor to be handed to a host SDK that will call it."""

    def on_start(self, span: Span, parent_context: Context | None = None) -> None:
        return

    def on_end(self, span: ReadableSpan) -> None:
        return

    def shutdown(self) -> None:
        return

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        return True


class _InertExporter(SpanExporter):
    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        return SpanExportResult.FAILURE

    def shutdown(self) -> None:
        return

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        return True


def _external_from(state: _State) -> ExternalProviderTelemetry:
    parts = state.parts
    if parts is None:
        return ExternalProviderTelemetry(
            span_processor=_InertProcessor(),
            export_processor=_InertProcessor(),
            span_exporter=_InertExporter(),
            capture_content=False,
        )
    return ExternalProviderTelemetry(
        span_processor=parts.span_processor,
        export_processor=parts.export_processor,
        span_exporter=parts.span_exporter,
        capture_content=parts.policy.capture != "none",
        spool=SpoolHandle(parts.spool),
        _flush_target=parts.export_processor,
    )


def _already_initialized(state: _State, wanted: _StateKind) -> None:
    """Warns about a second call. The caller then hands back what the first built."""
    if state.kind == "failed":
        log.warning(
            "octic-telemetry: a previous init() failed; returning the same inert handle "
            "rather than retrying. Set OCTIC_TELEMETRY_DEBUG=1 to see the original failure."
        )
    elif state.kind == wanted:
        log.warning("octic-telemetry: already initialized; returning the existing handle.")
    else:
        log.warning(
            'octic-telemetry: already initialized in "%s" mode; ignoring this "%s" call and '
            "reusing the existing pipeline. Per-span provenance may be missing.",
            state.kind,
            wanted,
        )


def init(
    *,
    service_name: str,
    endpoint: str = DEFAULT_ENDPOINT,
    service_version: str = "0.0.0",
    agent: Agent | None = None,
    environment: str | None = None,
    resource_attributes: Mapping[str, str] | None = None,
    content: ContentOptions | None = None,
    spool: SpoolOptions | None = None,
    batch: BatchOptions | None = None,
) -> Telemetry:
    """Creates, configures and registers the global tracer provider.

    ``endpoint`` is not contacted and defaults to Octic's ingest. It is written
    into the spool manifest, which is how the reader knows where to deliver.
    Never raises; a failure leaves the process without telemetry and says so
    once.
    """
    global _state
    with _state_lock:
        if _state is not None:
            _already_initialized(_state, "own")
            return _telemetry_from(_state)

        parts: _Parts | None = None
        try:
            parts = _setup(
                service_name=service_name,
                endpoint=endpoint,
                service_version=service_version,
                agent=agent,
                environment=environment,
                resource_attributes=resource_attributes,
                content=content,
                spool=spool,
                batch=batch,
                provenance_on_spans=False,
            )

            # Python ignores a second `set_tracer_provider` with one log line, so
            # checking first is the only way to find out. Building a provider
            # nothing will ever reach and reporting success would be the silent
            # failure this package exists to remove.
            if not isinstance(trace.get_tracer_provider(), trace.ProxyTracerProvider):
                log.warning(
                    "octic-telemetry: another SDK already registered the global tracer "
                    "provider, so init() cannot. Use init_with_external_provider() and hand "
                    "its processors to that SDK instead."
                )
                _state = _State(kind="degraded", parts=parts)
                return _telemetry_from(_state)

            # `shutdown_on_exit=False`: the default registers an `atexit` hook,
            # and a library must not decide how its host exits.
            provider = TracerProvider(resource=parts.resource, shutdown_on_exit=False)
            provider.add_span_processor(parts.span_processor)
            provider.add_span_processor(parts.export_processor)
            trace.set_tracer_provider(provider)
            _state = _State(kind="own", parts=parts, provider=provider)
        except Exception:
            log.error(
                "octic-telemetry: init() failed; telemetry is disabled for this process",
                exc_info=True,
            )
            _state = _State(kind="failed" if parts is None else "degraded", parts=parts)
        return _telemetry_from(_state)


def init_with_external_provider(
    *,
    service_name: str,
    endpoint: str = DEFAULT_ENDPOINT,
    service_version: str = "0.0.0",
    agent: Agent | None = None,
    environment: str | None = None,
    resource_attributes: Mapping[str, str] | None = None,
    content: ContentOptions | None = None,
    spool: SpoolOptions | None = None,
    batch: BatchOptions | None = None,
) -> ExternalProviderTelemetry:
    """Creates no provider. Until ``span_processor`` and ``export_processor`` reach
    the SDK that owns the provider, no span is written."""
    global _state
    with _state_lock:
        if _state is not None:
            _already_initialized(_state, "external")
            return _external_from(_state)
        try:
            _state = _State(
                kind="external",
                parts=_setup(
                    service_name=service_name,
                    endpoint=endpoint,
                    service_version=service_version,
                    agent=agent,
                    environment=environment,
                    resource_attributes=resource_attributes,
                    content=content,
                    spool=spool,
                    batch=batch,
                    provenance_on_spans=True,
                ),
            )
        except Exception:
            log.error(
                "octic-telemetry: init_with_external_provider() failed; telemetry is "
                "disabled for this process",
                exc_info=True,
            )
            _state = _State(kind="failed")
        return _external_from(_state)
