"""The gate calls: key attestation, the sealed input and the data fetch, on a unix socket."""

from __future__ import annotations

import array
import contextlib
import http.client
import json
import os
import shutil
import socket
import socketserver
import tempfile
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler
from types import SimpleNamespace
from typing import Any

import pytest

from octichq_airlock_sdk import gate
from octichq_airlock_sdk.gate import AttestResult, FetchResult, attest_key, fetch_data, sealed_input

CREDENTIALS: dict[str, Any] = {
    "schema": "airlock.rebit.credentials.v1",
    "entity_id": "fiu-1",
    "secret": "s3cret",
    "signing_key": "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
    "signing_kid": "kid-1",
}
RANGE = {"from": "2026-01-01T00:00:00Z", "to": "2026-06-30T00:00:00Z"}


class _PollStoppedError(Exception):
    """Raised from a stopped poller's wait, to end it."""


_stop = threading.Event()


class _Server(socketserver.ThreadingUnixStreamServer):
    def __init__(self, path: str) -> None:
        super().__init__(path, _Handler)
        self.path = path
        #: (method, path) -> (status, body); anything else is a 404.
        self.routes: dict[tuple[str, str], tuple[int, bytes]] = {
            ("GET", "/v0/data/sealed"): (200, b"sealed"),
        }
        #: (method, path) -> answers served once each, in order, before ``routes``.
        self.queued: dict[tuple[str, str], list[tuple[int, bytes]]] = {}
        #: (method, path, headers, body), in arrival order.
        self.requests: list[tuple[str, str, dict[str, str], bytes]] = []


class _Handler(BaseHTTPRequestHandler):
    server: _Server

    def do_GET(self) -> None:
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.server.requests.append((self.command, self.path, dict(self.headers), body))
        route = (self.command, self.path)
        queued = self.server.queued.get(route)
        status, data = (
            queued.pop(0)
            if queued
            else self.server.routes.get(route, (404, b"404 page not found\n"))
        )
        self.send_response(status)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_POST = do_GET  # noqa: N815 - http.server's naming

    def log_message(self, fmt: str, *args: object) -> None:
        pass


def _serve(path: str) -> _Server:
    server = _Server(path)
    # A short poll keeps shutdown() from waiting half a second per test.
    threading.Thread(target=server.serve_forever, args=(0.05,), daemon=True).start()
    return server


@pytest.fixture(autouse=True)
def fast_polls(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Short polls, and a stop: a poller left over from a timed-out test ends at
    its next wait instead of polling into later tests."""
    global _stop
    gate._reset_for_tests()
    stop = _stop = threading.Event()

    def sleep(seconds: float) -> None:
        if stop.wait(seconds):
            raise _PollStoppedError

    monkeypatch.setattr(gate, "_POLL_INTERVAL", 0.05)
    monkeypatch.setattr(gate, "time", SimpleNamespace(sleep=sleep))
    yield
    stop.set()


@pytest.fixture
def server(monkeypatch: pytest.MonkeyPatch) -> Iterator[_Server]:
    # Unix socket paths are short on macOS; pytest's tmp_path is not.
    directory = tempfile.mkdtemp(dir="/tmp")
    server = _serve(os.path.join(directory, "g.sock"))
    monkeypatch.setenv("AIRLOCK_GATE_SOCKET", server.path)
    yield server
    server.shutdown()
    server.server_close()
    shutil.rmtree(directory, ignore_errors=True)


@pytest.fixture
def absent_socket() -> Iterator[str]:
    """A socket path nobody listens on, short enough to reach ``connect``."""
    directory = tempfile.mkdtemp(dir="/tmp")
    yield os.path.join(directory, "absent.sock")
    shutil.rmtree(directory, ignore_errors=True)


def fetch(credentials: Any = CREDENTIALS) -> FetchResult:
    return fetch_data(credentials=credentials, consent_id="consent-1", fi_data_range=RANGE)


def sealed_soon() -> bytes | None:
    """``sealed_input()``, failing the test instead of hanging if it never returns."""
    result: list[bytes | None] = []
    stop = _stop

    def wait() -> None:
        with contextlib.suppress(_PollStoppedError):
            result.append(sealed_input())

    waiter = threading.Thread(target=wait, daemon=True)
    waiter.start()
    waiter.join(5)
    if not result:
        stop.set()
        waiter.join(1)
    assert result, "sealed_input is still polling"
    return result[0]


# -- the sealed input -----------------------------------------------------------


@pytest.mark.parametrize("mode", ["data_blind", "data_fetch"])
def test_sealed_input_reads_the_blob_from_the_gate(
    server: _Server, monkeypatch: pytest.MonkeyPatch, mode: str
) -> None:
    monkeypatch.setenv("AIRLOCK_RUN_MODE", mode)
    assert sealed_input() == b"sealed"


def test_sealed_input_is_none_outside_those_modes(
    server: _Server, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("AIRLOCK_RUN_MODE", raising=False)
    assert sealed_input() is None
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "standard")
    assert sealed_input() is None
    assert server.requests == []


def test_sealed_input_is_none_without_a_socket_variable(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_blind")
    with caplog.at_level("WARNING", logger="octichq_airlock_sdk"):
        monkeypatch.delenv("AIRLOCK_GATE_SOCKET", raising=False)
        assert sealed_input() is None
        monkeypatch.setenv("AIRLOCK_GATE_SOCKET", "")
        assert sealed_input() is None
    messages = [record.getMessage() for record in caplog.records]
    assert len(messages) == 1
    assert "AIRLOCK_GATE_SOCKET" in messages[0]


def test_sealed_input_is_none_at_once_when_the_socket_is_missing(
    absent_socket: str, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_blind")
    monkeypatch.setenv("AIRLOCK_GATE_SOCKET", absent_socket)
    with caplog.at_level("WARNING", logger="octichq_airlock_sdk"):
        assert sealed_soon() is None
    [message] = [record.getMessage() for record in caplog.records]
    assert "ENOENT" in message


def test_sealed_input_is_none_at_once_when_the_path_is_a_regular_file(
    absent_socket: str, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    # macOS answers ENOTSOCK, Linux ECONNREFUSED; both must give up at once.
    # The connection is made to refuse, as on Linux, so that only the check
    # before the first poll can pass this test, on any platform.
    def refused(*_: object) -> None:
        raise ConnectionRefusedError

    monkeypatch.setattr(gate, "_call", refused)
    open(absent_socket, "w").close()
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_blind")
    monkeypatch.setenv("AIRLOCK_GATE_SOCKET", absent_socket)
    with caplog.at_level("WARNING", logger="octichq_airlock_sdk"):
        assert sealed_soon() is None
    [message] = [record.getMessage() for record in caplog.records]
    assert "ENOTSOCK" in message


def test_sealed_input_is_none_at_once_when_the_path_runs_through_a_file(
    absent_socket: str, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    open(absent_socket, "w").close()
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_blind")
    monkeypatch.setenv("AIRLOCK_GATE_SOCKET", os.path.join(absent_socket, "g.sock"))
    with caplog.at_level("WARNING", logger="octichq_airlock_sdk"):
        assert sealed_soon() is None
    [message] = [record.getMessage() for record in caplog.records]
    assert "ENOTDIR" in message


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (ConnectionRefusedError(61, "refused"), "ECONNREFUSED"),
        (ConnectionResetError(54, "reset"), "ECONNRESET"),
        (http.client.RemoteDisconnected("closed"), "ECONNRESET"),
        (http.client.IncompleteRead(b"sea", 3), "ECONNRESET"),
        (TimeoutError("timed out"), "timeout"),
    ],
)
def test_a_transient_failure_is_retried_from_the_first_try(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    error: Exception,
    code: str,
) -> None:
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_blind")
    monkeypatch.setenv("AIRLOCK_GATE_SOCKET", "/gate.sock")
    answers: list[tuple[int, bytes] | Exception] = [error, error, (200, b"sealed")]

    def fake_call(*_: object) -> tuple[int, bytes]:
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    monkeypatch.setattr(gate, "_call", fake_call)
    with caplog.at_level("WARNING", logger="octichq_airlock_sdk"):
        assert sealed_soon() == b"sealed"
    [message] = [record.getMessage() for record in caplog.records]
    assert (
        message
        == f"octichq-airlock-sdk: could not reach the gate for the sealed input ({code}); retrying"
    )


def test_another_os_error_is_fatal_at_first_and_retried_later(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_blind")
    monkeypatch.setenv("AIRLOCK_GATE_SOCKET", "/gate.sock")
    answers: list[tuple[int, bytes] | Exception] = []

    def fake_call(*_: object) -> tuple[int, bytes]:
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    monkeypatch.setattr(gate, "_call", fake_call)
    answers[:] = [PermissionError(13, "denied")]
    assert sealed_soon() is None
    answers[:] = [(404, b""), PermissionError(13, "denied"), (200, b"sealed")]
    assert sealed_soon() == b"sealed"
    assert answers == []


def test_sealed_input_waits_through_404s_silently(
    server: _Server, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_fetch")
    server.queued[("GET", "/v0/data/sealed")] = [(404, b"not yet\n")] * 2
    started = time.monotonic()
    with caplog.at_level("WARNING", logger="octichq_airlock_sdk"):
        assert sealed_soon() == b"sealed"
    assert time.monotonic() - started >= 0.1  # two waits at the patched interval
    assert len(server.requests) == 3
    assert caplog.records == []


def test_sealed_input_keeps_polling_across_a_5xx_and_warns_once(
    server: _Server, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_blind")
    server.queued[("GET", "/v0/data/sealed")] = [(503, b"secret detail\n")] * 2
    with caplog.at_level("WARNING", logger="octichq_airlock_sdk"):
        assert sealed_soon() == b"sealed"
    messages = [record.getMessage() for record in caplog.records]
    assert len(messages) == 1
    assert "503" in messages[0]
    assert "secret" not in messages[0]
    assert len(server.requests) == 3


@pytest.mark.parametrize("status", [400, 403, 405, 410, 204, 302, 600, 999])
def test_sealed_input_gives_up_on_a_status_that_will_not_change(
    server: _Server, monkeypatch: pytest.MonkeyPatch, status: int
) -> None:
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_blind")
    server.routes[("GET", "/v0/data/sealed")] = (status, b"no\n")
    assert sealed_soon() is None
    assert len(server.requests) == 1


def test_sealed_input_returns_once_a_refusing_socket_starts_serving(
    absent_socket: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Bound but not listening: connection refused, which is retried. Swapping in
    # the gate leaves a moment with no socket file, a later ENOENT, also retried.
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_blind")
    monkeypatch.setenv("AIRLOCK_GATE_SOCKET", absent_socket)
    refusing = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    refusing.bind(absent_socket)
    servers: list[_Server] = []

    def swap() -> None:
        time.sleep(0.15)
        refusing.close()
        os.unlink(absent_socket)
        time.sleep(0.15)
        servers.append(_serve(absent_socket))

    swapper = threading.Thread(target=swap)
    swapper.start()
    try:
        assert sealed_soon() == b"sealed"
    finally:
        swapper.join()
        for server in servers:
            server.shutdown()
            server.server_close()


# -- key attestation ------------------------------------------------------------

KEY = bytes(range(32))
ATTESTED: dict[str, Any] = {
    "key_id": "key_abc",
    "bundle": {"airlock.agent_key": "airlock.agent-key.v1", "run_id": "run-1"},
    "attestation": {"mode": "dev", "token": "tok"},
}


def test_attest_key_posts_the_exact_body_and_parses_the_answer(
    server: _Server, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_blind")
    server.routes[("POST", "/v0/attest")] = (200, json.dumps(ATTESTED).encode())
    assert attest_key(KEY) == AttestResult(
        ok=True,
        key_id="key_abc",
        bundle=ATTESTED["bundle"],
        attestation={"mode": "dev", "token": "tok"},
    )
    [(method, path, headers, body)] = server.requests
    assert (method, path) == ("POST", "/v0/attest")
    assert headers["Content-Type"] == "application/json"
    assert body == (
        b'{"schema":"airlock.agent-key.request.v1","key":{"kty":"OKP","crv":"X25519",'
        b'"x":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}}'
    )


@pytest.mark.parametrize(
    "answer",
    [
        b"not json",
        b"\xff",
        b"\xef\xbb\xbf" + json.dumps(ATTESTED).encode(),
        b"[]",
        json.dumps({**ATTESTED, "key_id": 1}).encode(),
        json.dumps({**ATTESTED, "bundle": []}).encode(),
        json.dumps({**ATTESTED, "attestation": "dev"}).encode(),
        json.dumps({**ATTESTED, "attestation": {"mode": "dev"}}).encode(),
        json.dumps({**ATTESTED, "attestation": {"mode": 1, "token": "t"}}).encode(),
        json.dumps({k: v for k, v in ATTESTED.items() if k != "key_id"}).encode(),
        json.dumps({**ATTESTED, "bundle": {"n": float("nan")}}).encode(),
    ],
)
def test_a_bad_attest_answer_is_read_failed(
    server: _Server, monkeypatch: pytest.MonkeyPatch, answer: bytes
) -> None:
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_fetch")
    server.routes[("POST", "/v0/attest")] = (200, answer)
    assert attest_key(KEY) == AttestResult(ok=False, reason="read_failed")


@pytest.mark.parametrize(
    ("status", "body", "reason"),
    [
        (400, b"malformed\n", "malformed"),
        (409, b"already_attested\n", "already_attested"),
        (413, b"malformed\n", "malformed"),
        (422, b"attest_failed\n", "attest_failed"),
        (404, b"404 page not found\n", "unsupported"),
        (405, b"Method Not Allowed\n", "unsupported"),
        (500, b"internal error\n", "gate_error"),
    ],
)
def test_an_attest_refusal_becomes_the_reason(
    server: _Server, monkeypatch: pytest.MonkeyPatch, status: int, body: bytes, reason: str
) -> None:
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_blind")
    server.routes[("POST", "/v0/attest")] = (status, body)
    assert attest_key(KEY) == AttestResult(ok=False, reason=reason)


def test_attest_key_outside_a_sealed_run_touches_nothing(
    server: _Server, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("AIRLOCK_RUN_MODE", raising=False)
    assert attest_key(KEY).reason == "not_sealed_run"
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "standard")
    assert attest_key(KEY).reason == "not_sealed_run"
    assert server.requests == []


@pytest.mark.parametrize(
    "key", [KEY[:31], KEY + b"\x00", b"", "A" * 32, None, array.array("H", range(16))]
)
def test_a_key_that_is_not_32_bytes_is_malformed_and_never_sent(
    server: _Server, monkeypatch: pytest.MonkeyPatch, key: Any
) -> None:
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_blind")
    assert attest_key(key) == AttestResult(ok=False, reason="malformed")
    assert server.requests == []


def test_a_short_key_without_a_gate_is_no_gate(monkeypatch: pytest.MonkeyPatch) -> None:
    # The pre-socket order: the socket variable is checked before the key.
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_blind")
    monkeypatch.delenv("AIRLOCK_GATE_SOCKET", raising=False)
    assert attest_key(KEY[:5]) == AttestResult(ok=False, reason="no_gate")


def test_attest_key_without_a_gate_is_no_gate_and_logs_nothing(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_fetch")
    with caplog.at_level("DEBUG", logger="octichq_airlock_sdk"):
        monkeypatch.delenv("AIRLOCK_GATE_SOCKET", raising=False)
        assert attest_key(KEY).reason == "no_gate"
        monkeypatch.setenv("AIRLOCK_GATE_SOCKET", "")
        assert attest_key(KEY).reason == "no_gate"
    assert caplog.records == []


def test_attest_key_with_an_absent_socket_is_gate_unreachable(
    absent_socket: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_blind")
    monkeypatch.setenv("AIRLOCK_GATE_SOCKET", absent_socket)
    assert attest_key(KEY) == AttestResult(ok=False, reason="gate_unreachable")


# -- the data fetch -------------------------------------------------------------


def test_fetch_data_posts_the_request_then_reads_each_name(
    server: _Server, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_fetch")
    server.routes[("POST", "/v0/fetch")] = (200, b'{"names":["fi/1 a","fi-2"]}\n')
    server.routes[("GET", "/v0/data/fi%2F1%20a")] = (200, b"\x00one")
    server.routes[("GET", "/v0/data/fi-2")] = (200, b"two")

    assert fetch() == FetchResult(ok=True, entries={"fi/1 a": b"\x00one", "fi-2": b"two"})

    (method, path, headers, body), *reads = server.requests
    assert (method, path) == ("POST", "/v0/fetch")
    assert headers["Content-Type"] == "application/json"
    assert headers["Content-Length"] == str(len(body))
    assert json.loads(body) == {
        "schema": "airlock.fetch.request.v1",
        "credentials": CREDENTIALS,
        "consent_id": "consent-1",
        "fi_data_range": RANGE,
    }
    assert [(m, p) for m, p, _, _ in reads] == [
        ("GET", "/v0/data/fi%2F1%20a"),
        ("GET", "/v0/data/fi-2"),
    ]


@pytest.mark.parametrize(
    ("status", "body", "reason"),
    [
        (400, b"malformed\n", "malformed"),
        (409, b"already_fetched\n", "already_fetched"),
        (409, b"not_ready\n", "not_ready"),
        (413, b"malformed\n", "malformed"),
        (422, b"consent_expired\n", "consent_expired"),
        (422, b"Consent Expired\n", "gate_error"),
        (500, b"fetch failed\n", "gate_error"),
        (502, b"bad_gateway\n", "gate_error"),
        (404, b"404 page not found\n", "unsupported"),
        (405, b"Method Not Allowed\n", "unsupported"),
        (409, b"already_fetched ", "already_fetched"),
        (400, b"malformed\x1f", "gate_error"),
        (400, b"malformed\x0b", "gate_error"),
        (400, b"\xef\xbb\xbfmalformed", "gate_error"),
        (422, b"\xff\n", "gate_error"),
    ],
)
def test_a_gate_refusal_becomes_the_reason(
    server: _Server, monkeypatch: pytest.MonkeyPatch, status: int, body: bytes, reason: str
) -> None:
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_fetch")
    server.routes[("POST", "/v0/fetch")] = (status, body)
    assert fetch() == FetchResult(ok=False, entries={}, reason=reason)


def test_fetch_data_outside_a_data_fetch_run_touches_nothing(
    server: _Server, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_blind")
    assert fetch().reason == "not_data_fetch"
    assert server.requests == []


def test_fetch_data_without_a_gate_is_no_gate_and_logs_nothing(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_fetch")
    with caplog.at_level("DEBUG", logger="octichq_airlock_sdk"):
        monkeypatch.delenv("AIRLOCK_GATE_SOCKET", raising=False)
        assert fetch().reason == "no_gate"
        monkeypatch.setenv("AIRLOCK_GATE_SOCKET", "")
        assert fetch().reason == "no_gate"
    assert caplog.records == []


def test_fetch_data_with_an_absent_socket_is_gate_unreachable(
    absent_socket: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_fetch")
    monkeypatch.setenv("AIRLOCK_GATE_SOCKET", absent_socket)
    assert fetch().reason == "gate_unreachable"


@pytest.mark.parametrize(
    "answer",
    [
        b"not json",
        b"[]",
        b'{"names":"fi-1"}',
        b'{"names":[1]}',
        b"{}",
        b'\xef\xbb\xbf{"names":[]}',
        '{"names":[]}'.encode("utf-16"),
    ],
)
def test_a_bad_answer_is_read_failed(
    server: _Server, monkeypatch: pytest.MonkeyPatch, answer: bytes
) -> None:
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_fetch")
    server.routes[("POST", "/v0/fetch")] = (200, answer)
    assert fetch() == FetchResult(ok=False, reason="read_failed")


def test_a_failed_read_is_read_failed(server: _Server, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_fetch")
    server.routes[("POST", "/v0/fetch")] = (200, b'{"names":["fi-1","missing"]}')
    server.routes[("GET", "/v0/data/fi-1")] = (200, b"one")
    assert fetch() == FetchResult(ok=False, reason="read_failed")


@pytest.mark.parametrize(
    "credentials", [{**CREDENTIALS, "secret": {1, 2}}, {**CREDENTIALS, "n": float("nan")}]
)
def test_unserializable_credentials_are_malformed_and_never_sent(
    server: _Server, monkeypatch: pytest.MonkeyPatch, credentials: dict[str, Any]
) -> None:
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_fetch")
    assert fetch(credentials) == FetchResult(ok=False, reason="malformed")
    assert server.requests == []


def test_a_range_missing_a_bound_is_malformed_and_never_sent(
    server: _Server, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_fetch")
    result = fetch_data(credentials=CREDENTIALS, consent_id="c", fi_data_range={"from": "x"})
    assert result == FetchResult(ok=False, reason="malformed")
    assert server.requests == []


def test_the_request_body_is_zeroed_once_sent(
    server: _Server, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_fetch")
    server.routes[("POST", "/v0/fetch")] = (200, b'{"names":[]}')
    sent: list[bytearray] = []
    exchange = gate._exchange

    def spy(path: str, body: bytearray) -> FetchResult:
        sent.append(body)
        return exchange(path, body)

    monkeypatch.setattr(gate, "_exchange", spy)
    assert fetch() == FetchResult(ok=True)
    [body] = sent
    assert len(body) > 0
    assert body == bytes(len(body))
    assert json.loads(server.requests[0][3])["credentials"] == CREDENTIALS


def test_a_body_over_64_kib_is_malformed_and_never_sent(
    server: _Server, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_fetch")
    assert fetch({**CREDENTIALS, "secret": "x" * 65536}) == FetchResult(
        ok=False, reason="malformed"
    )
    assert server.requests == []
