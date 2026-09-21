"""The on-disk spool: where telemetry goes, and in the first release the only place.

A separate process reads this directory and delivers the batches. That process
is not in this package, which makes the on-disk shape a contract rather than an
implementation detail — it is specified in ``contract/SPOOL.md`` and versioned by
``SPOOL_FORMAT_VERSION``. Conformance to that document is what this file is
judged against; ``node/src/spool.ts`` is the other writer, not the reference.

It is a fraction of the Node writer's size, and the difference is the threading
model rather than a shortcut. ``BatchSpanProcessor`` calls ``export()`` on its own
worker thread, so a blocking ``os.write`` and ``os.replace`` are simply correct
here: there is no pending queue, no promise chain, and no synchronous drain at
exit. What a process loses by exiting without ``shutdown()`` is what was still in
the batch processor's queue — the same contract ``batching.py`` states.

Two properties outrank every other consideration, because this runs inside
somebody else's process on their machines:

    never hurt the host   no raise out of a write, no unbounded memory, and a
                          hard self-disable when the filesystem says no
    never leak            these files can hold prompts. 0700 directory, 0600
                          files, and a directory we refuse to use unless we own
                          it and nobody else can write to it

Redaction is somebody else's job and already done: the spool sits *inside*
``RedactingSpanExporter``, so what reaches it has been through the content policy.
"""

from __future__ import annotations

import contextlib
import errno
import hashlib
import json
import logging
import os
import secrets
import stat
import tempfile
import threading
import time
import weakref
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

log = logging.getLogger("octic_telemetry")

#: Bumped when the on-disk shape changes in a way a reader must notice.
SPOOL_FORMAT_VERSION = 1

#: The suffix a finished batch has. Readers glob for it; ``.tmp`` is in progress.
SEGMENT_SUFFIX = ".otlp.json"
_TMP_SUFFIX = ".tmp"
_MANIFEST_PREFIX = "manifest-"

SpoolOverflow = Literal["evict-oldest", "drop-new"]
SpoolSignal = Literal["traces", "logs"]

_MIB = 1024 * 1024

#: How long a filesystem gets to be broken before we probe it again.
DISABLE_BACKOFF_SECONDS = 60.0

#: A reader deletes files behind our back, so the accounting is re-derived.
_USAGE_RESCAN_SECONDS = 60.0

#: Errors that mean the filesystem is not going to cooperate any time soon.
_FATAL_ERRNOS = frozenset(
    code
    for code in (
        errno.EACCES,
        errno.EPERM,
        errno.ENOSPC,
        errno.EROFS,
        getattr(errno, "EDQUOT", None),
        errno.EMFILE,
        errno.ENFILE,
    )
    if code is not None
)


@dataclass(frozen=True)
class SpoolOptions:
    """Where the spool lives and how much it may hold.

    There is no ``enabled`` and no ``mode``. Node has both because its spool is a
    fallback behind an HTTP transport; this SDK has no transport yet, so the
    spool is the sink and switching it off would switch telemetry off.
    """

    #: Else ``OCTIC_SPOOL_DIR``, else the cascade in ``_default_directories``.
    dir: str | None = None
    #: Bytes of finished segments to keep.
    max_bytes: int = 64 * _MIB
    #: Segments to keep.
    max_files: int = 10_000
    #: Age at which a segment is deleted unread.
    max_age_seconds: float = 72 * 60 * 60
    #: What to do when a bound is hit.
    on_overflow: SpoolOverflow = "evict-oldest"
    #: ``fsync`` each segment before the rename.
    fsync: bool = True


@dataclass(frozen=True)
class SpoolStats:
    #: Segments successfully renamed into place.
    written: int
    #: Bytes the finished segments on disk hold, as last accounted.
    bytes: int
    #: Batches the spool refused or discarded before they reached disk.
    dropped: int
    #: Finished segments deleted to stay inside the bounds.
    evicted: int
    #: Write attempts that failed.
    failures: int
    #: Whether the spool has switched itself off for now.
    disabled: bool
    #: Where it settled, once resolution has run.
    dir: str | None


@dataclass(frozen=True)
class ManifestInput:
    """What a reader needs to deliver these files, and nothing else.

    Deliberately carries no credential: the reader brings its own. A manifest
    that grows one is a bug, which is why there is no field here to put one in.
    """

    endpoint: str
    service_name: str
    octic_schema_version: str
    sdk_name: str
    sdk_version: str
    content_capture: str
    content_type: str = "application/json"
    content_encoding: str = "identity"


_SIGNAL_PATHS: dict[str, str] = {"traces": "/v1/traces", "logs": "/v1/logs"}


def _default_directories() -> list[Path]:
    """Where to look, in order, first usable wins.

    ``/var/spool/octic`` is the intended home and the one an operator provisions.
    It is also unwritable for the unprivileged process most consumers run, which
    is why it is one candidate rather than the answer — a spool that requires
    root is a spool nobody has.
    """
    candidates: list[Path] = []
    configured = os.environ.get("OCTIC_SPOOL_DIR", "")
    if configured:
        candidates.append(Path(configured))

    candidates.append(Path("/var/spool/octic"))

    state = os.environ.get("XDG_STATE_HOME", "")
    candidates.append(
        Path(state) / "octic" / "spool"
        if state
        else Path.home() / ".local" / "state" / "octic" / "spool"
    )

    uid = os.getuid() if hasattr(os, "getuid") else "user"
    candidates.append(Path(tempfile.gettempdir()) / f"octic-spool-{uid}")
    return candidates


def _is_safe_directory(path: Path) -> bool:
    """Whether a directory is one we are willing to put prompts in.

    The three refusals are the classic ones: a symlink means somebody else chose
    the real destination, an owner that is not us means somebody else can read
    it, and a group- or world-writable directory means somebody else can swap
    files under a reader that trusts them. Windows reports none of this usefully,
    so the guarantee is POSIX, as it is in the Node writer.
    """
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        return False
    if not hasattr(os, "getuid"):
        return True
    if info.st_uid != os.getuid():
        return False
    return info.st_mode & 0o022 == 0


def _new_writer_id() -> str:
    """Opaque and unique per instance. The pid alone is not: threads share one."""
    return f"{os.getpid()}{secrets.token_hex(3)}"


# Every live spool, so a fork can give each of them a new writer id. Weak, so the
# registry is never the reason a spool outlives its pipeline.
_live: weakref.WeakSet[Spool] = weakref.WeakSet()


def _after_fork_in_child() -> None:
    for spool in list(_live):
        spool._forked()


# A forked worker inherits the parent's writer id *and* its sequence counter, so
# parent and child would mint the same segment name and one of them would lose
# the `O_EXCL` race on the `.tmp`. Node has no fork; this is Python's alone.
if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_after_fork_in_child)


class Spool:
    """Takes custody of serialized export batches and puts them on disk.

    Every public method is safe to call from any thread and none of them raises.
    """

    def __init__(
        self,
        options: SpoolOptions,
        manifest: ManifestInput,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.options = options
        self._clock = clock
        self._lock = threading.Lock()

        self._manifest: dict[str, object] = {
            "spoolFormatVersion": SPOOL_FORMAT_VERSION,
            "endpoint": manifest.endpoint.rstrip("/"),
            "signalPaths": dict(_SIGNAL_PATHS),
            "contentType": manifest.content_type,
            "contentEncoding": manifest.content_encoding,
            "serviceName": manifest.service_name,
            "octicSchemaVersion": manifest.octic_schema_version,
            "sdkName": manifest.sdk_name,
            "sdkVersion": manifest.sdk_version,
            "contentCapture": manifest.content_capture,
        }
        # The id covers everything except the timestamp, so two processes with
        # the same configuration share a manifest and two with different
        # endpoints cannot have their segments confused. `sdkName` is part of the
        # input, so a Python and a Node writer never share one — which is why the
        # hash only has to be stable within Python, not match Node's bytes.
        identity = json.dumps(self._manifest, sort_keys=True, separators=(",", ":"))
        self.manifest_id = hashlib.sha256(identity.encode()).hexdigest()[:8]
        self._manifest["createdAt"] = (
            datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        )

        self._writer_id = _new_writer_id()
        self._seq = 0

        self._dir: Path | None = None
        self._resolved = False
        self._manifest_written = False

        self._disabled_until = 0.0
        self._shut_down = False
        self._announced = False
        self._announced_eviction = False

        self._bytes_on_disk = 0
        self._files_on_disk = 0
        self._usage_scanned_at: float | None = None

        self._written = 0
        self._dropped = 0
        self._evicted = 0
        self._failures = 0

        _live.add(self)

    # -- public ---------------------------------------------------------------

    @property
    def directory(self) -> str | None:
        """Where it settled. ``None`` until the cascade has run, and if it found nothing."""
        return None if self._dir is None else str(self._dir)

    def stats(self) -> SpoolStats:
        with self._lock:
            return SpoolStats(
                written=self._written,
                bytes=self._bytes_on_disk,
                dropped=self._dropped,
                evicted=self._evicted,
                failures=self._failures,
                disabled=self._is_disabled(),
                dir=self.directory,
            )

    def write(self, signal: SpoolSignal, body: bytes) -> bool:
        """Writes one serialized export batch, and says whether it landed.

        The answer is what the exporter reports upstream: a refusal has to stay a
        failure, or a consumer whose disk is full is told their telemetry is fine.
        """
        with self._lock:
            try:
                return self._write(signal, body)
            except Exception:
                # Every path below already catches what it expects. This is the
                # one for what nobody expected, and the host still does not see it.
                log.warning("octic-telemetry: spool write failed unexpectedly", exc_info=True)
                self._failures += 1
                return False

    def shutdown(self) -> None:
        """Refuses anything further. Writes are synchronous, so nothing is pending."""
        with self._lock:
            self._shut_down = True

    # -- internals ------------------------------------------------------------

    def _forked(self) -> None:
        """In the child, right after ``fork()``. The lock may be held by a thread
        that no longer exists here, so it is replaced rather than acquired."""
        self._lock = threading.Lock()
        self._writer_id = _new_writer_id()
        self._seq = 0

    def _is_disabled(self) -> bool:
        return self._clock() < self._disabled_until

    def _disable(self) -> None:
        self._disabled_until = self._clock() + DISABLE_BACKOFF_SECONDS

    def _write(self, signal: SpoolSignal, body: bytes) -> bool:
        if self._shut_down or self._is_disabled():
            self._dropped += 1
            return False

        directory = self._resolve_dir()
        if directory is None:
            self._dropped += 1
            return False

        self._write_manifest(directory)
        self._refresh_usage(directory)
        if self._is_disabled():
            self._dropped += 1
            return False

        if not self._make_room(directory, len(body)):
            self._dropped += 1
            return False

        if not self._write_segment(directory, signal, body):
            self._failures += 1
            return False
        return True

    def _resolve_dir(self) -> Path | None:
        """The directory cascade, on the first write rather than in ``init()``.

        An unusable result is retried after the backoff rather than remembered
        forever: a volume that was not mounted yet at startup is a real
        deployment, and "it failed once" is not "it will always fail".
        """
        if self._dir is not None:
            return self._dir
        if self._resolved and self._is_disabled():
            return None

        candidates = (
            [Path(self.options.dir)] if self.options.dir is not None else _default_directories()
        )
        for candidate in candidates:
            try:
                candidate.mkdir(mode=0o700, parents=True, exist_ok=True)
                if not _is_safe_directory(candidate):
                    continue
                # mkdir's mode is masked by umask and ignored when the directory
                # already existed, so set it explicitly either way.
                if hasattr(os, "getuid"):
                    os.chmod(candidate, 0o700)
                # Random, not just pid and clock: two processes probing the same
                # directory at once would otherwise collide on `O_EXCL`.
                probe = candidate / f".probe-{os.getpid()}-{secrets.token_hex(6)}"
                fd = os.open(probe, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                os.close(fd)
                os.unlink(probe)
            except OSError:
                continue

            self._dir = candidate
            self._resolved = True
            log.info("octic-telemetry: spooling telemetry to %s", candidate)
            return candidate

        self._resolved = True
        log.warning(
            "octic-telemetry: no usable spool directory (tried %s); telemetry will be "
            "dropped until one is. Retrying in %ds.",
            ", ".join(str(candidate) for candidate in candidates),
            int(DISABLE_BACKOFF_SECONDS),
        )
        self._disable()
        return None

    def _note_failure(self, error: OSError, what: str) -> None:
        if error.errno in _FATAL_ERRNOS:
            log.warning(
                "octic-telemetry: spool %s failed with %s; pausing for %ds.",
                what,
                errno.errorcode.get(error.errno or 0, str(error.errno)),
                int(DISABLE_BACKOFF_SECONDS),
            )
            self._disable()

    def _write_manifest(self, directory: Path) -> None:
        if self._manifest_written:
            return
        path = directory / f"{_MANIFEST_PREFIX}{self.manifest_id}.json"
        try:
            # `O_EXCL`: whoever wrote it first wrote the same identity.
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            self._manifest_written = True
            return
        except OSError as error:
            self._note_failure(error, "manifest write")
            return
        try:
            _fchmod(fd, 0o600)
            _write_all(fd, (json.dumps(self._manifest, indent=2) + "\n").encode())
            self._manifest_written = True
        except OSError as error:
            self._note_failure(error, "manifest write")
        finally:
            os.close(fd)

    def _segment_name(self, signal: SpoolSignal) -> str:
        """``<signal>-<epochMs>-<seq>-<writer>-<manifest>.otlp.json``, per SPOOL.md."""
        self._seq += 1
        epoch_ms = time.time_ns() // 1_000_000
        return (
            f"{signal}-{epoch_ms}-{self._seq:06d}-{self._writer_id}-{self.manifest_id}"
            f"{SEGMENT_SUFFIX}"
        )

    def _write_segment(self, directory: Path, signal: SpoolSignal, body: bytes) -> bool:
        """Write, then rename.

        A reader can therefore never see a partial batch: the name it globs for
        only exists once every byte is on disk, and a crash mid-write leaves a
        ``.tmp`` that both sides ignore.
        """
        final = directory / self._segment_name(signal)
        tmp = final.with_name(final.name + _TMP_SUFFIX)
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                # Explicit, because open's mode is masked by the host's umask.
                _fchmod(fd, 0o600)
                _write_all(fd, body)
                if self.options.fsync:
                    os.fsync(fd)
            finally:
                os.close(fd)
            os.replace(tmp, final)
        except OSError as error:
            self._note_failure(error, "segment write")
            with contextlib.suppress(OSError):
                os.unlink(tmp)
            return False

        self._written += 1
        self._files_on_disk += 1
        self._bytes_on_disk += len(body)
        if not self._announced:
            self._announced = True
            log.info("octic-telemetry: first spooled batch written to %s", final)
        return True

    def _list_segments(self, directory: Path) -> list[tuple[Path, int, float]]:
        """Finished segments, oldest first by mtime. ``.tmp`` is an in-flight write."""
        segments: list[tuple[Path, int, float]] = []
        with os.scandir(directory) as entries:
            for entry in entries:
                if not entry.name.endswith(SEGMENT_SUFFIX):
                    continue
                try:
                    info = entry.stat(follow_symlinks=False)
                except OSError:
                    # The reader deleted it between the listing and the stat.
                    continue
                if not stat.S_ISREG(info.st_mode):
                    continue
                segments.append((Path(entry.path), info.st_size, info.st_mtime))
        segments.sort(key=lambda segment: segment[2])
        return segments

    def _refresh_usage(self, directory: Path) -> None:
        """Re-derives what is on disk, and drops what has aged out while there.

        The age limit rides along with the scan rather than getting its own pass
        because the scan is the expensive part, and because an undelivered batch
        from three days ago is a batch nobody is coming for.
        """
        now = self._clock()
        if (
            self._usage_scanned_at is not None
            and now - self._usage_scanned_at < _USAGE_RESCAN_SECONDS
        ):
            return
        self._usage_scanned_at = now

        try:
            found = self._list_segments(directory)
        except OSError as error:
            self._note_failure(error, "usage scan")
            return

        cutoff = time.time() - self.options.max_age_seconds
        kept: list[tuple[Path, int, float]] = []
        for segment in found:
            if segment[2] >= cutoff:
                kept.append(segment)
                continue
            try:
                os.unlink(segment[0])
                self._evicted += 1
            except FileNotFoundError:
                pass
            except OSError:
                kept.append(segment)

        self._files_on_disk = len(kept)
        self._bytes_on_disk = sum(size for _, size, _ in kept)

    def _make_room(self, directory: Path, incoming: int) -> bool:
        """Enforces the bounds.

        Under ``evict-oldest`` the reader can lose a file it is mid-way through
        delivering. That is safe rather than merely tolerable: POSIX keeps an
        open descriptor valid after unlink, and SPOOL.md requires the reader to
        treat a vanished file as done.
        """

        def over() -> bool:
            return (
                self._bytes_on_disk + incoming > self.options.max_bytes
                or self._files_on_disk + 1 > self.options.max_files
            )

        if not over():
            return True
        if self.options.on_overflow == "drop-new":
            return False

        try:
            segments = self._list_segments(directory)
        except OSError as error:
            self._note_failure(error, "eviction")
            return False

        self._files_on_disk = len(segments)
        self._bytes_on_disk = sum(size for _, size, _ in segments)
        for path, size, _ in segments:
            if not over():
                break
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass
            except OSError:
                # Not ours to delete, apparently. Move on to the next oldest.
                continue
            self._files_on_disk -= 1
            self._bytes_on_disk -= size
            self._evicted += 1

        if self._evicted > 0 and not self._announced_eviction:
            self._announced_eviction = True
            log.warning(
                "octic-telemetry: spool at %s is full; deleting the oldest undelivered "
                "batches. Is the spool reader running?",
                directory,
            )
        return not over()


def _write_all(fd: int, data: bytes) -> None:
    """``os.write`` may write less than asked. A short segment is a corrupt one."""
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        view = view[written:]


def _fchmod(fd: int, mode: int) -> None:
    if hasattr(os, "fchmod"):
        os.fchmod(fd, mode)
