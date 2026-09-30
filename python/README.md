# `octichq-airlock-sdk`

Agent telemetry for [Octic](https://octic.ai) — OpenTelemetry spans, stamped
with the Octic attribute contract.

> **Spool-only.** This release writes telemetry to a local directory and does
> not talk to any Octic service: no credential, no network call. A separate
> reader process delivers what it writes.

## What it is, and what it is not

**It ships no instrumentation.** Bring whatever you already run — the OpenAI
instrumentation, OpenLLMetry, or stock OpenTelemetry — and this package adds the
layer above it: the layer that knows *these five model calls were one agent
doing one job, for that customer, from that prompt template.*

That layer is the part no interception can produce. Intercepting the network
call to a model tells you the model, the tokens and the latency. It cannot know
where a run began, which end user it was for, or which governed asset the agent
is. None of it can be added to the data afterwards.

The mechanism is one OpenTelemetry `SpanProcessor`. It reads values off the
OpenTelemetry context and stamps them onto every span created through the
provider — **including spans this package did not create**. That is why your
instrumentation, whichever you chose, comes out carrying your identity.

## Install

```bash
pip install octichq-airlock-sdk
```

`opentelemetry-api` and `opentelemetry-sdk` come with it, and exactly one copy
of the API must exist in your environment — two copies mean two context
managers, and the stamping silently stops working.

## Use

Once per process, before the libraries you want observed are imported:

```python
from octichq_airlock_sdk import Agent, init

telemetry = init(
    service_name="checkout-agent",
    service_version="1.4.2",
    agent=Agent(agent_id="refunds", name="Refunds Agent"),
    environment="production",
)
```

`init()` never raises.

Then annotate what only your application knows:

```python
from octichq_airlock_sdk import with_identity, with_prompt, with_tool, with_workflow

with with_identity(conversation_id=conversation_id, user_id=user_id):
    with with_workflow(name="refund-request", input=message) as run:
        with with_prompt(template="refund-triage", version="3"):
            ...  # your model calls, instrumented by whatever you already run

        with with_tool(name="lookup_order"):
            ...

        run.set_output(result)
```

Call `telemetry.shutdown()` from your own shutdown path — the package registers
no `atexit` hook.

| Call | What it does |
|---|---|
| `init` | wiring, once, before anything else |
| `with_identity` | conversation and end user; sets context, emits no span |
| `with_agent` | only if one process runs several agents |
| `with_prompt` | which template produced this call |
| `with_workflow` | the run root, and the run id |
| `with_retrieval` | a lookup that fetched context |
| `with_tool` | a tool execution |
| `with_content` | override the content policy for one run |

Each annotation also works as `async with` and as a decorator over a sync or an
async function.

## Content policy

Prompts, tool arguments and model output are your data rather than telemetry
about it, and none of them are needed to answer a governance question — the
agent, the run, the prompt *name*, the token counts and the asset references all
survive with content switched off.

| level | what leaves your process |
|---|---|
| `full` | the content, after your `redact` hook and `max_length` |
| `metadata` | a length and a hash, not the content |
| `none` | nothing. Everything else is untouched, and the product works here |

The default is **`none`** — unlike the Node SDK, because this SDK writes to a
directory on the host's own disk rather than sending anywhere, and content there
sits at rest. Set it per process with
`init(content=ContentOptions(capture="full"))`, or per run with `with_content`.

## Requirements

| | |
|---|---|
| Python | 3.10+ |
| Runtime dependencies | `opentelemetry-api`, `opentelemetry-sdk` |
| Signals | traces |
| Typing | ships `py.typed` |

Spans are exported by a `BatchSpanProcessor` on its own worker thread;
`SimpleSpanProcessor` is refused, because it would write to disk on the thread
that ended the span.

## Links

- [Repository](https://github.com/OcticHQ/telemetry)
- [Usage guide](https://github.com/OcticHQ/telemetry/blob/main/docs/full-python-guide.md)
  — every feature, and how they compose
- [Concepts](https://github.com/OcticHQ/telemetry/blob/main/docs/concepts.md)
- [Attribute contract](https://github.com/OcticHQ/telemetry/blob/main/contract/ATTRIBUTES.md)
  — every key this SDK writes, frozen
- [Content policy](https://github.com/OcticHQ/telemetry/blob/main/docs/content-policy.md)

## Licence

Apache-2.0
