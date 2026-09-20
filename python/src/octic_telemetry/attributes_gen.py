"""
GENERATED — do not edit.

Source:     contract/attributes.yaml (schema_version 1)
Regenerate: node contract/generate.ts

Everything the SDK writes, everything ingest reads, and the redaction
policy shared by both, from one source. The equivalent file for another
language is another emitter in the generator, never a translation of this.

The standard library only, deliberately: nobody should need an
OpenTelemetry dependency in front of them to read a string. Semconv-owned
keys therefore appear here as literals, under the same constant names the
semconv package uses — the generator verifies every one of those names and
values against the pinned release on each run.
"""

import re
from typing import Literal

OCTIC_SCHEMA_VERSION = "1"
"""
Version of the attribute contract this build was generated from. Emitted as
octic.schema.version so a consumer can tell a missing attribute from an
older SDK.
"""

RESERVED_ATTRIBUTE_PREFIX = "octic."
"""Ours. Nothing outside the SDK may write into this namespace."""

CUSTOMER_ATTRIBUTE_PREFIX = "octic.custom."
"""
Where tenant-supplied business identifiers land. Separate from the reserved
prefix so a customer key can never overwrite one of ours.
"""

# ── octic.resource ──────────────────────────────────────────────────────

ATTR_OCTIC_SCHEMA_VERSION = "octic.schema.version"
"""
Which version of this contract the payload was written against. The escape
hatch that makes every later change safe: without it a consumer cannot tell
a missing attribute from an older SDK.
"""

ATTR_OCTIC_SDK_NAME = "octic.sdk.name"
"""
Which of our SDKs produced this. `telemetry.sdk.*` is reserved for the
OpenTelemetry SDK itself and would be a lie here. Closed, and the same value
each SDK uses as its OpenTelemetry instrumentation scope name, so a span's
scope and its resource agree on who wrote it. That is also what an SDK
compares a span's scope against to decide the span is foreign — one that
came from instrumentation rather than from our own annotations — which is
why the list lives here and is not restated per language.
"""

OCTIC_SDK_NAME_VALUE_OCTIC_NODE = "octic-node"
"""The Node SDK, `@octichq/telemetry`."""

OCTIC_SDK_NAME_VALUE_OCTIC_PYTHON = "octic-python"
"""The Python SDK, `octic-telemetry`."""

OCTIC_SDK_NAME_VALUES: tuple[str, ...] = (
    "octic-node",  # The Node SDK, `@octichq/telemetry`.
    "octic-python",  # The Python SDK, `octic-telemetry`.
)
"""Permitted values for `octic.sdk.name`."""

ATTR_OCTIC_SDK_VERSION = "octic.sdk.version"
"""Version of the Octic SDK."""

ATTR_SERVICE_NAME = "service.name"
"""
Set by the OpenTelemetry SDK from `init()`. Listed so a port knows it is not
optional. Semantic convention, verified against the pinned release as
`ATTR_SERVICE_NAME`.
"""

ATTR_SERVICE_VERSION = "service.version"
"""
Version of the instrumented application. Semantic convention, verified
against the pinned release as `ATTR_SERVICE_VERSION`.
"""

ATTR_DEPLOYMENT_ENVIRONMENT_NAME = "deployment.environment.name"
"""
Which environment the run happened in. Semantic convention, verified against
the pinned release as `ATTR_DEPLOYMENT_ENVIRONMENT_NAME`.
"""

ATTR_GEN_AI_AGENT_ID = "gen_ai.agent.id"
"""
The agent, as the application names it. Under the governance framing the
agent is the primary key, not the conversation. Semantic convention,
verified against the pinned release as `ATTR_GEN_AI_AGENT_ID`.
"""

ATTR_GEN_AI_AGENT_NAME = "gen_ai.agent.name"
"""
Human-facing agent name. Semantic convention, verified against the pinned
release as `ATTR_GEN_AI_AGENT_NAME`.
"""

ATTR_OCTIC_AGENT_ASSET_REF = "octic.agent.asset_ref"
"""
The graph join key — this agent as a node in the asset graph, so a trace can
be checked against the policies that apply to the thing that produced it.
Semconv has `gen_ai.agent.id`, but that is the agent's id *to the provider*;
it says nothing about what we discovered through an integration. Required in
practice for the Phase 2 graph write. Kept `recommended` because a customer
can emit useful telemetry without having mapped their agents to assets yet.
"""

# ── octic.run ───────────────────────────────────────────────────────────

ATTR_OCTIC_RUN_ID = "octic.run.id"
"""
Stable, human-facing id for one agent run. A trace id would technically do,
but it is opaque, not chosen by the application, and unusable as something a
person quotes in a ticket. Required on the `invoke_workflow` span and
present on every descendant, so ingest can attribute a span to its run
without walking the tree. Absent on unannotated traffic — consumers must
degrade to trace-level grouping rather than dropping the run.
"""

# ── octic.identity ──────────────────────────────────────────────────────

ATTR_GEN_AI_CONVERSATION_ID = "gen_ai.conversation.id"
"""
Groups many runs, across many requests, into one conversation. Semantic
convention, verified against the pinned release as
`ATTR_GEN_AI_CONVERSATION_ID`.
"""

ATTR_SESSION_ID = "session.id"
"""
The same value as `gen_ai.conversation.id`, written twice on purpose. One is
the GenAI-specific name and one is the general name non-GenAI tooling
already understands; both are experimental, and which survives is not ours
to decide. Two attributes is cheaper than a migration. Semantic convention,
verified against the pinned release as `ATTR_SESSION_ID`.
"""

ATTR_USER_ID = "user.id"
"""
The end user, as the tenant identifies them. Prefer a pseudonymous id.
Semantic convention, verified against the pinned release as `ATTR_USER_ID`.
"""

# ── octic.prompt ────────────────────────────────────────────────────────

ATTR_GEN_AI_PROMPT_NAME = "gen_ai.prompt.name"
"""
Name of the prompt template. Semantic convention, verified against the
pinned release as `ATTR_GEN_AI_PROMPT_NAME`.
"""

ATTR_OCTIC_PROMPT_VERSION = "octic.prompt.version"
"""
Semconv names the prompt but not its version. "Which prompt version was live
when this went wrong" is the question an audit actually asks.
"""

# ── octic.entity ────────────────────────────────────────────────────────

ATTR_GEN_AI_OPERATION_NAME = "gen_ai.operation.name"
"""
Which annotation authored the span. All three values are real semconv
members, so our span kinds need no invented vocabulary. Semantic convention,
verified against the pinned release as `ATTR_GEN_AI_OPERATION_NAME`.
"""

GEN_AI_OPERATION_NAME_VALUE_INVOKE_WORKFLOW = "invoke_workflow"
"""The agent-run root span."""

GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL = "execute_tool"
"""One tool execution."""

GEN_AI_OPERATION_NAME_VALUE_RETRIEVAL = "retrieval"
"""A lookup that fetched context for the model."""

GEN_AI_OPERATION_NAME_VALUES: tuple[str, ...] = (
    "invoke_workflow",  # The agent-run root span.
    "execute_tool",  # One tool execution.
    "retrieval",  # A lookup that fetched context for the model.
)
"""Permitted values for `gen_ai.operation.name`."""

ATTR_GEN_AI_WORKFLOW_NAME = "gen_ai.workflow.name"
"""
Name of the unit of agent work this span represents. Replaced
`octic.entity.name`, which reinvented this for the workflow span and
duplicated `gen_ai.tool.name` and `gen_ai.data_source.id` on the other two.
Each span kind now uses its natural semconv key and consumers read the
`entity_name` derived field, which is the same alias machinery the vendor
attributes use — one concept, several keys. Semantic convention, verified
against the pinned release as `ATTR_GEN_AI_WORKFLOW_NAME`.
"""

ATTR_OCTIC_ENTITY_INPUT = "octic.entity.input"
"""
Serialized input of the annotated entity, JSON where serializable.
`gen_ai.input.messages` is deliberately not reused: that one means chat
messages specifically, and these carry arbitrary application values. Not
produced at all under `capture: none` — our own content is the one kind we
can decline to create rather than create and then strip. On `retrieval` this
is the fallback: a string input goes to `gen_ai.retrieval.query.text`
instead, anything else lands here.
"""

ATTR_OCTIC_ENTITY_OUTPUT = "octic.entity.output"
"""Serialized return value of the annotated entity."""

ATTR_GEN_AI_TOOL_NAME = "gen_ai.tool.name"
"""
Name of the tool that was executed. Semantic convention, verified against
the pinned release as `ATTR_GEN_AI_TOOL_NAME`.
"""

ATTR_GEN_AI_TOOL_TYPE = "gen_ai.tool.type"
"""
What kind of thing the *model* called. Distinct from `octic.target.type`,
which is what the tool then reached — the graph question. Conflating the two
is what made our spans say `service` where the Vercel AI SDK says `function`
for the same call. `withTool()` defaults to `function`, which is literally
what it wraps and what the AI SDK emits, so our stacks now agree. Semconv
leaves the enum open; these three are its documented values. Semantic
convention, verified against the pinned release as `ATTR_GEN_AI_TOOL_TYPE`.
"""

GEN_AI_TOOL_TYPE_VALUE_FUNCTION = "function"
"""Application code the model chose to call. What `withTool()` wraps."""

GEN_AI_TOOL_TYPE_VALUE_EXTENSION = "extension"
"""A capability the provider executes on the model's behalf."""

GEN_AI_TOOL_TYPE_VALUE_DATASTORE = "datastore"
"""A store the model queries directly."""

GEN_AI_TOOL_TYPE_VALUES: tuple[str, ...] = (
    "function",  # Application code the model chose to call. What `withTool()` wraps.
    "extension",  # A capability the provider executes on the model's behalf.
    "datastore",  # A store the model queries directly.
)
"""Permitted values for `gen_ai.tool.type`."""

ATTR_GEN_AI_DATA_SOURCE_ID = "gen_ai.data_source.id"
"""
Identifier of the data source that was queried. Semantic convention,
verified against the pinned release as `ATTR_GEN_AI_DATA_SOURCE_ID`.
"""

ATTR_GEN_AI_RETRIEVAL_QUERY_TEXT = "gen_ai.retrieval.query.text"
"""
The query that was issued, when the caller passed one as text. A retrieval
query genuinely is a string, so the semconv key is honest here in a way it
would not be for arbitrary tool arguments. Emitted ONLY when the input is a
string. A caller passing a structure gets `octic.entity.input` instead — the
key promises text, and putting a serialized object behind it is the same lie
as the one below. The matching `gen_ai.retrieval.documents` is deliberately
not adopted at all: `withRetrieval()` returns whatever the application
returns, and naming that `documents` would assert a shape nobody validates.
The result always stays on `octic.entity.output`. Semantic convention,
verified against the pinned release as `ATTR_GEN_AI_RETRIEVAL_QUERY_TEXT`.
"""

ATTR_OCTIC_TARGET_NAME = "octic.target.name"
"""
What the span touched. `gen_ai.data_source.id` covers the retrieval case
only, so this is written uniformly across span kinds to give a consumer one
place to look.
"""

ATTR_OCTIC_TARGET_TYPE = "octic.target.type"
"""Kind of thing the span touched."""

OCTIC_TARGET_TYPE_VALUE_DATASTORE = "datastore"
"""`octic.target.type` value."""

OCTIC_TARGET_TYPE_VALUE_SERVICE = "service"
"""`octic.target.type` value."""

OCTIC_TARGET_TYPE_VALUE_TOOL = "tool"
"""`octic.target.type` value."""

OCTIC_TARGET_TYPE_VALUES: tuple[str, ...] = (
    "datastore",
    "service",
    "tool",
)
"""Permitted values for `octic.target.type`."""

ATTR_OCTIC_TARGET_ASSET_REF = "octic.target.asset_ref"
"""
The graph join key for the target, which is what makes "this agent read that
datastore" a policy-checkable statement rather than a log line.
"""

# ── octic.policy ────────────────────────────────────────────────────────

ATTR_OCTIC_REDACTED = "octic.redacted"
"""
Content was withheld or replaced by policy. A consumer needs to tell "this
agent recorded nothing" apart from "this customer chose not to send it" —
without this they render the same.
"""

ATTR_OCTIC_CONTENT_CAPTURE = "octic.content.capture"
"""
The capture level in effect for this span, stamped by the processor so it
reaches foreign spans too, read at export, and REMOVED before the span
leaves the process. Internal plumbing, never on the wire. A consumer that
sees this key has a broken exporter upstream. Excluded from generated wire
contracts.
"""

OCTIC_CONTENT_CAPTURE_VALUE_NONE = "none"
"""Drop content. The product works fully at this setting."""

OCTIC_CONTENT_CAPTURE_VALUE_METADATA = "metadata"
"""Replace content with length plus a truncated SHA-256."""

OCTIC_CONTENT_CAPTURE_VALUE_FULL = "full"
"""
Send content, after the tenant redactor and the length cap. The default
while this is early: content is opt-out for now, so a first consumer sees
everything the pipeline can carry.
"""

OCTIC_CONTENT_CAPTURE_VALUES: tuple[str, ...] = (
    "none",  # Drop content. The product works fully at this setting.
    "metadata",  # Replace content with length plus a truncated SHA-256.
    "full",  # Send content, after the tenant redactor and the length cap. The default while this is early: content is opt-out for now, so a first consumer sees everything the pipeline can carry.
)
"""Permitted values for `octic.content.capture`."""

# ── content policy ──────────────────────────────────────────────────────

CONTENT_KEYS: tuple[str, ...] = (
    "ai.prompt",
    "ai.prompt.messages",
    "ai.response.providerMetadata",
    "ai.response.text",
    "ai.response.toolCalls",
    "ai.toolCall.args",
    "ai.toolCall.result",
    "exception.message",
    "exception.stacktrace",
    "gen_ai.input.messages",
    "gen_ai.output.messages",
    "gen_ai.retrieval.query.text",
    "gen_ai.system_instructions",
    "gen_ai.tool.call.arguments",
    "gen_ai.tool.call.result",
    "gen_ai.tool.definitions",
    "octic.entity.input",
    "octic.entity.output",
)
"""
Every key known to carry customer content, across our own output, the vendor
keys we read, and vendor keys with no canonical field. Derived from the
class column, so this list and the published document cannot disagree.
"""

CONTENT_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^gen_ai\.(prompt|completion)\.\d+\."),
    re.compile(r"(^|\.)(content|messages|instructions|arguments|result|definitions)$"),
)
"""
The half that catches what the list does not. A denylist alone fails open
the day a vendor ships a key we have never seen.
"""

CONTENT_HEURISTIC_MIN_LENGTH = 200
"""
A string longer than this, authored by a scope we do not control, is treated
as content whatever it is called.
"""

RESOURCE_DENY: tuple[str, ...] = (
    "host.id",
    "host.ip",
    "host.mac",
    "process.command",
    "process.command_args",
    "process.command_line",
    "process.executable.path",
    "process.owner",
)
"""
Resource attributes nobody asked for. Dropped at the SDK exporter for a
customer who runs our SDK, and at ingest for one who does not.
"""

# ── wire surface ────────────────────────────────────────────────────────

EMITTED_ATTRIBUTES: tuple[str, ...] = (
    "deployment.environment.name",
    "gen_ai.agent.id",
    "gen_ai.agent.name",
    "gen_ai.conversation.id",
    "gen_ai.data_source.id",
    "gen_ai.operation.name",
    "gen_ai.prompt.name",
    "gen_ai.retrieval.query.text",
    "gen_ai.tool.name",
    "gen_ai.tool.type",
    "gen_ai.workflow.name",
    "octic.agent.asset_ref",
    "octic.entity.input",
    "octic.entity.output",
    "octic.prompt.version",
    "octic.redacted",
    "octic.run.id",
    "octic.schema.version",
    "octic.sdk.name",
    "octic.sdk.version",
    "octic.target.asset_ref",
    "octic.target.name",
    "octic.target.type",
    "service.name",
    "service.version",
    "session.id",
    "user.id",
)
"""Every attribute our SDK is permitted to put on the wire."""

INTERNAL_ATTRIBUTES: tuple[str, ...] = (
    "octic.content.capture",
)
"""
Plumbing that must never leave the process. A consumer that sees one of
these is looking at output from a broken exporter.
"""

SEMCONV_NAMES: dict[str, str] = {
    "ATTR_DEPLOYMENT_ENVIRONMENT_NAME": "deployment.environment.name",
    "ATTR_GEN_AI_AGENT_ID": "gen_ai.agent.id",
    "ATTR_GEN_AI_AGENT_NAME": "gen_ai.agent.name",
    "ATTR_GEN_AI_CONVERSATION_ID": "gen_ai.conversation.id",
    "ATTR_GEN_AI_DATA_SOURCE_ID": "gen_ai.data_source.id",
    "ATTR_GEN_AI_OPERATION_NAME": "gen_ai.operation.name",
    "ATTR_GEN_AI_PROMPT_NAME": "gen_ai.prompt.name",
    "ATTR_GEN_AI_RETRIEVAL_QUERY_TEXT": "gen_ai.retrieval.query.text",
    "ATTR_GEN_AI_TOOL_NAME": "gen_ai.tool.name",
    "ATTR_GEN_AI_TOOL_TYPE": "gen_ai.tool.type",
    "ATTR_GEN_AI_WORKFLOW_NAME": "gen_ai.workflow.name",
    "ATTR_SERVICE_NAME": "service.name",
    "ATTR_SERVICE_VERSION": "service.version",
    "ATTR_SESSION_ID": "session.id",
    "ATTR_USER_ID": "user.id",
    "GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL": "execute_tool",
    "GEN_AI_OPERATION_NAME_VALUE_INVOKE_WORKFLOW": "invoke_workflow",
    "GEN_AI_OPERATION_NAME_VALUE_RETRIEVAL": "retrieval",
}
"""
Every constant here that claims to be a semantic convention, mapped to the
value semconv must still give it. The generator verifies this against the
pinned release on each run, so a port can assert the same thing without
resolving a semconv package.
"""

# ── derived fields (attributes we read but do not own) ───────────────────

FIELDS: dict[str, dict[str, object]] = {
    # What to call this span. The one field here that resolves attributes we
    # author ourselves rather than a vendor's: each span kind carries its
    # natural semconv key, and the alias table answers "what is this called"
    # without the consumer branching on `gen_ai.operation.name`. This is why
    # `octic.entity.name` no longer exists.
    "entity_name": {
        "type": "string",
        "aliases": ("gen_ai.workflow.name", "gen_ai.tool.name", "gen_ai.data_source.id"),
    },
    # Which model provider served the call.
    "provider": {
        "type": "string",
        "aliases": ("gen_ai.provider.name", "gen_ai.system"),
    },
    # Model the application asked for. Not the one that answered.
    "request_model": {
        "type": "string",
        "aliases": ("gen_ai.request.model",),
    },
    # Model that actually answered, pinned to a dated build. This plus token
    # counts is the only route to cost — no stack emits a price.
    "response_model": {
        "type": "string",
        "aliases": ("gen_ai.response.model",),
    },
    # Provider-side id for the completion.
    "response_id": {
        "type": "string",
        "aliases": ("gen_ai.response.id",),
    },
    # Why generation stopped. Three stacks, three spellings of the same
    # value — the single clearest argument for normalising at read time.
    "finish_reason": {
        "type": "string[]",
        "aliases": ("gen_ai.response.finish_reasons",),
        "values": {"tool_call": "tool_calls", "tool-calls": "tool_calls"},
    },
    # Prompt tokens billed.
    "input_tokens": {
        "type": "int",
        "aliases": ("gen_ai.usage.input_tokens",),
    },
    # Completion tokens billed.
    "output_tokens": {
        "type": "int",
        "aliases": ("gen_ai.usage.output_tokens",),
    },
    # Traceloop only, and not a semconv key. Derive it from input plus
    # output rather than depending on it.
    "total_tokens": {
        "type": "int",
        "aliases": ("gen_ai.usage.total_tokens",),
    },
    # Prompt tokens served from provider cache. AI SDK only.
    "cache_read_input_tokens": {
        "type": "int",
        "aliases": ("gen_ai.usage.cache_read.input_tokens",),
    },
    # Prompt tokens written to provider cache. AI SDK only.
    "cache_creation_input_tokens": {
        "type": "int",
        "aliases": ("gen_ai.usage.cache_creation.input_tokens",),
    },
    # Reasoning tokens. Semconv has a name for this; the AI SDK emits its
    # own instead, so the semconv name leads and the vendor key is the
    # fallback.
    "reasoning_output_tokens": {
        "type": "int",
        "aliases": ("gen_ai.usage.reasoning.output_tokens", "ai.usage.outputTokenDetails.reasoningTokens"),
    },
    # Provider-side id joining a tool call to its result.
    "tool_call_id": {
        "type": "string",
        "aliases": ("gen_ai.tool.call.id",),
    },
    # Arguments the model chose for a tool call.
    "tool_call_arguments": {
        "type": "string",
        "aliases": ("gen_ai.tool.call.arguments", "ai.toolCall.args"),
        "class": "content",
    },
    # Value the tool returned to the model.
    "tool_call_result": {
        "type": "string",
        "aliases": ("gen_ai.tool.call.result", "ai.toolCall.result"),
        "class": "content",
    },
    # The conversation sent to the model. Traceloop and the AI SDK put this
    # on span attributes; @opentelemetry/instrumentation-openai puts it on
    # the logs signal instead, so a span-only consumer sees nothing there.
    "input_messages": {
        "type": "string",
        "aliases": ("gen_ai.input.messages", "ai.prompt.messages", "ai.prompt"),
        "class": "content",
    },
    # What the model returned.
    "output_messages": {
        "type": "string",
        "aliases": ("gen_ai.output.messages", "ai.response.text", "ai.response.toolCalls"),
        "class": "content",
    },
    # The system prompt.
    "system_instructions": {
        "type": "string",
        "aliases": ("gen_ai.system_instructions",),
        "class": "content",
    },
    # Tool schemas offered to the model. Traceloop nests them under
    # `function`, the AI SDK flattens them — same information, two shapes.
    "tool_definitions": {
        "type": "string",
        "aliases": ("gen_ai.tool.definitions",),
        "class": "content",
    },
    # Host the provider call went to.
    "server_address": {
        "type": "string",
        "aliases": ("server.address",),
    },
    # Port the provider call went to. An int, not a string.
    "server_port": {
        "type": "int",
        "aliases": ("server.port",),
    },
}
"""
Facts foreign instrumentation records. Each entry is a canonical field, the
aliases accepted for it in priority order, and any value normalisation.
Resolve a field through this table rather than naming a vendor key directly:
an upstream rename then costs an added alias, not a code change.
"""

DerivedField = Literal[
    "entity_name",
    "provider",
    "request_model",
    "response_model",
    "response_id",
    "finish_reason",
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "reasoning_output_tokens",
    "tool_call_id",
    "tool_call_arguments",
    "tool_call_result",
    "input_messages",
    "output_messages",
    "system_instructions",
    "tool_definitions",
    "server_address",
    "server_port",
]
"""The canonical field names `FIELDS` resolves."""
