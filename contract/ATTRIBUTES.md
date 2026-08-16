# The Octic agent-telemetry attribute contract

**Schema version 1.**

<!-- GENERATED from contract/attributes.yaml by contract/generate.ts. Do not edit. -->

This is the document the SDK is written against, in every language, and the
document a consumer of our telemetry reads. It is generated, so it cannot
drift from the constants the code actually uses.

## What "frozen" means here

Three populations, frozen in three different senses.

| Stability | Who writes it | What the freeze commits us to |
|---|---|---|
| **emitted** | our SDK | An API promise. A rename is a major version with dual-write, because customer queries and our graph writes key off these. This half is also the port spec. |
| **consumed** | foreign instrumentation | The *reader*, not the key. We cannot freeze what we do not own, so what is fixed is the canonical field name, the accepted aliases and the value normalisation. An upstream rename is an additive alias. |
| **denied** | foreign instrumentation | The policy, not the list. The list grows as vendors ship new detectors. |

Frozen does not mean immutable, and it does not mean stored. It means
additive-only and versioned: removing a key or changing its type costs a
`schema_version` bump, and every payload carries the version it was written
against in `octic.schema.version`.

## Namespaces

- `octic.` — reserved. Only the SDK writes here.
- `octic.custom.` — tenant-supplied business identifiers.

Separate prefixes because they were not always: tenant attributes passed to
`withIdentity()` used to land as `octic.<key>`, in the same namespace as
`octic.run.id`. Span-option attributes are applied at construction and the
processor stamps in `onStart`, so a tenant key could overwrite one of ours.

## `octic.resource`

*emitted* · resource-level, falling back to span

Identifies the SDK, the deployment and the agent. Normally resource attributes. When a host SDK owns the tracer provider the resource is theirs, so the span processor applies these per span instead — a consumer MUST look in both places. Measured with OpenLLMetry, where the agent came through empty until the per-span fallback existed.

| Key | Type | Requirement | Class | Owner |
|---|---|---|---|---|
| `octic.schema.version` | `string` | required | metadata | octic |
| `octic.sdk.name` | `string` | required | metadata | octic |
| `octic.sdk.version` | `string` | required | metadata | octic |
| `service.name` | `string` | required | metadata | semconv |
| `service.version` | `string` | recommended | metadata | semconv |
| `deployment.environment.name` | `string` | recommended | environment | semconv |
| `gen_ai.agent.id` | `string` | required | identity | semconv |
| `gen_ai.agent.name` | `string` | recommended | identity | semconv |
| `octic.agent.asset_ref` | `string` | recommended | identity | octic |

- **`octic.schema.version`** — Which version of this contract the payload was written against. The escape hatch that makes every later change safe: without it a consumer cannot tell a missing attribute from an older SDK.
- **`octic.sdk.name`** — Which of our SDKs produced this. `telemetry.sdk.*` is reserved for the OpenTelemetry SDK itself and would be a lie here.
  - Examples: `octic-node`, `octic-python`
- **`octic.sdk.version`** — Version of the Octic SDK.
- **`service.name`** — Set by the OpenTelemetry SDK from `init()`. Listed so a port knows it is not optional.
- **`service.version`** — Version of the instrumented application.
- **`deployment.environment.name`** — Which environment the run happened in.
  - Examples: `production`, `staging`
- **`gen_ai.agent.id`** — The agent, as the application names it. Under the governance framing the agent is the primary key, not the conversation.
- **`gen_ai.agent.name`** — Human-facing agent name.
- **`octic.agent.asset_ref`** — The graph join key — this agent as a node in the asset graph, so a trace can be checked against the policies that apply to the thing that produced it. Semconv has `gen_ai.agent.id`, but that is the agent's id *to the provider*; it says nothing about what we discovered through an integration.
  - Examples: `poc/agent/weather-assistant`
  - Required in practice for the Phase 2 graph write. Kept `recommended` because a customer can emit useful telemetry without having mapped their agents to assets yet.

## `octic.run`

*emitted* · span-level · propagated onto foreign spans

The run id, stamped on every span started inside the workflow scope — including spans authored by instrumentation that has never heard of this package. That propagation is the mechanism the whole PoC exists to prove.

| Key | Type | Requirement | Class | Owner |
|---|---|---|---|---|
| `octic.run.id`<br/>propagated | `string` | required | identity | octic |

- **`octic.run.id`** — Stable, human-facing id for one agent run. A trace id would technically do, but it is opaque, not chosen by the application, and unusable as something a person quotes in a ticket.
  - Examples: `run-chat-turn-8d44e4`
  - Required on the `invoke_workflow` span and present on every descendant, so ingest can attribute a span to its run without walking the tree. Absent on unannotated traffic — consumers must degrade to trace-level grouping rather than dropping the run.

## `octic.identity`

*emitted* · span-level · propagated onto foreign spans

Durable identity above a single run. A conversation spans many requests, many processes, possibly many days, so it cannot be a span. Optional throughout: every governance question is answerable without it.

| Key | Type | Requirement | Class | Owner |
|---|---|---|---|---|
| `gen_ai.conversation.id`<br/>propagated | `string` | opt_in | identity | semconv |
| `session.id`<br/>propagated | `string` | opt_in | identity | semconv |
| `user.id`<br/>propagated | `string` | opt_in | identity | semconv |

- **`gen_ai.conversation.id`** — Groups many runs, across many requests, into one conversation.
- **`session.id`** — The same value as `gen_ai.conversation.id`, written twice on purpose. One is the GenAI-specific name and one is the general name non-GenAI tooling already understands; both are experimental, and which survives is not ours to decide. Two attributes is cheaper than a migration.
- **`user.id`** — The end user, as the tenant identifies them. Prefer a pseudonymous id.

## `octic.prompt`

*emitted* · span-level · propagated onto foreign spans

Which prompt template produced a model call. The version is the audit question.

| Key | Type | Requirement | Class | Owner |
|---|---|---|---|---|
| `gen_ai.prompt.name`<br/>propagated | `string` | opt_in | metadata | semconv |
| `octic.prompt.version`<br/>propagated | `string` | opt_in | metadata | octic |

- **`gen_ai.prompt.name`** — Name of the prompt template.
- **`octic.prompt.version`** — Semconv names the prompt but not its version. "Which prompt version was live when this went wrong" is the question an audit actually asks.
  - Examples: `v3`

## `octic.entity`

*emitted* · span-level

Spans our annotations create — the work no instrumentation can see. Patching a provider SDK observes one HTTP call; it cannot know that five of those calls were one agent doing one job.

| Key | Type | Requirement | Class | Owner |
|---|---|---|---|---|
| `gen_ai.operation.name` | `string` | required | metadata | semconv |
| `gen_ai.workflow.name` | `string` | conditionally_required<br/>*(gen_ai.operation.name == invoke_workflow)* | metadata | semconv |
| `octic.entity.input` | `string` | opt_in | content | octic |
| `octic.entity.output` | `string` | opt_in | content | octic |
| `gen_ai.tool.name` | `string` | conditionally_required<br/>*(gen_ai.operation.name == execute_tool)* | metadata | semconv |
| `gen_ai.tool.type` | `string` | recommended<br/>*(gen_ai.operation.name == execute_tool)* | metadata | semconv |
| `gen_ai.data_source.id` | `string` | conditionally_required<br/>*(gen_ai.operation.name == retrieval)* | metadata | semconv |
| `gen_ai.retrieval.query.text` | `string` | opt_in<br/>*(gen_ai.operation.name == retrieval)* | content | semconv |
| `octic.target.name` | `string` | recommended | metadata | octic |
| `octic.target.type` | `string` | recommended | metadata | octic |
| `octic.target.asset_ref` | `string` | recommended | identity | octic |

- **`gen_ai.operation.name`** — Which annotation authored the span. All three values are real semconv members, so our span kinds need no invented vocabulary.
  - Values: `invoke_workflow` (The agent-run root span.), `execute_tool` (One tool execution.), `retrieval` (A lookup that fetched context for the model.)
- **`gen_ai.workflow.name`** — Name of the unit of agent work this span represents.
  - Replaced `octic.entity.name`, which reinvented this for the workflow span and duplicated `gen_ai.tool.name` and `gen_ai.data_source.id` on the other two. Each span kind now uses its natural semconv key and consumers read the `entity_name` derived field, which is the same alias machinery the vendor attributes use — one concept, several keys.
- **`octic.entity.input`** — Serialized input of the annotated entity, JSON where serializable. `gen_ai.input.messages` is deliberately not reused: that one means chat messages specifically, and these carry arbitrary application values.
  - Emitted on: `invoke_workflow`, `execute_tool`, `retrieval`
  - Not produced at all under `capture: none` — our own content is the one kind we can decline to create rather than create and then strip. On `retrieval` this is the fallback: a string input goes to `gen_ai.retrieval.query.text` instead, anything else lands here.
- **`octic.entity.output`** — Serialized return value of the annotated entity.
  - Emitted on: `invoke_workflow`, `execute_tool`, `retrieval`
- **`gen_ai.tool.name`** — Name of the tool that was executed.
- **`gen_ai.tool.type`** — What kind of thing the *model* called. Distinct from `octic.target.type`, which is what the tool then reached — the graph question. Conflating the two is what made our spans say `service` where the Vercel AI SDK says `function` for the same call.
  - Values: `function` (Application code the model chose to call. What `withTool()` wraps.), `extension` (A capability the provider executes on the model's behalf.), `datastore` (A store the model queries directly.)
  - `withTool()` defaults to `function`, which is literally what it wraps and what the AI SDK emits, so our stacks now agree. Semconv leaves the enum open; these three are its documented values.
- **`gen_ai.data_source.id`** — Identifier of the data source that was queried.
- **`gen_ai.retrieval.query.text`** — The query that was issued, when the caller passed one as text. A retrieval query genuinely is a string, so the semconv key is honest here in a way it would not be for arbitrary tool arguments.
  - Emitted on: `retrieval`
  - Emitted ONLY when the input is a string. A caller passing a structure gets `octic.entity.input` instead — the key promises text, and putting a serialized object behind it is the same lie as the one below. The matching `gen_ai.retrieval.documents` is deliberately not adopted at all: `withRetrieval()` returns whatever the application returns, and naming that `documents` would assert a shape nobody validates. The result always stays on `octic.entity.output`.
- **`octic.target.name`** — What the span touched. `gen_ai.data_source.id` covers the retrieval case only, so this is written uniformly across span kinds to give a consumer one place to look.
- **`octic.target.type`** — Kind of thing the span touched.
  - Values: `datastore`, `service`, `tool`
- **`octic.target.asset_ref`** — The graph join key for the target, which is what makes "this agent read that datastore" a policy-checkable statement rather than a log line.
  - Examples: `poc/datastore/city-guide`, `poc/service/forecast-api`

## `octic.policy`

*emitted* · span-level

What the content policy did to this span.

| Key | Type | Requirement | Class | Owner |
|---|---|---|---|---|
| `octic.redacted` | `boolean` | conditionally_required<br/>*(content was withheld or replaced)* | metadata | octic |
| `octic.content.capture`<br/>**internal, never on the wire** | `string` | required | metadata | octic |

- **`octic.redacted`** — Content was withheld or replaced by policy. A consumer needs to tell "this agent recorded nothing" apart from "this customer chose not to send it" — without this they render the same.
- **`octic.content.capture`** — The capture level in effect for this span, stamped by the processor so it reaches foreign spans too, read at export, and REMOVED before the span leaves the process.
  - Values: `none` (Drop content. The product works fully at this setting.), `metadata` (Replace content with length plus a truncated SHA-256.), `full` (Send content, after the tenant redactor and the length cap. The default while this is early: content is opt-out for now, so a first consumer sees everything the pipeline can carry.)
  - Internal plumbing, never on the wire. A consumer that sees this key has a broken exporter upstream. Excluded from generated wire contracts.

## `derived`

*consumed*

Facts foreign instrumentation records, which we read but do not own. Each entry is a canonical field, the aliases accepted for it in priority order, and any value normalisation. A consumer resolves a field through this table instead of naming a vendor's key directly, so an upstream rename is an added alias rather than a code change.

| Field | Type | Aliases, in priority order | Normalises |
|---|---|---|---|
| `entity_name` | `string` | `gen_ai.workflow.name`<br/>`gen_ai.tool.name`<br/>`gen_ai.data_source.id` | — |
| `provider` | `string` | `gen_ai.provider.name`<br/>`gen_ai.system` | — |
| `request_model` | `string` | `gen_ai.request.model` | — |
| `response_model` | `string` | `gen_ai.response.model` | — |
| `response_id` | `string` | `gen_ai.response.id` | — |
| `finish_reason` | `string[]` | `gen_ai.response.finish_reasons` | `tool_call` → `tool_calls`<br/>`tool-calls` → `tool_calls` |
| `input_tokens` | `int` | `gen_ai.usage.input_tokens` | — |
| `output_tokens` | `int` | `gen_ai.usage.output_tokens` | — |
| `total_tokens` | `int` | `gen_ai.usage.total_tokens` | — |
| `cache_read_input_tokens` | `int` | `gen_ai.usage.cache_read.input_tokens` | — |
| `cache_creation_input_tokens` | `int` | `gen_ai.usage.cache_creation.input_tokens` | — |
| `reasoning_output_tokens` | `int` | `gen_ai.usage.reasoning.output_tokens`<br/>`ai.usage.outputTokenDetails.reasoningTokens` | — |
| `tool_call_id` | `string` | `gen_ai.tool.call.id` | — |
| `tool_call_arguments` **(content)** | `string` | `gen_ai.tool.call.arguments`<br/>`ai.toolCall.args` | — |
| `tool_call_result` **(content)** | `string` | `gen_ai.tool.call.result`<br/>`ai.toolCall.result` | — |
| `input_messages` **(content)** | `string` | `gen_ai.input.messages`<br/>`ai.prompt.messages`<br/>`ai.prompt` | — |
| `output_messages` **(content)** | `string` | `gen_ai.output.messages`<br/>`ai.response.text`<br/>`ai.response.toolCalls` | — |
| `system_instructions` **(content)** | `string` | `gen_ai.system_instructions` | — |
| `tool_definitions` **(content)** | `string` | `gen_ai.tool.definitions` | — |
| `server_address` | `string` | `server.address` | — |
| `server_port` | `int` | `server.port` | — |

- **`entity_name`** — What to call this span. The one field here that resolves attributes we author ourselves rather than a vendor's: each span kind carries its natural semconv key, and the alias table answers "what is this called" without the consumer branching on `gen_ai.operation.name`. This is why `octic.entity.name` no longer exists.
- **`provider`** — Which model provider served the call.
  - Observed: otel: `gen_ai.system`, openllmetry: `gen_ai.provider.name`, aisdk: `gen_ai.provider.name`
- **`request_model`** — Model the application asked for. Not the one that answered.
- **`response_model`** — Model that actually answered, pinned to a dated build. This plus token counts is the only route to cost — no stack emits a price.
- **`response_id`** — Provider-side id for the completion.
- **`finish_reason`** — Why generation stopped. Three stacks, three spellings of the same value — the single clearest argument for normalising at read time.
  - Observed: otel: `tool_calls`, openllmetry: `tool_call`, aisdk: `tool-calls`
- **`input_tokens`** — Prompt tokens billed.
- **`output_tokens`** — Completion tokens billed.
- **`total_tokens`** — Traceloop only, and not a semconv key. Derive it from input plus output rather than depending on it.
  - Observed: openllmetry: `gen_ai.usage.total_tokens`
- **`cache_read_input_tokens`** — Prompt tokens served from provider cache. AI SDK only.
  - Observed: aisdk: `gen_ai.usage.cache_read.input_tokens`
- **`cache_creation_input_tokens`** — Prompt tokens written to provider cache. AI SDK only.
  - Observed: aisdk: `gen_ai.usage.cache_creation.input_tokens`
- **`reasoning_output_tokens`** — Reasoning tokens. Semconv has a name for this; the AI SDK emits its own instead, so the semconv name leads and the vendor key is the fallback.
  - Observed: aisdk: `ai.usage.outputTokenDetails.reasoningTokens`
- **`tool_call_id`** — Provider-side id joining a tool call to its result.
- **`tool_call_arguments`** — Arguments the model chose for a tool call.
- **`tool_call_result`** — Value the tool returned to the model.
- **`input_messages`** — The conversation sent to the model. Traceloop and the AI SDK put this on span attributes; @opentelemetry/instrumentation-openai puts it on the logs signal instead, so a span-only consumer sees nothing there.
  - Observed: openllmetry: `gen_ai.input.messages`, aisdk: `gen_ai.input.messages`
- **`output_messages`** — What the model returned.
- **`system_instructions`** — The system prompt.
  - Observed: aisdk: `gen_ai.system_instructions`
- **`tool_definitions`** — Tool schemas offered to the model. Traceloop nests them under `function`, the AI SDK flattens them — same information, two shapes.
- **`server_address`** — Host the provider call went to.
- **`server_port`** — Port the provider call went to. An int, not a string.

## `vendor.content`

*consumed*

Vendor-specific keys with no canonical field of their own, classified as content so redaction covers them. Listed rather than pattern-matched because the names give no hint of what they hold.

- `ai.response.providerMetadata`

## `exception.content`

*consumed*

Error text, which is content like any other. An exception message is written by application code that was holding the prompt a moment earlier, and a stack trace carries whatever the frames were called with — neither is safe to treat as metadata just because it describes a failure. These arrive as span *event* attributes rather than span attributes, which is why they were invisible to redaction until the exporter learned to walk events. Listed by name rather than left to the length heuristic because that bound only applies to scopes we do not control, and `withTool()` recording its own failure is our own scope. `exception.type` is deliberately absent: a class name is a fact about the code, not about the customer's data, and it is the one part of a failure that stays legible at `capture: 'none'`.

- `exception.message`
- `exception.stacktrace`

## `environment.denied`

*denied*

Resource attributes nobody asked for. Traceloop's default detectors ship the full argv, which is a well-known place for secrets in real deployments, plus host and process identity we have no use for. Dropped at the SDK exporter for a workflow-A customer and at ingest for a workflow-B customer, from this one list.

- `process.command_args`
- `process.command_line`
- `process.command`
- `process.owner`
- `process.executable.path`
- `host.id`
- `host.ip`
- `host.mac`

## Content classification

The keys above marked `content` are the named half. Two more rules apply, so
a vendor shipping a key we have never seen fails closed rather than open.

Patterns:

- `/^gen_ai\.(prompt|completion)\.\d+\./`
- `/(^|\.)(content|messages|instructions|arguments|result|definitions)$/`

Plus: any string longer than 200 characters, on a span authored by an instrumentation scope we do not control.

