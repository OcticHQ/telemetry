"""Agent receipts, for data-blind runs.

A receipt is a short, structured statement an agent makes about its own run.
It is checked against the generated vocabulary (``receipts_gen``), written to
the spool directory as a file of its own inside the call, and drained later by
Airlock's orchestrator. Nothing here holds a type or key literal.

``record_receipt`` never raises and warns once. The sealed input lives in
``gate``.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import re
import threading
import time
from collections.abc import Mapping
from datetime import datetime, timezone

from .receipts_gen import (
    MAX_ATTRIBUTE_VALUE_CHARS,
    MAX_RECEIPT_BYTES,
    MAX_RECEIPTS_PER_RUN,
    RECEIPT_SHAPES,
    RECEIPT_TYPES,
)
from .spool import fchmod, new_writer_id, shared_directory, write_all

log = logging.getLogger("octichq_airlock_sdk")

#: Bumped when the file's shape changes in a way a reader must notice.
RECEIPT_FORMAT_VERSION = 1

_COMPILED = {name: re.compile(pattern) for name, pattern in RECEIPT_SHAPES.items()}

_lock = threading.Lock()
_writer_id = new_writer_id()
_seq = 0
_written = 0
#: Messages already warned, so each distinct problem warns once.
_warned: set[str] = set()


def _after_fork_in_child() -> None:
    global _lock, _writer_id, _seq, _written
    _lock = threading.Lock()
    _writer_id = new_writer_id()
    _seq = 0
    _written = 0


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_after_fork_in_child)


def _reset_for_tests() -> None:
    global _seq, _written
    _seq = _written = 0
    _warned.clear()


def _warn_once(message: str) -> None:
    if message not in _warned:
        _warned.add(message)
        log.warning("octichq-airlock-sdk: %s", message)


def _check(type_: str, attributes: Mapping[str, str | int]) -> dict[str, str] | None:
    """The attributes as strings if they fit the vocabulary, else ``None``."""
    spec = RECEIPT_TYPES.get(type_)
    if spec is None:
        return None
    shapes = {**spec["required"], **spec["optional"]}
    checked: dict[str, str] = {}
    for key, value in attributes.items():
        shape = shapes.get(key)
        if shape is None or isinstance(value, bool) or not isinstance(value, (str, int)):
            return None
        text = str(value)
        if len(text) > MAX_ATTRIBUTE_VALUE_CHARS:
            return None
        # fullmatch, not match: `$` also matches before a trailing newline.
        if _COMPILED[shape].fullmatch(text) is None:
            return None
        checked[key] = text
    if any(key not in checked for key in spec["required"]):
        return None
    return checked


def record_receipt(type: str, attributes: Mapping[str, str | int]) -> bool:  # noqa: A002
    """Writes one receipt file and says whether it landed. Never raises."""
    global _seq, _written
    try:
        checked = _check(type, attributes)
        if checked is None:
            _warn_once(f"receipt {type!r} is not on the vocabulary; not recorded")
            return False
        occurred = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
        body = json.dumps(
            {
                "receiptFormatVersion": RECEIPT_FORMAT_VERSION,
                "type": type,
                "attributes": checked,
                "occurredAt": occurred.replace("+00:00", "Z"),
            },
            separators=(",", ":"),
        ).encode()
        if len(body) > MAX_RECEIPT_BYTES:
            _warn_once(f"receipt {type!r} is over {MAX_RECEIPT_BYTES} bytes; not recorded")
            return False
        with _lock:
            if _written >= MAX_RECEIPTS_PER_RUN:
                _warn_once(f"already recorded {MAX_RECEIPTS_PER_RUN} receipts; not recording more")
                return False
            directory = shared_directory()
            if directory is None:
                _warn_once("no usable spool directory; receipt not recorded")
                return False
            _seq += 1
            epoch_ms = time.time_ns() // 1_000_000
            final = directory / f"receipt-{epoch_ms}-{_seq:06d}-{_writer_id}.json"
            tmp = final.with_name(final.name + ".tmp")
            try:
                fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                try:
                    fchmod(fd, 0o600)
                    write_all(fd, body)
                    os.fsync(fd)
                finally:
                    os.close(fd)
                os.replace(tmp, final)
            except OSError:
                with contextlib.suppress(OSError):
                    os.unlink(tmp)
                _warn_once("could not write the receipt file")
                return False
            _written += 1
            return True
    except Exception:  # noqa: BLE001 - the contract is that nothing escapes
        _warn_once("recording a receipt failed unexpectedly")
        return False
