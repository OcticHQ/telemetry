# The Octic Telemetry SDK usage guide

Your application already knows things no instrumentation can work out for
itself: that five model calls were one agent doing one job, which prompt
template produced a completion, which end user a conversation belongs to, which
datastore a tool actually touched.

None of that exists on the wire. Watching the network call to a model tells you
the model, the token counts and the latency. It cannot know where a run began or
who it was for, and none of it can be added to the data afterwards — by the time
a trace is stored, the knowledge that would have connected it is gone.

So this package instruments nothing. It carries that knowledge on the
OpenTelemetry context and stamps it onto spans, including spans produced by
instrumentation that has never heard of Octic. Bring whichever OpenTelemetry
instrumentation you already run; this enriches what it emits. The mechanism is one `SpanProcessor` whose `on_start` fires for every span
created through the tracer provider.

## Install

```bash
pip install octichq-airlock-sdk
```

Python 3.10 or newer. The only runtime dependencies are `opentelemetry-api` and
`opentelemetry-sdk`; the package ships type information (`py.typed`) and no
instrumentation.

That last part is a requirement, not a detail. Model calls reach the spool only
if some OpenTelemetry instrumentation — the official
`opentelemetry-instrumentation-*` packages, OpenLLMetry, or
`opentelemetry-instrument` auto-instrumentation — creates spans for them. With
none installed, the annotations still write their own spans, but the model calls
inside them are missing, and nothing reports it: the silence warning under
[Debugging](#debugging) arms on the first span started, so a process with no
instrumentation and no annotations stays silent. Set instrumentation up after
`init()`.

## Initialize

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

Import order is the one thing that is easy to get wrong and silent when you do.
Instrumentation libraries patch the modules they observe at import time, so a
library imported before `init()` runs may already have been wrapped — or not
wrapped at all. Put the call in your entry point ahead of the imports that
matter, not at the top of a module that something else imports first.

`init()` **never raises.** It returns a handle in all cases, and there are three
outcomes — see [Failure behaviour](#failure-behaviour).

### What `endpoint` does

This release makes no network call. `endpoint` is recorded in the spool
manifest, which is how the reader that ships your telemetry knows where to
deliver it, and it defaults to Octic's ingest — set it only if your data goes
somewhere else.

### Options

| Option | Default | What it is |
|---|---|---|
| `service_name` | required | your service, as it appears in the resource |
| `endpoint` | Octic's ingest | recorded in the spool manifest; never contacted |
| `service_version` | `"0.0.0"` | your service's version |
| `agent` | `None` | `Agent(agent_id=…, name=…, asset_ref=…)` |
| `environment` | `None` | `production`, `staging` — stamped as the deployment environment |
| `resource_attributes` | `None` | extra resource attributes; wins over `OTEL_RESOURCE_ATTRIBUTES` |
| `content` | `None` | `ContentOptions` — see [Content policy](#content-policy) |
| `spool` | `None` | `SpoolOptions` — see [Where the telemetry goes](#where-the-telemetry-goes) |
| `batch` | `None` | `BatchOptions` — the four OpenTelemetry batching knobs |

All keyword-only.

## Where the telemetry goes

**To a directory on local disk.** This release holds no credential, opens no
socket and makes no network call. Each export batch is written as an OTLP/JSON
segment, and a separate reader process delivers those segments.

That is the most surprising property of this release, so it is worth stating
plainly rather than discovering: nothing you configure here causes an outbound
request.

### Which directory

The first usable candidate wins:

1. `SpoolOptions(dir=...)`
2. `$OCTIC_SPOOL_DIR`
3. `/var/spool/octic`
4. `$XDG_STATE_HOME/octic/spool`, else `~/.local/state/octic/spool`
5. `$TMPDIR/octic-spool-<uid>`

A candidate is **refused** if it is a symlink, is not owned by the running user,
or is group- or world-writable. Telemetry can contain your users' prompts; a
directory someone else can write to is a directory someone else can read from.
The chosen directory is created `0700` and its files `0600`.

Ask the handle where it landed:

```python
print(telemetry.spool.directory())   # None until the first batch resolves it
print(telemetry.spool.stats())       # written, bytes, dropped, evicted, failures, disabled
```

### Bounds

```python
from octichq_airlock_sdk import SpoolOptions, init

init(
    service_name="checkout-agent",
    spool=SpoolOptions(
        dir="/var/spool/octic",
        max_bytes=64 * 1024 * 1024,   # default
        max_files=10_000,             # default
        max_age_seconds=72 * 60 * 60, # default
        on_overflow="evict-oldest",   # or "drop-new"
        fsync=True,                   # default
    ),
)
```

The spool never grows without limit and never holds anything in memory: a
segment is written to a temporary file, fsynced, and atomically renamed, so a
file a reader can see is a file that is complete. If the directory turns out to
be unwritable it warns once, disables itself, and retries later — it does not
raise, and it does not queue.

There is no `enabled` and no `mode`. The spool is the only sink in this release,
so switching it off would switch telemetry off.

## The scopes

A scope puts a value on the OpenTelemetry context. Every span started inside it
carries the value — including spans from instrumentation that knows nothing
about this package. That is the whole point, and it is why these are context
managers rather than decorators on your call sites.

Each returns a binding usable as `with` or `async with`.

```python
from octichq_airlock_sdk import with_identity, with_prompt

with with_identity(conversation_id=conversation_id, user_id=user_id):
    with with_prompt(template="refund-triage", version="3"):
        await client.chat.completions.create(...)   # foreign span, stamped on start
```

| Scope | Signature | Lives for |
|---|---|---|
| `with_identity` | `conversation_id=`, `user_id=`, `attributes=` | many requests, many traces |
| `with_agent` | `agent_id=`, `name=`, `asset_ref=` | usually the process |
| `with_prompt` | `template=`, `version=` | one model call |
| `with_run` | `run_id` (positional) | one unit of work |
| `with_content` | `capture` (positional) | see [Content policy](#content-policy) |

### Three behaviours you cannot guess from the names

**`with_identity` merges; `with_agent` replaces.** An outer middleware can name
the conversation and an inner call can add a business id without clobbering it.
Agents do not work that way: two agents are two agents, so an inner declaration
replaces the outer one.

**A conversation id is written twice** — to `gen_ai.conversation.id` and to
`session.id` — so it joins in both vocabularies.

**Your own attributes cannot collide with ours.** The `attributes` mapping is
stamped under the customer prefix, never the reserved `octic.` one. This is
structural: without the split, a tenant key could overwrite `octic.run.id`.

### Reading the current values

```python
from octichq_airlock_sdk import current_identity, current_run_id, current_capture
```

For code that needs to correlate outside a span — a log line, a response body.

### Conversations are not traces

A span cannot outlive its process, so a conversation spanning three HTTP
requests can never be a parent span. The link is an attribute, resolved at query
time, which is why the conversation id has to come from your application:
nothing in the transport knows that request 2 continues request 1.

## The annotations

Where a scope adds context to spans that already exist, an annotation **creates**
a span: a unit of work you want to see as a unit.

```python
from octichq_airlock_sdk import with_retrieval, with_tool, with_workflow
```

| Annotation | Signature | Creates |
|---|---|---|
| `with_workflow` | `name=`, `input=`, `target=`, `run_id=` | the run root — and mints the run id |
| `with_tool` | `name=`, `input=`, `target=`, `tool_type=` | one tool execution |
| `with_retrieval` | `name=`, `input=`, `target=` | one lookup that fetched context |

`with_workflow` is the only one that opens the run scope. Only your code knows
where a turn begins — the first model call of a run looks exactly like the
second. Pass `run_id=` to adopt an id your application already has; otherwise one
is minted, and `mint_run_id("chat-turn")` gives you the same shape by hand.

The run id is also the primary key for things that arrive *after* the run
closed — evaluations, end-user feedback — which is why it is minted even when
nothing reads it back immediately.

### Four call forms

Each annotation returns one object that is a sync context manager, an async
context manager, and a decorator over either kind of function. Use whichever
fits the call site:

```python
# 1 — a block
with with_workflow(name="refund-request", input=message) as run:
    result = handle(message)
    run.set_output(result)

# 2 — an async block
async with with_workflow(name="refund-request") as run:
    result = await handle(message)
    run.set_output(result)

# 3 — a decorator
@with_tool(name="lookup_order")
def lookup_order(order_id: str) -> Order:
    ...

# 4 — over an async function
@with_tool(name="lookup_order")
async def lookup_order(order_id: str) -> Order:
    ...
```

The difference that matters: **the block forms set the output explicitly**, via
`set_output()` on the handle they yield, because a block has no return value to
read. The decorator forms take it from what the function returned.

A decorator is safe to apply once and call concurrently — each invocation gets
its own span rather than sharing the decorated one. Attributes are built when
the annotation is *entered*, not when it is constructed, so a decorator defined
at import time still records content under the policy in force when it actually
runs.

Failures are recorded as a span **status**, not as an exception event. Recording
the event is what OpenTelemetry does by default, and it writes the message and
stack trace into your telemetry — content arriving without anyone deciding to
send it.

### Targets are what make the graph join

```python
from octichq_airlock_sdk import Target, with_tool

with with_tool(
    name="lookup_order",
    target=Target(name="orders-db", type="datastore", asset_ref="postgres:orders"),
):
    ...
```

`target` records **what was touched** — a datastore, an API, a dashboard — not
just that something was. That reference is what connects a trace to a governed
asset, and it is unavailable to any interception layer, which sees an HTTP call
to a hostname at best.

`tool_type` is a different question: what kind of thing the *model* called. It
defaults to a plain function and is deliberately not derived from `target.type`.

## Content policy

Prompts, tool arguments and model output are **your data**, not telemetry about
it. Three levels:

| level | what leaves your process |
|---|---|
| `full` | the content, after your redactor and the length cap |
| `metadata` | a length and a hash — enough to tell whether two runs used the same prompt, without the prompt |
| `none` | nothing |

**Every governance attribute is identical at all three levels.** The agent, the
run id, the conversation, the prompt *name* and version, the token counts, the
latencies and the asset references all survive with content switched off. You
lose the ability to read what was said, and nothing else.

```python
from octichq_airlock_sdk import ContentOptions, init

init(
    service_name="checkout-agent",
    content=ContentOptions(capture="none"),
)
```

Per run, on the same context mechanism as identity — so the override reaches
foreign spans too:

```python
from octichq_airlock_sdk import with_content

with with_content("metadata"):
    ...
```

### The default is `none`, and it is opt-in

This differs from the Node SDK, which defaults to `full`. The reason is the
spool: this SDK has no transport, so what it captures is written to a directory
on the host's own disk and sits there at rest until a reader collects it.
Defaulting to `full` would put a consumer's prompts on their disk because they
installed a package, not because they decided to.

Turn it on deliberately when you want it — debugging an agent, or evaluating
output quality — and prefer `metadata` where you only need to correlate.

### Redactors

```python
def redact(value: str, key: str) -> str | None:
    return None if key.endswith(".password") else value

ContentOptions(capture="full", redact=redact, max_length=4096)
```

A redactor takes the value and the key it arrived under, and returns a
replacement or `None` to drop the value. It runs only under `full`, and it
**must not raise** — if it does, the value is dropped rather than passed
through. A broken redactor fails closed.

`allow_attributes` and `content_attributes` adjust which keys count as content
at all, for instrumentation we have not measured. Which keys are content by
default is derived from the attribute contract, not a hand-maintained list.

## Operating it

### Shutdown is yours to call

```python
telemetry.shutdown()
```

The SDK registers no `atexit` hook and installs no signal handler: a library
must not decide how its host exits. Call `shutdown()` from your own shutdown
path — a framework lifespan, a `finally`, a signal handler. It is latched, so
two callers are fine, and it never raises.

What a process loses by skipping it is the **batch processor's queue** — spans
recorded but not yet exported. Not the spool: those writes are synchronous, so
anything the spool accepted is already on disk.

```python
telemetry.force_flush(timeout_millis=30_000)   # drain now, on the calling thread
```

### Batching

Spans are exported by a `BatchSpanProcessor` on its own worker thread, always.
`SimpleSpanProcessor` is refused, because it exports on the thread that ended
the span — one of your request threads — which is where a blocking disk write
becomes your latency.

`BatchOptions` sets the four knobs, and all four are always passed. That takes
the `OTEL_BSP_*` environment fallback out of play deliberately: `init(batch=...)`
is the one place they are set, visible in your own source.

### Debugging

```bash
OCTIC_TELEMETRY_DEBUG=1
```

Attaches a handler to this package's logger at debug level and exposes the
internal counters — what was dropped, failed or swallowed. Otherwise the package
adds no logging handler at all, because logging is the application's to
configure.

The signal to watch for is **spans produced and no segment written**, which the
package warns about on its own once `init()` has run.

## Failure behaviour

**Telemetry must never become your problem.** `init()` never raises, exporters
never raise into your code, and a callback of ours cannot take out the call you
were actually making. A redactor that throws, an identity value of the wrong
type, an unwritable spool directory — each is handled and counted, not
propagated.

`init()` has three outcomes, all reachable in normal use:

| Outcome | What happened | What you get |
|---|---|---|
| normal | the pipeline was built and registered | a working handle |
| degraded | another SDK had already registered the global tracer provider | an inert handle, and a warning naming `init_with_external_provider()` |
| failed | setup raised; it was caught and logged | an inert handle; the process runs without telemetry |

A second `init()` call warns and returns the existing pipeline rather than
building a second one.

The degraded case is worth knowing about in advance. Python ignores a second
`set_tracer_provider()` with a single log line, so without this check you would
have a pipeline nothing reaches and a success you could not distinguish from a
working one.

## Running under another SDK

If something else owns the tracer provider — a framework, a vendor SDK — hand it
the parts instead:

```python
from octichq_airlock_sdk import init_with_external_provider

telemetry = init_with_external_provider(
    service_name="checkout-agent",
)

host_provider.add_span_processor(telemetry.span_processor)    # enriches
host_provider.add_span_processor(telemetry.export_processor)  # exports
```

Same signature as `init()`. It creates no provider and registers nothing
globally. Add both processors, **in that order** — until both reach the host's
provider, no span is enriched and none is written.

One thing to check, because it fails quietly: the annotations resolve their
tracer from the **global** provider. Practically every host SDK registers itself
globally — that is exactly why `init()` has to check whether one got there
first — but if yours does not, `with_workflow` and friends produce non-recording
spans and nothing is written, while your host's own spans are enriched normally.
If the spool stays empty in this mode, that is the thing to look at.

`telemetry.span_exporter` is there for a host that accepts only an exporter.
Wrap it in a `BatchSpanProcessor`, never a `SimpleSpanProcessor`.
`telemetry.capture_content` is for a host with its own content switch — pass it
through, so content is never produced rather than produced and then stripped.

In this mode the agent, environment and SDK version ride on each span rather
than on the resource, since the resource belongs to the host.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Spans are produced but carry none of your scopes | Two copies of `opentelemetry-api` in the environment. The values are set in one context manager and read from the other. Check with `pip list \| grep opentelemetry`. |
| Nothing at all, and no error | `init()` ended `degraded` or `failed`. It already logged the reason — set `OCTIC_TELEMETRY_DEBUG=1` and read it. |
| No spool directory appears | Every candidate was refused. A directory is rejected if it is a symlink, is not owned by you, or is group/world-writable. `telemetry.spool.directory()` returns `None`. |
| The directory exists but stays empty | Nothing has been exported yet — the batch processor waits ~5s for company. `force_flush()` to check. |
| Spans arrive with no prompts or outputs | Expected: the default is `none`. Set `capture="full"` if you want the text. |
| Spans from your own code are stamped, foreign ones are not | Instrumentation was imported and patched before `init()` ran, or it uses its own provider rather than the global one. |
| Annotation spans appear, model calls do not | No instrumentation covers your model client, or it was set up before `init()` ran. See [Install](#install). |
| A decorated function's output is missing | Only the decorator forms read the return value. In a `with` block, call `set_output()`. |
| Under `init_with_external_provider()`, host spans are enriched but annotations write nothing | The annotations use the global tracer provider and the host never registered itself as one. |

## Reference

- [Concepts](https://github.com/OcticHQ/telemetry/blob/main/docs/concepts.md) —
  the model, in no particular language
- [Content policy](https://github.com/OcticHQ/telemetry/blob/main/docs/content-policy.md)
  — what leaves your process, in more depth
- [Attribute contract](https://github.com/OcticHQ/telemetry/blob/main/contract/ATTRIBUTES.md)
  — every key this SDK writes, frozen. `ATTR` in this package carries the same
  keys as a dot-completable object, which is what to query against.
- [Spool format](https://github.com/OcticHQ/telemetry/blob/main/contract/SPOOL.md)
  — what the SDK writes and a reader consumes

## Licence

Apache-2.0.
