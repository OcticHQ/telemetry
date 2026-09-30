# Octic Agent SDK for Python

Adds the context your telemetry is missing — which agent, which run, which user,
which prompt — to the spans your application already produces.

Four steps: install, initialize, instrument, annotate.

## 1. Install

```bash
pip install octichq-airlock-sdk
```

Python 3.10 or newer.

## 2. Initialize

Once, at the top of your entry point — before you import the libraries you want
observed.

```python
from octichq_airlock_sdk import Agent, init

telemetry = init(
    service_name="checkout-agent",
    agent=Agent(agent_id="refunds", name="Refunds Agent"),
    environment="production",
)
```

Spans are written to a spool directory on local disk, and Octic picks them up
from there.

When your service shuts down, flush what is queued:

```python
telemetry.shutdown()
```

## 3. Instrument your model calls

This SDK does not trace your model calls itself. It tags and stores the spans
that OpenTelemetry instrumentation creates. If nothing in your process is
instrumented, the model calls do not appear at all, and nothing reports an
error.

If you already run OpenTelemetry instrumentation for your model provider, you
are done — it is picked up as long as it is set up after `init()`. If not, add
one. For example, for the OpenAI client:

```bash
pip install opentelemetry-instrumentation-openai-v2
```

```python
from opentelemetry.instrumentation.openai_v2 import OpenAIInstrumentor

OpenAIInstrumentor().instrument()   # after init()
```

Every model call now produces a span carrying the model, token counts, latency
and errors, tagged with your agent.

Other options:

- **Official OpenTelemetry instrumentation** for other libraries, published as
  `opentelemetry-instrumentation-*` packages.
- **[OpenLLMetry](https://github.com/traceloop/openllmetry)** — instrumentation
  for Anthropic, Bedrock, LangChain, LlamaIndex, vector databases and more.
- **Auto-instrumentation** — run your service under
  `opentelemetry-instrument python app.py` to load every installed
  instrumentation package without code changes.

If an all-in-one SDK such as Traceloop, Datadog or Langfuse is already set up in
your service, it owns the tracer provider and `init()` cannot register one. Use
`init_with_external_provider()` instead — see
[Running under another SDK](full-python-guide.md#running-under-another-sdk).

## 4. Annotate

Wrap the work you want to see. Everything inside a wrapper — including calls
made by libraries that know nothing about Octic — is tagged automatically.

```python
from octichq_airlock_sdk import with_identity, with_workflow, with_tool

with with_identity(conversation_id=conversation_id, user_id=user_id):
    with with_workflow(name="refund-request", input=message) as run:

        response = await client.chat.completions.create(...)

        with with_tool(name="lookup_order"):
            order = lookup_order(order_id)

        run.set_output(response)
```

That is it. Your spans now carry the user, the conversation, the run and the
tool call.

### The wrappers

**Who this is for** — wrap your request handler:

```python
with with_identity(conversation_id="conv-123", user_id="user-456"):
    ...
```

**One unit of work** — wrap a whole agent turn. This is the important one: it
groups everything inside it into a single run.

```python
with with_workflow(name="refund-request", input=message) as run:
    ...
    run.set_output(result)
```

**A tool call**:

```python
with with_tool(name="lookup_order"):
    ...
```

**A lookup that fetched context** — a vector search, a document fetch:

```python
with with_retrieval(name="policy-docs", input="refund window"):
    ...
```

**Which prompt produced a call** — wrap the model call:

```python
with with_prompt(template="refund-triage", version="3"):
    ...
```

### Async and decorators

`with_workflow`, `with_tool` and `with_retrieval` also work as `async with`, and
as decorators:

```python
async with with_workflow(name="refund-request") as run:
    run.set_output(await handle(message))
```

```python
@with_tool(name="lookup_order")
async def lookup_order(order_id: str) -> Order:
    ...
```

As a decorator, whatever the function returns is recorded automatically. In a
`with` block, call `run.set_output(...)` yourself.

`with_identity` and `with_prompt` work with `with` and `async with`.

## Capturing prompts and output

**Prompt text and model output are not captured by default.** Everything else
is: the agent, the run, the user, the prompt name and version, the token counts,
the timings and the tool names. You get the full picture of what happened
without the text of what was said.

If you do want the text — for debugging, or for evaluating output quality — turn
it on:

```python
from octichq_airlock_sdk import ContentOptions, init

init(
    service_name="checkout-agent",
    content=ContentOptions(capture="full"),
)
```

`capture="metadata"` is the middle option: a length and a hash instead of the
text, enough to tell whether two runs used the same prompt without storing it.

Under `full`, you can scrub values on the way out:

```python
def redact(value: str, key: str) -> str | None:
    return None if "password" in key else value

init(
    service_name="checkout-agent",
    content=ContentOptions(capture="full", redact=redact, max_length=4096),
)
```

## Troubleshooting

| What you see | Why |
|---|---|
| Spans have none of your tags | Two copies of `opentelemetry-api` are installed. Run `pip list \| grep opentelemetry` — there must be exactly one. |
| Nothing at all | Run with `OCTIC_TELEMETRY_DEBUG=1` and read the log line it prints at startup. |
| Your own spans are tagged, library spans are not | `init()` ran after those libraries were imported. Move it earlier. |
| Workflow and tool spans appear, model calls do not | Nothing instrumented your model client, or it was instrumented before `init()` ran. See [step 3](#3-instrument-your-model-calls). |
| A decorated function's output is missing | Only decorators record the return value. In a `with` block, call `set_output()`. |

`init()` never raises an error, and neither does any other part of the SDK. If telemetry cannot work, your application still runs.

## Span Destinations

Spans are written to a directory on local disk and shipped from there. By
default that is `/var/spool/octic` if it is writable, otherwise a per-user
directory under your home or temp directory.

To choose it yourself:

```python
from octichq_airlock_sdk import SpoolOptions, init

init(
    service_name="checkout-agent",
    spool=SpoolOptions(dir="/var/spool/octic"),
)
```

The directory is capped at 64 MiB and 72 hours, and old entries are dropped
first, so it cannot grow without limit.

## Other options

`init()` takes a few more optional config options:

| Option |  |
|---|---|
| `service_version` | your service's version |
| `resource_attributes` | extra attributes on every span |
| `endpoint` | where Octic should receive the data; defaults to Octic's ingest |
| `batch` | batching sizes and timings |

And a few more wrappers, for unusual cases:

| | |
|---|---|
| `with_agent` | only if one process runs more than one agent |
| `with_run` | adopt a run id your application already minted |
| `with_content` | change content capture for one run instead of the process |

If another library in your process already owns OpenTelemetry's tracer provider,
use `init_with_external_provider()` instead and hand it the two processors it
returns — `span_processor` first, then `export_processor`.

## Licence

Apache-2.0.
