"""The gate: the sealed input and the data fetch.

Both speak HTTP to Airlock's gate over the unix socket at
``AIRLOCK_GATE_SOCKET``. ``sealed_input`` never raises and warns once.
``fetch_data`` never raises and logs nothing: its result is the report.
"""

from __future__ import annotations

import http.client
import json
import logging
import os
import re
import socket
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

log = logging.getLogger("octichq_airlock_sdk")

#: Messages already warned, so each distinct problem warns once.
_warned: set[str] = set()

#: A gate refusal body that passes through as the reason.
_TOKEN = re.compile(r"[a-z0-9_]{1,64}")
_REFUSALS = frozenset({400, 409, 413, 422})

#: The orchestrator's 5-minute fetch timeout, plus margin.
_FETCH_TIMEOUT = 330
_READ_TIMEOUT = 30
#: The gate's limit on the request; over it, it answers 413 early and may reset.
_MAX_REQUEST_BYTES = 64 * 1024


def _reset_for_tests() -> None:
    _warned.clear()


def _warn_once(message: str) -> None:
    if message not in _warned:
        _warned.add(message)
        log.warning("octichq-airlock-sdk: %s", message)


class _GateConnection(http.client.HTTPConnection):
    def __init__(self, path: str, timeout: float) -> None:
        super().__init__("gate", timeout=timeout)
        self._path = path

    def connect(self) -> None:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self._path)
        self.sock = sock


def _call(
    path: str, method: str, url: str, timeout: float, body: bytearray | None = None
) -> tuple[int, bytes]:
    """One request on its own connection. A ``body`` is zeroed once it is sent."""
    connection = _GateConnection(path, timeout)
    try:
        try:
            headers = {} if body is None else {"Content-Type": "application/json"}
            connection.request(method, url, body, headers)
        finally:
            if body is not None:
                body[:] = bytes(len(body))
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


def sealed_input() -> bytes | None:
    """The run's sealed input from the gate, or ``None``. Never raises.

    Data-blind and data-fetch runs have one: ``AIRLOCK_RUN_MODE`` must be
    ``data_blind`` or ``data_fetch``.
    """
    if os.environ.get("AIRLOCK_RUN_MODE") not in ("data_blind", "data_fetch"):
        return None
    path = os.environ.get("AIRLOCK_GATE_SOCKET")
    if not path:
        _warn_once("AIRLOCK_GATE_SOCKET is not set; no sealed input")
        return None
    try:
        status, data = _call(path, "GET", "/v0/data/sealed", _READ_TIMEOUT)
        if status != 200:
            _warn_once(f"the gate answered {status} for the sealed input")
            return None
        return data
    except Exception:  # noqa: BLE001 - the contract is that nothing escapes
        _warn_once("could not read the sealed input from the gate")
        return None


@dataclass(frozen=True)
class FetchResult:
    """What ``fetch_data`` got: the vault entries by name, or why there are none."""

    ok: bool
    entries: dict[str, bytes] = field(default_factory=dict)
    reason: str | None = None


def _refused(reason: str) -> FetchResult:
    return FetchResult(ok=False, reason=reason)


def fetch_data(
    *, credentials: Mapping[str, Any], consent_id: str, fi_data_range: Mapping[str, str]
) -> FetchResult:
    """Hands the FIU's credentials to the gate and reads back the fetched data.

    Only a data-fetch run can: ``AIRLOCK_RUN_MODE`` must be ``data_fetch``.
    Never raises and logs nothing. ``credentials`` is the object from the
    sealed parameters, passed through unchanged; nothing keeps it after the
    request body is written, and no reason ever includes it.
    """
    try:
        if os.environ.get("AIRLOCK_RUN_MODE") != "data_fetch":
            return _refused("not_data_fetch")
        path = os.environ.get("AIRLOCK_GATE_SOCKET")
        if not path:
            return _refused("no_gate")
        try:
            body = bytearray(
                json.dumps(
                    {
                        "schema": "airlock.fetch.request.v1",
                        "credentials": dict(credentials),
                        "consent_id": consent_id,
                        "fi_data_range": {
                            "from": fi_data_range["from"],
                            "to": fi_data_range["to"],
                        },
                    },
                    separators=(",", ":"),
                    allow_nan=False,
                ).encode()
            )
        except (TypeError, ValueError, LookupError):
            return _refused("malformed")
        # Nothing that waits on the gate holds the inputs; only the body, which is zeroed.
        del credentials, consent_id, fi_data_range
        if len(body) > _MAX_REQUEST_BYTES:
            body[:] = bytes(len(body))
            return _refused("malformed")
        return _exchange(path, body)
    except Exception:  # noqa: BLE001 - the contract is that nothing escapes
        return _refused("gate_error")


def _exchange(path: str, body: bytearray) -> FetchResult:
    """The POST, then one GET per name. ``body`` is zeroed once it is sent."""
    try:
        status, data = _call(path, "POST", "/v0/fetch", _FETCH_TIMEOUT, body)
    except Exception:  # noqa: BLE001 - connect error, timeout, reset: all one reason
        return _refused("gate_unreachable")
    if status in (404, 405):
        return _refused("unsupported")
    if status != 200:
        try:
            token = data.decode("utf-8").strip(" \t\r\n")
        except UnicodeDecodeError:
            return _refused("gate_error")
        if status in _REFUSALS and _TOKEN.fullmatch(token):
            return _refused(token)
        return _refused("gate_error")

    try:
        # Decoded first: json.loads(bytes) would strip a BOM and sniff UTF-16/32.
        names = json.loads(data.decode("utf-8"))["names"]
        if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
            return _refused("read_failed")
        entries: dict[str, bytes] = {}
        for name in names:
            status, entry = _call(path, "GET", "/v0/data/" + quote(name, safe=""), _READ_TIMEOUT)
            if status != 200:
                return _refused("read_failed")
            entries[name] = entry
    except Exception:  # noqa: BLE001 - a bad answer or a failed read: all one reason
        return _refused("read_failed")
    return FetchResult(ok=True, entries=entries)
