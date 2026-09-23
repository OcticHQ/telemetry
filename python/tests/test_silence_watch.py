"""The one warning for a pipeline that is producing spans and writing nothing.

Drives the real timer with a short delay rather than mocking it, which is the
only reason `configure` takes one.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Iterator

import pytest

from octichq_airlock_sdk import silence_watch

DELAY = 0.05


@pytest.fixture(autouse=True)
def disarmed() -> Iterator[None]:
    yield
    silence_watch.cancel()


def warnings_in(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [
        record.getMessage()
        for record in caplog.records
        if record.levelno == logging.WARNING and "no spool segment" in record.getMessage()
    ]


def wait_for_warning(caplog: pytest.LogCaptureFixture, deadline: float = 2.0) -> list[str]:
    end = time.monotonic() + deadline
    while time.monotonic() < end:
        if warnings_in(caplog):
            break
        time.sleep(0.01)
    return warnings_in(caplog)


def test_it_warns_once_when_nothing_is_written(caplog: pytest.LogCaptureFixture) -> None:
    silence_watch.configure(DELAY)
    silence_watch.note_span_started()
    silence_watch.note_span_started()

    assert len(wait_for_warning(caplog)) == 1


def test_an_accepted_export_disarms_it(caplog: pytest.LogCaptureFixture) -> None:
    silence_watch.configure(DELAY)
    silence_watch.note_span_started()
    silence_watch.note_export_succeeded()

    time.sleep(DELAY * 3)
    assert warnings_in(caplog) == []


def test_shutdown_disarms_it(caplog: pytest.LogCaptureFixture) -> None:
    silence_watch.configure(DELAY)
    silence_watch.note_span_started()
    silence_watch.cancel()

    time.sleep(DELAY * 3)
    assert warnings_in(caplog) == []


def test_spans_before_init_arm_nothing(caplog: pytest.LogCaptureFixture) -> None:
    """Before `init()`, spans have nowhere to go by design; that is not silence."""
    silence_watch.cancel()
    silence_watch.note_span_started()

    assert silence_watch._timer is None


def test_the_timer_never_keeps_a_process_alive() -> None:
    silence_watch.configure(60)
    silence_watch.note_span_started()

    assert silence_watch._timer is not None
    assert silence_watch._timer.daemon is True
