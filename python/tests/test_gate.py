"""The gate calls: the sealed input and the data fetch, against a unix-socket gate."""

from __future__ import annotations

import json
import os
import shutil
import socketserver
import tempfile
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler
from typing import Any

import pytest

from octichq_airlock_sdk import gate
from octichq_airlock_sdk.gate import FetchResult, fetch_data, sealed_input

CREDENTIALS: dict[str, Any] = {
    "schema": "airlock.rebit.credentials.v1",
    "entity_id": "fiu-1",
    "secret": "s3cret",
    "signing_key": "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
    "signing_kid": "kid-1",
}
RANGE = {"from": "2026-01-01T00:00:00Z", "to": "2026-06-30T00:00:00Z"}


class _Server(socketserver.ThreadingUnixStreamServer):
    def __init__(self, path: str) -> None:
        super().__init__(path, _Handler)
        self.path = path
        #: (method, path) -> (status, body); anything else is a 404.
        self.routes: dict[tuple[str, str], tuple[int, bytes]] = {
            ("GET", "/v0/data/sealed"): (200, b"sealed"),
        }
        #: (method, path, headers, body), in arrival order.
        self.requests: list[tuple[str, str, dict[str, str], bytes]] = []


class _Handler(BaseHTTPRequestHandler):
    server: _Server

    def do_GET(self) -> None:
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.server.requests.append((self.command, self.path, dict(self.headers), body))
        status, data = self.server.routes.get(
            (self.command, self.path), (404, b"404 page not found\n")
        )
        self.send_response(status)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_POST = do_GET  # noqa: N815 - http.server's naming

    def log_message(self, fmt: str, *args: object) -> None:
        pass


@pytest.fixture
def server(monkeypatch: pytest.MonkeyPatch) -> Iterator[_Server]:
    gate._reset_for_tests()
    # Unix socket paths are short on macOS; pytest's tmp_path is not.
    directory = tempfile.mkdtemp(dir="/tmp")
    server = _Server(os.path.join(directory, "g.sock"))
    threading.Thread(target=server.serve_forever, daemon=True).start()
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


def test_sealed_input_is_none_when_the_gate_is_missing(
    absent_socket: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_blind")
    monkeypatch.delenv("AIRLOCK_GATE_SOCKET", raising=False)
    assert sealed_input() is None
    monkeypatch.setenv("AIRLOCK_GATE_SOCKET", absent_socket)
    assert sealed_input() is None


def test_sealed_input_warns_once_per_problem(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    gate._reset_for_tests()
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_blind")
    monkeypatch.delenv("AIRLOCK_GATE_SOCKET", raising=False)
    with caplog.at_level("WARNING", logger="octichq_airlock_sdk"):
        assert sealed_input() is None
        assert sealed_input() is None
    messages = [record.getMessage() for record in caplog.records]
    assert len(messages) == 1
    assert "AIRLOCK_GATE_SOCKET" in messages[0]


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
