"""The gate: the key attestation, the sealed input and the data fetch.

All three speak HTTP to Airlock's gate over the unix socket at
``AIRLOCK_GATE_SOCKET``. ``sealed_input`` never raises and warns once per
distinct problem. ``attest_key`` and ``fetch_data`` never raise and log
nothing: their result is the report.
"""

from __future__ import annotations

import base64
import contextlib
import errno
import http.client
import json
import logging
import os
import re
import socket
import stat
import time
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
#: A quote, a verifier run on the api and a database write.
_ATTEST_TIMEOUT = 60
#: Between polls for the sealed input. Tests shorten it.
_POLL_INTERVAL = 2.0
_SEALED_MODES = ("data_blind", "data_fetch")
#: Failures the sealed input always retries. RemoteDisconnected is a reset, and
#: a truncated answer (IncompleteRead) is treated as one.
_TRANSIENT = (
    ConnectionRefusedError,
    ConnectionResetError,
    TimeoutError,
    http.client.IncompleteRead,
)
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


def _refusal(status: int, data: bytes) -> str:
    """The reason for a non-200 answer: the gate's token, or the SDK's own."""
    if status in (404, 405):
        return "unsupported"
    try:
        token = data.decode("utf-8").strip(" \t\r\n")
    except UnicodeDecodeError:
        return "gate_error"
    if status in _REFUSALS and _TOKEN.fullmatch(token):
        return token
    return "gate_error"


def _reject_constant(name: str) -> Any:
    raise ValueError(name)


def _json(data: bytes) -> Any:
    """Strict UTF-8 JSON, as ``JSON.parse`` reads it: no BOM, no NaN or Infinity.

    Decoded first: ``json.loads(bytes)`` would strip a BOM and sniff UTF-16/32.
    """
    return json.loads(data.decode("utf-8"), parse_constant=_reject_constant)


def sealed_input() -> bytes | None:
    """The run's sealed input from the gate, or ``None``. Never raises.

    Data-blind and data-fetch runs have one: ``AIRLOCK_RUN_MODE`` must be
    ``data_blind`` or ``data_fetch``. It arrives after the agent attests its
    key, so this waits for it, polling every 2 seconds with no limit of its
    own; the orchestrator's deadline ends the run. A 404, a 5xx, a refused or
    reset connection (or a truncated answer) and a timeout are retried. It gives up with ``None`` on
    any other status, or on any other failure at the first try (no socket, a
    socket it may not use); after that, those are retried too.
    """
    if os.environ.get("AIRLOCK_RUN_MODE") not in _SEALED_MODES:
        return None
    path = os.environ.get("AIRLOCK_GATE_SOCKET")
    if not path:
        _warn_once("AIRLOCK_GATE_SOCKET is not set; no sealed input")
        return None
    # A non-socket at the path is a misconfiguration. Linux reports it as
    # ECONNREFUSED, which is retried, so it is caught here on every platform.
    with contextlib.suppress(OSError):
        if not stat.S_ISSOCK(os.stat(path).st_mode):
            _warn_once("the gate socket failed (ENOTSOCK); no sealed input")
            return None
    first = True
    while True:
        try:
            status, data = _call(path, "GET", "/v0/data/sealed", _READ_TIMEOUT)
        except _TRANSIENT as error:
            _warn_once(f"could not reach the gate for the sealed input ({_code(error)}); retrying")
        except Exception as error:  # noqa: BLE001 - the contract is that nothing escapes
            # No socket, or one we may not use, on the first try is a
            # misconfiguration, not a wait. Later, it is a blip.
            if first:
                _warn_once(f"the gate socket failed ({_code(error)}); no sealed input")
                return None
            _warn_once(f"could not reach the gate for the sealed input ({_code(error)}); retrying")
        else:
            if status == 200:
                return data
            # 404 is "not yet", the normal answer while waiting; a 5xx can fix
            # itself. Nothing else will.
            if not (status == 404 or 500 <= status <= 599):
                _warn_once(f"the gate answered {status} for the sealed input; no sealed input")
                return None
            if status != 404:
                _warn_once(f"the gate answered {status} for the sealed input; retrying")
        first = False
        time.sleep(_POLL_INTERVAL)


def _code(error: Exception) -> str:
    """The failure as Node names it: ``timeout``, ``ECONNRESET``, an errno name, or
    ``failed``. Never the error's text."""
    if isinstance(error, TimeoutError):
        return "timeout"
    if isinstance(error, (ConnectionResetError, http.client.IncompleteRead)):
        return "ECONNRESET"
    if isinstance(error, ConnectionRefusedError):
        return "ECONNREFUSED"
    number = getattr(error, "errno", None)
    return errno.errorcode.get(number, "failed") if isinstance(number, int) else "failed"


@dataclass(frozen=True)
class AttestResult:
    """What ``attest_key`` got: the gate's answer for the key, or why there is none."""

    ok: bool
    key_id: str | None = None
    bundle: dict[str, Any] = field(default_factory=dict)
    attestation: dict[str, str] = field(default_factory=dict)
    reason: str | None = None


def attest_key(public_key: bytes) -> AttestResult:
    """Attests the agent's X25519 public key through the gate.

    Only a data-blind or data-fetch run can. The FIU seals the run's parameters
    to this key, so call it before ``sealed_input``. Pass the raw 32-byte public
    half; the SDK never sees the private key. Never raises and logs nothing.
    """
    try:
        if os.environ.get("AIRLOCK_RUN_MODE") not in _SEALED_MODES:
            return AttestResult(ok=False, reason="not_sealed_run")
        path = os.environ.get("AIRLOCK_GATE_SOCKET")
        if not path:
            return AttestResult(ok=False, reason="no_gate")
        try:
            view = memoryview(public_key)
        except TypeError:
            return AttestResult(ok=False, reason="malformed")
        # Bytes, not 32 bytes' worth of wider items: Node takes only byte arrays.
        if view.itemsize != 1 or view.nbytes != 32:
            return AttestResult(ok=False, reason="malformed")
        key = view.tobytes()
        x = base64.urlsafe_b64encode(key).rstrip(b"=").decode()
        body = json.dumps(
            {
                "schema": "airlock.agent-key.request.v1",
                "key": {"kty": "OKP", "crv": "X25519", "x": x},
            },
            separators=(",", ":"),
        ).encode()

        try:
            status, data = _call(path, "POST", "/v0/attest", _ATTEST_TIMEOUT, bytearray(body))
        except Exception:  # noqa: BLE001 - connect error, timeout, reset: all one reason
            return AttestResult(ok=False, reason="gate_unreachable")
        if status != 200:
            return AttestResult(ok=False, reason=_refusal(status, data))
        try:
            answer = _json(data)
            key_id, bundle = answer["key_id"], answer["bundle"]
            mode, token = answer["attestation"]["mode"], answer["attestation"]["token"]
        except Exception:  # noqa: BLE001 - any unreadable answer is one reason
            return AttestResult(ok=False, reason="read_failed")
        if not (
            isinstance(key_id, str)
            and isinstance(bundle, dict)
            and isinstance(mode, str)
            and isinstance(token, str)
        ):
            return AttestResult(ok=False, reason="read_failed")
        return AttestResult(
            ok=True, key_id=key_id, bundle=bundle, attestation={"mode": mode, "token": token}
        )
    except Exception:  # noqa: BLE001 - the contract is that nothing escapes
        return AttestResult(ok=False, reason="gate_error")


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
    if status != 200:
        return _refused(_refusal(status, data))

    try:
        names = _json(data)["names"]
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
