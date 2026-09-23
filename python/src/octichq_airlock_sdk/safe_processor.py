"""The boundary between this SDK's callbacks and the stack that calls them.

``SpanProcessor.on_start`` is the dangerous one, and it is dangerous because of
*where* it runs, not what it does: the tracer calls it synchronously from inside
``start_span``, which is inside whatever instrumentation created the span, which
is inside the customer's request handler. A raise there does not lose telemetry —
it takes out the call the customer was actually making.

What can reach it, so this is a list rather than a posture: a context-scope value
whose attribute mapping raises (a property on a customer's ``Identity``
subclass, say), an ``attributes`` mapping whose iteration raises, and whatever a
future scope brings. Everything else is defense in depth, which is the correct
posture for a callback registered into somebody else's control flow.

This wraps *our* processors, and only ours. The customer's own code inside
``with_workflow`` is never routed through here.
"""

from __future__ import annotations

import logging

from opentelemetry.context import Context
from opentelemetry.sdk.trace import ReadableSpan, Span, SpanProcessor

from .counters import count

log = logging.getLogger("octichq_airlock_sdk")


def _swallow(where: str) -> None:
    count("processor_errors")
    log.warning("octichq-airlock-sdk: %s failed and was suppressed", where, exc_info=True)


class SafeSpanProcessor(SpanProcessor):
    def __init__(self, inner: SpanProcessor) -> None:
        self._inner = inner

    def on_start(self, span: Span, parent_context: Context | None = None) -> None:
        try:
            self._inner.on_start(span, parent_context)
        except Exception:  # noqa: BLE001 - logged with its traceback in _swallow
            _swallow("on_start")

    def on_end(self, span: ReadableSpan) -> None:
        try:
            self._inner.on_end(span)
        except Exception:  # noqa: BLE001 - logged with its traceback in _swallow
            _swallow("on_end")

    def shutdown(self) -> None:
        # Reachable from the customer's own graceful-shutdown path, where a raise
        # turns a clean stop into a traceback.
        try:
            self._inner.shutdown()
        except Exception:  # noqa: BLE001 - logged with its traceback in _swallow
            _swallow("shutdown")

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        try:
            return self._inner.force_flush(timeout_millis)
        except Exception:  # noqa: BLE001 - logged with its traceback in _swallow
            _swallow("force_flush")
            return False
