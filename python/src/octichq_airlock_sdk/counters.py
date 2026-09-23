"""What this SDK dropped, refused, or swallowed — counted, never exposed.

Every guard added for non-interference turns a crash into a return, and a guard
that returns quietly is indistinguishable from nothing having gone wrong. These
counters are the difference. They are the same numbers a ``diagnose()`` API would
eventually publish, kept internal on purpose: a structured health object is a
second product surface, versioned forever, that consumers assert on in their own
suites. Maintaining the counts now and shipping the shape later means the
eventual API is written against real support tickets rather than a guess made
before the first one.

Read them today through ``OCTIC_TELEMETRY_DEBUG=1``, which turns on the log
lines that accompany each increment.

Thread-safe, which the Node SDK got for free from the single event loop and this
one does not: the exporter runs on the batch processor's worker thread while the
processor runs on whichever thread ended the span.
"""

from __future__ import annotations

import logging
import os
import threading
from dataclasses import asdict, dataclass

log = logging.getLogger("octichq_airlock_sdk")


@dataclass
class Counters:
    #: Spans the pipeline took custody of — in this release, written to the spool.
    #: Not "exported": nothing leaves over the network, and a counter reading zero
    #: under a working spool would be read as a broken pipeline.
    spans_accepted: int = 0
    #: Batches that ended ``FAILURE``: the spool refused them, or encoding failed.
    exports_failed: int = 0
    #: Attribute entries the sanitizer refused: wrong type, oversized, over the cap.
    attributes_dropped: int = 0
    #: Spans dropped from a batch because they could not be copied at all.
    spans_dropped: int = 0
    #: Throws caught at a processor or exporter callback boundary.
    processor_errors: int = 0


_lock = threading.Lock()
_counters = Counters()


def count(name: str, by: int = 1) -> None:
    with _lock:
        setattr(_counters, name, getattr(_counters, name) + by)


def snapshot() -> dict[str, int]:
    """A copy, so nothing outside this module can move a number by holding the object."""
    with _lock:
        return asdict(_counters)


def reset_counters() -> None:
    """Process state, like the content policy.

    A test that moves a counter and does not reset it changes what every later
    test in the same file is asserting about.
    """
    global _counters
    with _lock:
        _counters = Counters()


def debug_enabled() -> bool:
    """One environment read per call, deliberately.

    Caching it would make the flag unsettable from a test, and this is only ever
    reached on a path that has already decided something went wrong.
    """
    return os.environ.get("OCTIC_TELEMETRY_DEBUG", "") not in ("", "0", "false")


def debug(message: str, *args: object) -> None:
    if debug_enabled():
        log.warning(message, *args)
    else:
        log.debug(message, *args)
