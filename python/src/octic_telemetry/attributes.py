"""The SDK's view of the attribute contract.

The names are not written here. They live in ``contract/attributes.yaml`` and
arrive as :mod:`octic_telemetry.attributes_gen`, because a Python file cannot be
the specification for the Node and Go ports either — and because four
hand-maintained copies of one list is how two sides of the same policy come to
disagree about how many keys it covers.

Semantic-convention names come through the generated file too, under the same
constant names the semconv package exports, rather than being imported from it.
That looks like a step back; it is not. The generator resolves the pinned
semconv release and compares every name *and its value* on each run, which
catches a silent rename that an import would not, and the contract test asserts
the same thing inside this suite. What it buys is that ingest, the worker and a
customer's own reader can all read one file without a semconv dependency in
front of it.

Rule for adding anything: prefer an existing semantic convention, and fall back
to the reserved namespace only where nothing exists.

What leaves the package is narrower than what this module imports. ``ATTR`` and
the named constants are published; the reader-side tables are internal here and
published separately for consumers that read telemetry rather than write it.
Those are two different dependencies.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from . import attributes_gen as gen

# Re-exported for the modules that stamp them. Listed explicitly rather than
# star-imported so that what this package depends on from the contract is
# readable, and so a key that disappears from the contract is an ImportError
# here rather than an AttributeError somewhere further in.
from .attributes_gen import (
    ATTR_GEN_AI_AGENT_ID,
    ATTR_GEN_AI_AGENT_NAME,
    ATTR_GEN_AI_CONVERSATION_ID,
    ATTR_GEN_AI_DATA_SOURCE_ID,
    ATTR_GEN_AI_OPERATION_NAME,
    ATTR_GEN_AI_PROMPT_NAME,
    ATTR_GEN_AI_RETRIEVAL_QUERY_TEXT,
    ATTR_GEN_AI_TOOL_NAME,
    ATTR_GEN_AI_TOOL_TYPE,
    ATTR_GEN_AI_WORKFLOW_NAME,
    ATTR_OCTIC_AGENT_ASSET_REF,
    ATTR_OCTIC_CONTENT_CAPTURE,
    ATTR_OCTIC_ENTITY_INPUT,
    ATTR_OCTIC_ENTITY_OUTPUT,
    ATTR_OCTIC_PROMPT_VERSION,
    ATTR_OCTIC_REDACTED,
    ATTR_OCTIC_RUN_ID,
    ATTR_OCTIC_SCHEMA_VERSION,
    ATTR_OCTIC_SDK_NAME,
    ATTR_OCTIC_SDK_VERSION,
    ATTR_OCTIC_TARGET_ASSET_REF,
    ATTR_OCTIC_TARGET_NAME,
    ATTR_OCTIC_TARGET_TYPE,
    ATTR_SERVICE_NAME,
    ATTR_SERVICE_VERSION,
    ATTR_SESSION_ID,
    ATTR_USER_ID,
    CONTENT_HEURISTIC_MIN_LENGTH,
    CONTENT_KEYS,
    CONTENT_PATTERNS,
    CUSTOMER_ATTRIBUTE_PREFIX,
    EMITTED_ATTRIBUTES,
    GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
    GEN_AI_OPERATION_NAME_VALUE_INVOKE_WORKFLOW,
    GEN_AI_OPERATION_NAME_VALUE_RETRIEVAL,
    GEN_AI_TOOL_TYPE_VALUE_FUNCTION,
    INTERNAL_ATTRIBUTES,
    OCTIC_CONTENT_CAPTURE_VALUE_FULL,
    OCTIC_CONTENT_CAPTURE_VALUE_METADATA,
    OCTIC_CONTENT_CAPTURE_VALUE_NONE,
    OCTIC_CONTENT_CAPTURE_VALUES,
    OCTIC_SCHEMA_VERSION,
    OCTIC_SDK_NAME_VALUE_OCTIC_NODE,
    OCTIC_SDK_NAME_VALUE_OCTIC_PYTHON,
    OCTIC_SDK_NAME_VALUES,
    OCTIC_TARGET_TYPE_VALUES,
    RESERVED_ATTRIBUTE_PREFIX,
    RESOURCE_DENY,
)


@dataclass(frozen=True)
class _Attr:
    """Every attribute key the contract owns, as one object.

    ``ATTR.OCTIC_RUN_ID`` over a wall of module-level names: it keeps one entry
    in a consumer's import list however far the contract grows, and it makes the
    set discoverable by typing a dot. Frozen, because a consumer reassigning a
    key would move where their telemetry lands without moving where ours does.

    The values are the generated constants, so nothing here restates a key.
    """

    DEPLOYMENT_ENVIRONMENT_NAME: str = gen.ATTR_DEPLOYMENT_ENVIRONMENT_NAME
    GEN_AI_AGENT_ID: str = gen.ATTR_GEN_AI_AGENT_ID
    GEN_AI_AGENT_NAME: str = gen.ATTR_GEN_AI_AGENT_NAME
    GEN_AI_CONVERSATION_ID: str = gen.ATTR_GEN_AI_CONVERSATION_ID
    GEN_AI_DATA_SOURCE_ID: str = gen.ATTR_GEN_AI_DATA_SOURCE_ID
    GEN_AI_OPERATION_NAME: str = gen.ATTR_GEN_AI_OPERATION_NAME
    GEN_AI_PROMPT_NAME: str = gen.ATTR_GEN_AI_PROMPT_NAME
    GEN_AI_RETRIEVAL_QUERY_TEXT: str = gen.ATTR_GEN_AI_RETRIEVAL_QUERY_TEXT
    GEN_AI_TOOL_NAME: str = gen.ATTR_GEN_AI_TOOL_NAME
    GEN_AI_TOOL_TYPE: str = gen.ATTR_GEN_AI_TOOL_TYPE
    GEN_AI_WORKFLOW_NAME: str = gen.ATTR_GEN_AI_WORKFLOW_NAME
    OCTIC_AGENT_ASSET_REF: str = gen.ATTR_OCTIC_AGENT_ASSET_REF
    OCTIC_CONTENT_CAPTURE: str = gen.ATTR_OCTIC_CONTENT_CAPTURE
    OCTIC_ENTITY_INPUT: str = gen.ATTR_OCTIC_ENTITY_INPUT
    OCTIC_ENTITY_OUTPUT: str = gen.ATTR_OCTIC_ENTITY_OUTPUT
    OCTIC_PROMPT_VERSION: str = gen.ATTR_OCTIC_PROMPT_VERSION
    OCTIC_REDACTED: str = gen.ATTR_OCTIC_REDACTED
    OCTIC_RUN_ID: str = gen.ATTR_OCTIC_RUN_ID
    OCTIC_SCHEMA_VERSION: str = gen.ATTR_OCTIC_SCHEMA_VERSION
    OCTIC_SDK_NAME: str = gen.ATTR_OCTIC_SDK_NAME
    OCTIC_SDK_VERSION: str = gen.ATTR_OCTIC_SDK_VERSION
    OCTIC_TARGET_ASSET_REF: str = gen.ATTR_OCTIC_TARGET_ASSET_REF
    OCTIC_TARGET_NAME: str = gen.ATTR_OCTIC_TARGET_NAME
    OCTIC_TARGET_TYPE: str = gen.ATTR_OCTIC_TARGET_TYPE
    SERVICE_NAME: str = gen.ATTR_SERVICE_NAME
    SERVICE_VERSION: str = gen.ATTR_SERVICE_VERSION
    SESSION_ID: str = gen.ATTR_SESSION_ID
    USER_ID: str = gen.ATTR_USER_ID


ATTR: Final = _Attr()

__all__ = [
    "ATTR",
    "ATTR_GEN_AI_AGENT_ID",
    "ATTR_GEN_AI_AGENT_NAME",
    "ATTR_GEN_AI_CONVERSATION_ID",
    "ATTR_GEN_AI_DATA_SOURCE_ID",
    "ATTR_GEN_AI_OPERATION_NAME",
    "ATTR_GEN_AI_PROMPT_NAME",
    "ATTR_GEN_AI_RETRIEVAL_QUERY_TEXT",
    "ATTR_GEN_AI_TOOL_NAME",
    "ATTR_GEN_AI_TOOL_TYPE",
    "ATTR_GEN_AI_WORKFLOW_NAME",
    "ATTR_OCTIC_AGENT_ASSET_REF",
    "ATTR_OCTIC_CONTENT_CAPTURE",
    "ATTR_OCTIC_ENTITY_INPUT",
    "ATTR_OCTIC_ENTITY_OUTPUT",
    "ATTR_OCTIC_PROMPT_VERSION",
    "ATTR_OCTIC_REDACTED",
    "ATTR_OCTIC_RUN_ID",
    "ATTR_OCTIC_SCHEMA_VERSION",
    "ATTR_OCTIC_SDK_NAME",
    "ATTR_OCTIC_SDK_VERSION",
    "ATTR_OCTIC_TARGET_ASSET_REF",
    "ATTR_OCTIC_TARGET_NAME",
    "ATTR_OCTIC_TARGET_TYPE",
    "ATTR_SERVICE_NAME",
    "ATTR_SERVICE_VERSION",
    "ATTR_SESSION_ID",
    "ATTR_USER_ID",
    "CONTENT_HEURISTIC_MIN_LENGTH",
    "CONTENT_KEYS",
    "CONTENT_PATTERNS",
    "CUSTOMER_ATTRIBUTE_PREFIX",
    "EMITTED_ATTRIBUTES",
    "GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL",
    "GEN_AI_OPERATION_NAME_VALUE_INVOKE_WORKFLOW",
    "GEN_AI_OPERATION_NAME_VALUE_RETRIEVAL",
    "GEN_AI_TOOL_TYPE_VALUE_FUNCTION",
    "INTERNAL_ATTRIBUTES",
    "OCTIC_CONTENT_CAPTURE_VALUES",
    "OCTIC_CONTENT_CAPTURE_VALUE_FULL",
    "OCTIC_CONTENT_CAPTURE_VALUE_METADATA",
    "OCTIC_CONTENT_CAPTURE_VALUE_NONE",
    "OCTIC_SCHEMA_VERSION",
    "OCTIC_SDK_NAME_VALUES",
    "OCTIC_SDK_NAME_VALUE_OCTIC_NODE",
    "OCTIC_SDK_NAME_VALUE_OCTIC_PYTHON",
    "OCTIC_TARGET_TYPE_VALUES",
    "RESERVED_ATTRIBUTE_PREFIX",
    "RESOURCE_DENY",
]
