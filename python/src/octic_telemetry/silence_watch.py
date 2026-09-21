"""One warning, once, when spans are being produced and no segment is being written.

Node's version fires when spans are produced and none *arrives* over the network.
With a spool, nothing arriving over the network is the designed steady state, so
the question is reframed to the one this SDK can answer: have spans started, and
has any batch reached the spool since?

The signal has to fire on *silence*, not on error. Every failure the SDK can see
already logs — a spool that self-disables, an encoder that cannot represent a
batch. What none of them covers is the arrangement where nothing is wrong and
nothing is flowing: the export processor never handed to the host SDK, or a
provider that a second SDK registered first.

It is a log line rather than an API on purpose. As a warning the wording, the
delay and the conditions are all free to change; as a field on a structured
health object they would be a contract.

The timer is a daemon thread, cancelled on the first accepted export and on
shutdown — this package holds no lifecycle, and a short script that emits one
span and returns must not wait here for the warning to fire.
"""

from __future__ import annotations

import logging
import threading

log = logging.getLogger("octic_telemetry")

#: Long enough that a batch delay (5s) plus a slow disk does not trip it, short
#: enough to be visible while somebody is still watching the terminal.
SILENCE_WARNING_SECONDS = 30.0

_lock = threading.Lock()
_timer: threading.Timer | None = None
_delay = SILENCE_WARNING_SECONDS
# Latched: a pipeline that has written once is not silent, ever again.
_delivered = False
# Only a configured pipeline can be silent. Before `init()`, spans have nowhere
# to go by design, and warning about it would be noise from an import.
_armed = False


def _clear() -> None:
    global _timer
    if _timer is not None:
        _timer.cancel()
        _timer = None


def configure(delay: float = SILENCE_WARNING_SECONDS) -> None:
    """Called by ``init()``. The delay is a parameter only so tests can drive the
    real timer; it is not an ``init()`` option and should not become one."""
    global _delay, _delivered, _armed
    with _lock:
        _clear()
        _delay = delay
        _delivered = False
        _armed = True


def _fire() -> None:
    global _timer
    with _lock:
        _timer = None
        if _delivered:
            return
    log.warning(
        "octic-telemetry: spans have been produced for %ss and no spool segment has been "
        "written. Common causes: under init_with_external_provider(), export_processor was "
        "never added to the host SDK's tracer provider; another SDK registered the global "
        "tracer provider before init(); or the spool directory is unusable (look for an "
        "earlier warning). Run with OCTIC_TELEMETRY_DEBUG=1 for more.",
        _delay,
    )


def _should_arm() -> bool:
    return _armed and not _delivered and _timer is None


def note_span_started() -> None:
    """The arming edge, from ``OcticSpanProcessor.on_start`` — the one hook that
    runs per span in both entry modes.

    First span only. Re-arming per span would push the deadline out forever in
    any process that keeps producing, which is exactly the process worth warning.
    """
    global _timer
    # Checked once without the lock, because this runs on every span and after
    # the first one the answer is almost always "no", then again under it.
    if not _should_arm():
        return
    with _lock:
        if not _should_arm():
            return
        _timer = threading.Timer(_delay, _fire)
        # Never the reason a process stays alive.
        _timer.daemon = True
        _timer.start()


def note_export_succeeded() -> None:
    """The disarming edge, from ``SafeSpanExporter``'s success path."""
    global _delivered
    if _delivered:
        return
    with _lock:
        _delivered = True
        _clear()


def cancel() -> None:
    """From ``shutdown()``: the pipeline is stopping, so silence is expected."""
    global _armed
    with _lock:
        _clear()
        _armed = False
