"""Agent telemetry for Octic.

The public surface, listed one name at a time. There is no star export here on
purpose: everything this module names is something a consumer may depend on
forever, and a wildcard publishes whatever a refactor happens to leave lying
around. Internals — the sanitizer, the counters, the context-scope machinery,
the OTLP encoder's helpers — are reachable by module path for anyone who needs
them in a test, and unsupported.
"""

from __future__ import annotations

from .agent import Agent, agent_attributes, with_agent
from .annotations import AnnotationScope, Target, with_retrieval, with_tool, with_workflow
from .attributes import (
    ATTR,
    CUSTOMER_ATTRIBUTE_PREFIX,
    GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
    GEN_AI_OPERATION_NAME_VALUE_INVOKE_WORKFLOW,
    GEN_AI_OPERATION_NAME_VALUE_RETRIEVAL,
    GEN_AI_TOOL_TYPE_VALUE_FUNCTION,
    OCTIC_CONTENT_CAPTURE_VALUE_FULL,
    OCTIC_CONTENT_CAPTURE_VALUE_METADATA,
    OCTIC_CONTENT_CAPTURE_VALUE_NONE,
    OCTIC_CONTENT_CAPTURE_VALUES,
    OCTIC_SCHEMA_VERSION,
    OCTIC_SDK_NAME_VALUES,
    OCTIC_TARGET_TYPE_VALUES,
    RESERVED_ATTRIBUTE_PREFIX,
)
from .batching import BatchOptions
from .content import (
    ContentCapture,
    ContentOptions,
    ContentPolicy,
    Redactor,
    current_capture,
    resolve_policy,
    with_content,
)
from .identity import Identity, current_identity, with_identity
from .otlp_json import encode_spans
from .pipeline import (
    ExternalProviderTelemetry,
    SpoolHandle,
    Telemetry,
    init,
    init_with_external_provider,
)
from .processor import OcticSpanProcessor
from .prompt import Prompt, with_prompt
from .redacting_exporter import RedactingSpanExporter
from .run import Run, current_run_id, mint_run_id, with_run
from .spool import SpoolOptions, SpoolStats
from .version import SDK_NAME, SDK_VERSION

__all__ = [
    "ATTR",
    "CUSTOMER_ATTRIBUTE_PREFIX",
    "GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL",
    "GEN_AI_OPERATION_NAME_VALUE_INVOKE_WORKFLOW",
    "GEN_AI_OPERATION_NAME_VALUE_RETRIEVAL",
    "GEN_AI_TOOL_TYPE_VALUE_FUNCTION",
    "OCTIC_CONTENT_CAPTURE_VALUES",
    "OCTIC_CONTENT_CAPTURE_VALUE_FULL",
    "OCTIC_CONTENT_CAPTURE_VALUE_METADATA",
    "OCTIC_CONTENT_CAPTURE_VALUE_NONE",
    "OCTIC_SCHEMA_VERSION",
    "OCTIC_SDK_NAME_VALUES",
    "OCTIC_TARGET_TYPE_VALUES",
    "RESERVED_ATTRIBUTE_PREFIX",
    "SDK_NAME",
    "SDK_VERSION",
    "Agent",
    "AnnotationScope",
    "BatchOptions",
    "ContentCapture",
    "ContentOptions",
    "ContentPolicy",
    "ExternalProviderTelemetry",
    "Identity",
    "OcticSpanProcessor",
    "Prompt",
    "RedactingSpanExporter",
    "Redactor",
    "Run",
    "SpoolHandle",
    "SpoolOptions",
    "SpoolStats",
    "Target",
    "Telemetry",
    "agent_attributes",
    "current_capture",
    "current_identity",
    "current_run_id",
    "encode_spans",
    "init",
    "init_with_external_provider",
    "mint_run_id",
    "resolve_policy",
    "with_agent",
    "with_content",
    "with_identity",
    "with_prompt",
    "with_retrieval",
    "with_run",
    "with_tool",
    "with_workflow",
]
