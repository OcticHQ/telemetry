"""Agent receipts and the sealed input, checked against contract/SPOOL.md."""

from __future__ import annotations

import json
import os
import shutil
import socketserver
import tempfile
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler
from pathlib import Path

import pytest

from octichq_airlock_sdk import receipts
from octichq_airlock_sdk.receipts import record_receipt, sealed_input
from octichq_airlock_sdk.spool import ManifestInput, Spool, SpoolOptions

DIGEST = "sha256:" + "a" * 64
FI_RECEIVED: dict[str, str | int] = {
    "airlock.destination": "aa.example.in",
    "airlock.bytes": 1234,
    "airlock.ciphertext.digest": DIGEST,
    "airlock.duration.ms": 80,
}


@pytest.fixture
def spool_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("OCTIC_SPOOL_DIR", str(tmp_path))
    receipts._reset_for_tests()
    return tmp_path


def files(directory: Path) -> list[Path]:
    return sorted(directory.glob("receipt-*.json"))


def test_a_valid_receipt_is_written_with_ints_as_strings(spool_dir: Path) -> None:
    assert record_receipt("fi.received", FI_RECEIVED) is True
    [path] = files(spool_dir)
    assert oct(path.stat().st_mode & 0o777) == "0o600"
    body = json.loads(path.read_text())
    assert body["receiptFormatVersion"] == 1
    assert body["type"] == "fi.received"
    assert body["attributes"]["airlock.bytes"] == "1234"
    assert body["attributes"]["airlock.duration.ms"] == "80"
    assert body["occurredAt"].endswith("Z")
    assert list(spool_dir.glob("*.tmp")) == []


def test_an_off_vocabulary_attribute_is_false_and_writes_nothing(spool_dir: Path) -> None:
    assert record_receipt("fi.received", {**FI_RECEIVED, "airlock.note": "x"}) is False
    assert files(spool_dir) == []


@pytest.mark.parametrize(
    ("type_", "attributes"),
    [
        ("nope.nothing", {}),
        ("input.read", {}),  # missing required
        ("input.read", {"airlock.bytes": "01"}),  # leading zero
        ("input.read", {"airlock.bytes": -1}),
        ("input.read", {"airlock.bytes": True}),
        ("input.read", {"airlock.bytes": 2**53}),
        ("input.read", {"airlock.bytes": "5\n"}),
        ("output.refused", {"airlock.refusal.reason": "Has Space"}),
        ("fi.received", {**FI_RECEIVED, "airlock.ciphertext.digest": DIGEST + "\n"}),
    ],
)
def test_a_failed_check_writes_nothing(
    spool_dir: Path, type_: str, attributes: dict[str, str | int]
) -> None:
    assert record_receipt(type_, attributes) is False
    assert files(spool_dir) == []


def test_the_257th_receipt_is_refused(spool_dir: Path) -> None:
    for _ in range(256):
        assert record_receipt("input.read", {"airlock.bytes": 1}) is True
    assert record_receipt("input.read", {"airlock.bytes": 1}) is False
    assert len(files(spool_dir)) == 256


def test_a_full_span_spool_never_evicts_a_receipt(spool_dir: Path) -> None:
    manifest = ManifestInput(
        endpoint="https://ingest.example.test/",
        service_name="svc",
        octic_schema_version="1",
        sdk_name="octichq-airlock-sdk",
        sdk_version="0.0.0",
        content_capture="full",
    )
    spool = Spool(
        SpoolOptions(dir=str(spool_dir), max_files=1, on_overflow="evict-oldest"), manifest
    )
    assert record_receipt("input.read", {"airlock.bytes": 1}) is True
    for _ in range(3):
        assert spool.write("traces", b'{"resourceSpans":[]}') is True
    assert len(files(spool_dir)) == 1
    assert len(list(spool_dir.glob("*.otlp.json"))) == 1


def test_it_writes_before_init_and_returns_false_on_an_unwritable_spool(
    spool_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert record_receipt("input.read", {"airlock.bytes": 1}) is True
    blocker = spool_dir / "file"
    blocker.write_text("")
    monkeypatch.setenv("OCTIC_SPOOL_DIR", str(blocker / "sub"))
    monkeypatch.setattr("octichq_airlock_sdk.spool._default_directories", lambda: [blocker / "sub"])
    receipts._reset_for_tests()
    assert record_receipt("input.read", {"airlock.bytes": 1}) is False


def test_an_unsafe_configured_spool_is_false_even_when_spans_fell_through(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Airlock reads only the directory it named, so a receipt anywhere else is lost.
    unsafe = tmp_path / "unsafe"
    unsafe.mkdir()
    unsafe.chmod(0o777)
    fallback = tmp_path / "fallback"
    monkeypatch.setenv("OCTIC_SPOOL_DIR", str(unsafe))
    monkeypatch.setattr(
        "octichq_airlock_sdk.spool._default_directories", lambda: [unsafe, fallback]
    )
    receipts._reset_for_tests()
    manifest = ManifestInput(
        endpoint="https://ingest.example.test/",
        service_name="svc",
        octic_schema_version="1",
        sdk_name="octichq-airlock-sdk",
        sdk_version="0.0.0",
        content_capture="full",
    )
    spool = Spool(SpoolOptions(), manifest)
    assert spool.write("traces", b'{"resourceSpans":[]}') is True
    assert spool.directory == str(fallback)

    assert record_receipt("input.read", {"airlock.bytes": 1}) is False
    assert files(fallback) == []
    assert files(unsafe) == []
    spool.shutdown()


# -- the sealed input -----------------------------------------------------------


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/v0/data/sealed":
            self.send_response(200)
            self.send_header("Content-Length", "6")
            self.end_headers()
            self.wfile.write(b"sealed")
        else:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()

    def log_message(self, fmt: str, *args: object) -> None:
        pass


@pytest.fixture
def gate() -> Iterator[str]:
    # Unix socket paths are short on macOS; pytest's tmp_path is not.
    directory = tempfile.mkdtemp(dir="/tmp")
    path = os.path.join(directory, "g.sock")
    server = socketserver.ThreadingUnixStreamServer(path, _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield path
    server.shutdown()
    server.server_close()
    shutil.rmtree(directory, ignore_errors=True)


def test_sealed_input_reads_the_blob_from_the_gate(
    gate: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_blind")
    monkeypatch.setenv("AIRLOCK_GATE_SOCKET", gate)
    assert sealed_input() == b"sealed"


def test_sealed_input_is_none_without_data_blind(
    gate: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AIRLOCK_GATE_SOCKET", gate)
    monkeypatch.delenv("AIRLOCK_RUN_MODE", raising=False)
    assert sealed_input() is None
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "standard")
    assert sealed_input() is None


def test_sealed_input_is_none_when_the_gate_is_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_blind")
    monkeypatch.delenv("AIRLOCK_GATE_SOCKET", raising=False)
    assert sealed_input() is None
    monkeypatch.setenv("AIRLOCK_GATE_SOCKET", str(tmp_path / "absent.sock"))
    assert sealed_input() is None


def test_each_distinct_refusal_warns_once(
    spool_dir: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("AIRLOCK_RUN_MODE", "data_blind")
    monkeypatch.delenv("AIRLOCK_GATE_SOCKET", raising=False)
    with caplog.at_level("WARNING", logger="octichq_airlock_sdk"):
        assert record_receipt("not.a.type", {}) is False
        assert record_receipt("not.a.type", {}) is False
        assert sealed_input() is None
    messages = [record.getMessage() for record in caplog.records]
    assert len(messages) == 2
    assert "vocabulary" in messages[0]
    assert "AIRLOCK_GATE_SOCKET" in messages[1]
