"""`init()` and `init_with_external_provider()`.

The suite's own global tracer provider is set once in conftest.py, and Python will
not replace it. So everything that needs a real `init()` to *register* runs in a
fresh interpreter, and everything else runs here — where, usefully, the provider
conftest set is exactly the "another SDK got there first" case.
"""

from __future__ import annotations

import json
import logging
import subprocess
import sys
import textwrap
from collections.abc import Iterator
from pathlib import Path

import pytest
from opentelemetry.sdk.trace import TracerProvider

import octichq_airlock_sdk.pipeline as init_module
from octichq_airlock_sdk import (
    ATTR,
    Agent,
    ContentOptions,
    SpoolOptions,
    init,
    init_with_external_provider,
    silence_watch,
)
from octichq_airlock_sdk.content import active_policy, resolve_policy, set_active_policy
from octichq_airlock_sdk.spool import SEGMENT_SUFFIX


@pytest.fixture(autouse=True)
def fresh_process_state(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """What `init()` latches is process state; each test starts from none of it."""
    monkeypatch.setattr(init_module, "_state", None)
    monkeypatch.setattr(init_module, "_shut_down", False)
    yield
    state = init_module._state
    if state is not None and state.parts is not None:
        state.parts.export_processor.shutdown()
    silence_watch.cancel()
    set_active_policy(resolve_policy())


def segments(directory: Path) -> list[Path]:
    return sorted(path for path in directory.iterdir() if path.name.endswith(SEGMENT_SUFFIX))


def options(directory: Path, **overrides: object) -> dict[str, object]:
    return {
        "service_name": "svc",
        "endpoint": "https://ingest.example.test",
        "spool": SpoolOptions(dir=str(directory), fsync=False),
        **overrides,
    }


def test_external_parts_write_an_enriched_segment(tmp_path: Path) -> None:
    directory = tmp_path / "spool"
    telemetry = init_with_external_provider(
        **options(directory, environment="staging", agent=Agent(agent_id="loan-agent"))  # type: ignore[arg-type]
    )

    # The host SDK's provider, with our two processors handed over in order.
    host = TracerProvider(shutdown_on_exit=False)
    host.add_span_processor(telemetry.span_processor)
    host.add_span_processor(telemetry.export_processor)
    with host.get_tracer("host-sdk").start_as_current_span("host-span"):
        pass
    assert telemetry.force_flush() is True

    [segment] = segments(directory)
    [resource_spans] = json.loads(segment.read_bytes())["resourceSpans"]
    span = resource_spans["scopeSpans"][0]["spans"][0]
    stamped = {entry["key"]: entry["value"] for entry in span["attributes"]}

    # The resource is the host's, so provenance has to ride on the span.
    assert stamped[ATTR.OCTIC_SDK_NAME] == {"stringValue": "octichq-airlock-sdk"}
    assert stamped[ATTR.DEPLOYMENT_ENVIRONMENT_NAME] == {"stringValue": "staging"}
    assert stamped[ATTR.GEN_AI_AGENT_ID] == {"stringValue": "loan-agent"}
    assert telemetry.spool is not None
    assert telemetry.spool.directory() == str(directory)


def test_the_content_policy_is_installed_and_handed_back(tmp_path: Path) -> None:
    telemetry = init_with_external_provider(
        **options(tmp_path / "spool", content=ContentOptions(capture="none"))  # type: ignore[arg-type]
    )

    assert active_policy().capture == "none"
    assert telemetry.capture_content is False


def test_a_second_call_warns_and_returns_the_same_pipeline(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    first = init_with_external_provider(**options(tmp_path / "spool"))  # type: ignore[arg-type]
    second = init_with_external_provider(**options(tmp_path / "other"))  # type: ignore[arg-type]

    assert second.export_processor is first.export_processor
    assert "already initialized" in caplog.text


def test_init_degrades_when_another_sdk_owns_the_provider(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """conftest registered a provider already — the case a host SDK creates."""
    with caplog.at_level(logging.WARNING, logger="octichq_airlock_sdk"):
        telemetry = init(**options(tmp_path / "spool"))  # type: ignore[arg-type]

    assert "another SDK already registered" in caplog.text
    assert init_module._state is not None
    assert init_module._state.kind == "degraded"
    # The handle still works, and still never raises.
    assert telemetry.force_flush() is True
    telemetry.shutdown()


def test_a_failing_setup_never_raises(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    def explode(**_: object) -> None:
        raise RuntimeError("boom")

    monkeypatch.setattr(init_module, "_setup", explode)

    telemetry = init(service_name="svc", endpoint="https://ingest.example.test")
    external = init_with_external_provider(
        service_name="svc", endpoint="https://ingest.example.test"
    )

    assert telemetry.force_flush() is True
    telemetry.shutdown()
    assert external.span_exporter.export([]).name == "FAILURE"
    assert "init() failed" in caplog.text


def test_shutdown_is_latched(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A signal handler and a `finally` are two callers; the work happens once."""
    telemetry = init_with_external_provider(**options(tmp_path / "spool"))  # type: ignore[arg-type]
    processor = telemetry.export_processor
    calls: list[int] = []
    original = processor.shutdown

    def counted() -> None:
        calls.append(1)
        original()

    monkeypatch.setattr(processor, "shutdown", counted)

    telemetry.shutdown()
    telemetry.shutdown()

    assert calls == [1]


_OWN_PROVIDER = textwrap.dedent(
    """
    import json, logging, sys
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)

    from octichq_airlock_sdk import SpoolOptions, init, with_workflow

    spool = SpoolOptions(dir=sys.argv[1], fsync=False)
    telemetry = init(service_name="svc", endpoint="https://ingest.example.test", spool=spool)
    init(service_name="svc", endpoint="https://ingest.example.test", spool=spool)

    with with_workflow(name="chat-turn", input="hello") as run:
        run.set_output("hi")

    telemetry.shutdown()
    stats = telemetry.spool.stats()
    print(json.dumps({"written": stats.written, "dir": stats.dir}))
    """
)


def test_init_registers_a_provider_that_writes_the_spool(tmp_path: Path) -> None:
    """In a fresh interpreter, because this process's provider is already set."""
    directory = tmp_path / "spool"
    completed = subprocess.run(
        [sys.executable, "-c", _OWN_PROVIDER, str(directory)],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr

    stats = json.loads(completed.stdout)
    assert stats == {"written": 1, "dir": str(directory)}
    assert "already initialized" in completed.stderr
    # The atexit hook upstream registers by default would have run shutdown
    # twice; nothing complains because it was never registered.
    assert "Traceback" not in completed.stderr

    [segment] = segments(directory)
    [resource_spans] = json.loads(segment.read_bytes())["resourceSpans"]
    resource = {entry["key"]: entry["value"] for entry in resource_spans["resource"]["attributes"]}
    assert resource[ATTR.SERVICE_NAME] == {"stringValue": "svc"}
    assert resource[ATTR.OCTIC_SDK_NAME] == {"stringValue": "octichq-airlock-sdk"}
    assert ATTR.OCTIC_SCHEMA_VERSION in resource
    assert ATTR.OCTIC_SDK_VERSION in resource

    span = resource_spans["scopeSpans"][0]["spans"][0]
    assert span["name"].endswith("chat-turn")
