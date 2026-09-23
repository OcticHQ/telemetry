"""The writer, checked against contract/SPOOL.md one clause at a time.

The document is the acceptance criterion, not the Node writer: a reader written
against SPOOL.md has to be able to deliver this directory without knowing which
SDK produced it.
"""

from __future__ import annotations

import json
import os
import re
import stat
import sys
from pathlib import Path

import pytest

from octichq_airlock_sdk.spool import (
    DISABLE_BACKOFF_SECONDS,
    SEGMENT_SUFFIX,
    SPOOL_FORMAT_VERSION,
    ManifestInput,
    Spool,
    SpoolOptions,
)

POSIX = hasattr(os, "getuid")
ROOT = POSIX and os.geteuid() == 0

MANIFEST = ManifestInput(
    endpoint="https://ingest.example.test/",
    service_name="svc",
    octic_schema_version="1",
    sdk_name="octichq-airlock-sdk",
    sdk_version="0.0.0",
    content_capture="full",
)

BODY = b'{"resourceSpans":[]}'

SEGMENT_NAME = re.compile(r"^traces-(\d+)-(\d{6})-([0-9a-f]+)-([0-9a-f]{8})\.otlp\.json$")


class Clock:
    """Monotonic time the test moves by hand, so a 60s backoff costs nothing."""

    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


def make(directory: Path, clock: Clock | None = None, **options: object) -> tuple[Spool, Clock]:
    clock = clock or Clock()
    spool = Spool(
        SpoolOptions(dir=str(directory), fsync=False, **options),  # type: ignore[arg-type]
        MANIFEST,
        clock=clock,
    )
    return spool, clock


def segments(directory: Path) -> list[Path]:
    return sorted(path for path in directory.iterdir() if path.name.endswith(SEGMENT_SUFFIX))


def manifests(directory: Path) -> list[Path]:
    return sorted(directory.glob("manifest-*.json"))


def test_a_segment_is_the_body_verbatim_under_the_documented_name(tmp_path: Path) -> None:
    spool, _ = make(tmp_path / "spool")

    assert spool.write("traces", BODY) is True

    [segment] = segments(tmp_path / "spool")
    match = SEGMENT_NAME.match(segment.name)
    assert match is not None, segment.name
    assert match.group(4) == spool.manifest_id
    # The file is the HTTP body: no framing, no trailing newline.
    assert segment.read_bytes() == BODY


def test_no_tmp_file_is_left_behind(tmp_path: Path) -> None:
    spool, _ = make(tmp_path / "spool")
    for _ in range(3):
        spool.write("traces", BODY)

    leftovers = [path for path in (tmp_path / "spool").iterdir() if path.name.endswith(".tmp")]
    assert leftovers == []


def test_the_sequence_orders_batches_written_in_the_same_millisecond(tmp_path: Path) -> None:
    spool, _ = make(tmp_path / "spool")
    for _ in range(3):
        spool.write("traces", BODY)

    sequence = [SEGMENT_NAME.match(path.name).group(2) for path in segments(tmp_path / "spool")]  # type: ignore[union-attr]
    assert sorted(sequence) == ["000001", "000002", "000003"]


def test_the_manifest_carries_exactly_the_documented_fields(tmp_path: Path) -> None:
    spool, _ = make(tmp_path / "spool")
    spool.write("traces", BODY)

    [path] = manifests(tmp_path / "spool")
    assert path.name == f"manifest-{spool.manifest_id}.json"
    manifest = json.loads(path.read_text())

    assert set(manifest) == {
        "spoolFormatVersion",
        "endpoint",
        "signalPaths",
        "contentType",
        "contentEncoding",
        "serviceName",
        "octicSchemaVersion",
        "sdkName",
        "sdkVersion",
        "contentCapture",
        "createdAt",
    }
    assert manifest["spoolFormatVersion"] == SPOOL_FORMAT_VERSION
    assert manifest["endpoint"] == "https://ingest.example.test"
    assert manifest["signalPaths"] == {"traces": "/v1/traces", "logs": "/v1/logs"}
    assert manifest["contentType"] == "application/json"
    assert manifest["contentEncoding"] == "identity"
    assert manifest["sdkName"] == "octichq-airlock-sdk"
    assert manifest["createdAt"].endswith("Z")


def test_the_manifest_never_carries_a_credential(tmp_path: Path) -> None:
    spool, _ = make(tmp_path / "spool")
    spool.write("traces", BODY)

    text = manifests(tmp_path / "spool")[0].read_text().lower()
    for word in ("token", "authorization", "apikey", "api_key", "secret", "bearer", "header"):
        assert word not in text


def test_the_manifest_id_ignores_created_at_and_covers_everything_else(tmp_path: Path) -> None:
    one, _ = make(tmp_path / "a")
    two, _ = make(tmp_path / "b")
    other = Spool(
        SpoolOptions(dir=str(tmp_path / "c")),
        ManifestInput(**{**MANIFEST.__dict__, "endpoint": "https://elsewhere.test"}),
    )

    assert one.manifest_id == two.manifest_id
    assert one.manifest_id != other.manifest_id


def test_an_existing_manifest_is_left_alone(tmp_path: Path) -> None:
    directory = tmp_path / "spool"
    spool, _ = make(directory)
    directory.mkdir(mode=0o700)
    existing = directory / f"manifest-{spool.manifest_id}.json"
    existing.write_text("written by the first process\n")

    assert spool.write("traces", BODY) is True
    assert existing.read_text() == "written by the first process\n"


@pytest.mark.skipif(not POSIX, reason="the mode guarantee is POSIX")
def test_the_directory_is_0700_and_the_files_0600(tmp_path: Path) -> None:
    directory = tmp_path / "spool"
    spool, _ = make(directory)
    spool.write("traces", BODY)

    assert stat.S_IMODE(directory.stat().st_mode) == 0o700
    for path in directory.iterdir():
        assert stat.S_IMODE(path.stat().st_mode) == 0o600, path.name


@pytest.mark.skipif(not POSIX, reason="the ownership checks are POSIX")
def test_a_symlinked_directory_is_refused(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir(mode=0o700)
    link = tmp_path / "link"
    link.symlink_to(real)

    spool, _ = make(link)
    assert spool.write("traces", BODY) is False
    assert spool.stats().disabled is True
    assert list(real.iterdir()) == []


@pytest.mark.skipif(not POSIX, reason="the ownership checks are POSIX")
def test_a_group_writable_directory_is_refused(tmp_path: Path) -> None:
    directory = tmp_path / "shared"
    directory.mkdir()
    directory.chmod(0o770)

    spool, _ = make(directory)
    assert spool.write("traces", BODY) is False
    assert list(directory.iterdir()) == []


def test_drop_new_refuses_the_batch_that_would_overflow(tmp_path: Path) -> None:
    spool, _ = make(tmp_path / "spool", max_files=2, on_overflow="drop-new")

    assert [spool.write("traces", BODY) for _ in range(3)] == [True, True, False]
    assert len(segments(tmp_path / "spool")) == 2
    assert spool.stats().dropped == 1


def test_evict_oldest_deletes_by_mtime_to_make_room(tmp_path: Path) -> None:
    directory = tmp_path / "spool"
    spool, _ = make(directory, max_files=2)
    spool.write("traces", BODY)
    spool.write("traces", BODY)
    oldest, newer = segments(directory)
    # Same-millisecond writes can share an mtime; make the order unambiguous.
    os.utime(oldest, (1, 1))

    assert spool.write("traces", BODY) is True
    remaining = segments(directory)
    assert oldest not in remaining
    assert newer in remaining
    assert len(remaining) == 2
    assert spool.stats().evicted == 1


def test_the_byte_bound_is_enforced_as_well_as_the_count(tmp_path: Path) -> None:
    spool, _ = make(tmp_path / "spool", max_bytes=len(BODY) * 2, on_overflow="drop-new")

    assert [spool.write("traces", BODY) for _ in range(3)] == [True, True, False]


def test_segments_past_the_age_limit_go_on_the_next_scan(tmp_path: Path) -> None:
    directory = tmp_path / "spool"
    spool, clock = make(directory, max_age_seconds=60)
    spool.write("traces", BODY)
    [stale] = segments(directory)
    os.utime(stale, (1, 1))

    # The usage scan is rate-limited; move past it.
    clock.now += 61
    spool.write("traces", BODY)

    assert stale not in segments(directory)
    assert len(segments(directory)) == 1


def test_a_file_the_reader_already_deleted_is_not_an_error(tmp_path: Path) -> None:
    directory = tmp_path / "spool"
    spool, _ = make(directory, max_files=1)
    spool.write("traces", BODY)
    for path in segments(directory):
        path.unlink()

    assert spool.write("traces", BODY) is True


@pytest.mark.skipif(not POSIX or ROOT, reason="needs permissions that bind the process")
def test_an_unusable_directory_disables_and_is_retried_after_the_backoff(tmp_path: Path) -> None:
    parent = tmp_path / "locked"
    parent.mkdir()
    parent.chmod(0o500)
    try:
        spool, clock = make(parent / "spool")

        assert spool.write("traces", BODY) is False
        assert spool.stats().disabled is True

        # Still inside the backoff: refused without touching the filesystem.
        parent.chmod(0o700)
        assert spool.write("traces", BODY) is False

        clock.now += DISABLE_BACKOFF_SECONDS + 1
        assert spool.write("traces", BODY) is True
        assert spool.stats().disabled is False
    finally:
        parent.chmod(0o700)


def test_a_path_that_is_a_file_is_refused_without_raising(tmp_path: Path) -> None:
    occupied = tmp_path / "occupied"
    occupied.write_text("not a directory")

    spool, _ = make(occupied)
    assert spool.write("traces", BODY) is False


def test_a_shut_down_spool_refuses_further_batches(tmp_path: Path) -> None:
    spool, _ = make(tmp_path / "spool")
    spool.shutdown()

    assert spool.write("traces", BODY) is False
    assert spool.stats().dropped == 1


def test_stats_report_where_the_spool_settled(tmp_path: Path) -> None:
    directory = tmp_path / "spool"
    spool, _ = make(directory)
    assert spool.directory is None

    spool.write("traces", BODY)
    stats = spool.stats()

    assert stats.dir == str(directory)
    assert (stats.written, stats.bytes, stats.failures) == (1, len(BODY), 0)


@pytest.mark.skipif(not hasattr(os, "fork"), reason="fork is POSIX")
def test_a_forked_child_writes_under_a_new_writer_id(tmp_path: Path) -> None:
    """Parent and child would otherwise mint identical names and race on `O_EXCL`."""
    directory = tmp_path / "spool"
    spool, _ = make(directory)
    spool.write("traces", BODY)

    pid = os.fork()
    if pid == 0:  # pragma: no cover - runs in the child
        code = 0 if spool.write("traces", BODY) else 1
        sys.stdout.flush()
        os._exit(code)
    _, status = os.waitpid(pid, 0)
    assert os.waitstatus_to_exitcode(status) == 0

    writers = {SEGMENT_NAME.match(path.name).group(3) for path in segments(directory)}  # type: ignore[union-attr]
    assert len(writers) == 2
