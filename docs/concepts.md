# Concepts

The model these SDKs implement, in no particular language. Read this once and
the API of any of them is obvious.

## The problem

Instrumentation for LLM calls is a solved, commodity problem — several projects
do it, and they intercept the network call to the model and record the model,
the token counts and the latency.

What none of them can record is the part that makes the data useful:

- that **five of those calls were one agent doing one job**;
- **which end user** the job was for, when the run spans three HTTP requests;
- **which prompt template and version** produced the output;
- **which governed asset** the agent corresponds to in your inventory;
- **what a tool or retrieval actually touched**.

None of it exists on the wire. None of it can be inferred by watching the
call. And none of it can be added to the data after the fact — by the time a
trace has been stored, the knowledge that would have connected it is gone.

So these SDKs do not instrument anything. They carry that knowledge, and they
attach it to spans produced by whatever instrumentation you already run.

## The mechanism

One OpenTelemetry `SpanProcessor`, registered globally. Its `onStart` fires for
**every** span created through the global provider — including spans from
libraries we have never heard of — reads values off the OTel Context, and
stamps them as attributes.

```
withIdentity({ conversationId, userId }, () =>       ← puts values on the Context
  withWorkflow({ name: 'refund-request' }, () =>     ← opens a run, starts a span
    openai.chat.completions.create(…)))              ← foreign span, stamped on start
```

Two consequences worth internalising:

1. **Your instrumentation choice does not matter to us.** The same processor
   stamps spans from the official OpenAI instrumentation, from OpenLLMetry,
   from the Vercel AI SDK's native telemetry, and from hand-rolled OTel.
2. **Exactly one copy of the OTel API must exist in your dependency tree.** Two
   copies mean two context managers; the values are set in one and read from
   the other, and the stamping silently stops. This is the single most common
   integration failure.

## The four scopes

Each is a nesting level, and each is set on the Context rather than by
decorating a call site.

| Scope | Set by | Lives for |
|---|---|---|
| **Agent** | `init` (or `withAgent`) | the process |
| **Conversation** | `withIdentity` | many requests, many traces |
| **Run** | `withWorkflow` | one unit of work, one trace |
| **Prompt** | `withPrompt` | one model call |

### Conversations are not traces

A span cannot outlive its process, so a conversation spanning three HTTP
requests can never be a parent span — the three requests produce three
unrelated traces. The link is an **attribute**, `gen_ai.conversation.id`,
resolved at query time.

This is why the conversation id has to come from your application. Nothing in
the transport knows that request 2 continues request 1.

### Runs are minted, not observed

`withWorkflow` mints `octic.run.id` and opens the span everything else nests
under. Only your code knows where a turn begins — the first model call of a run
looks identical to the second.

The run id is also the primary key for things that arrive *after* the run
closed: evaluations, and end-user feedback. Those are writes against the run
id, not telemetry, which is why the id is minted even before anything reads it
back.

### Targets are what makes the graph join

`withTool` and `withRetrieval` record **what was touched** — a datastore, an
API, a dashboard — not just that something was. That reference is what connects
a trace to the governed asset inventory, and it is unavailable to any
interception layer, which sees an HTTP call to a hostname at best.

## What is deliberately not here

- **Instrumentation.** Documenting a two-line registration snippet costs a
  paragraph; shipping HTTP instrumentation costs a dependency, a version
  matrix, double-registration bugs, and a slope toward maintaining framework
  instrumentation for five frameworks.
- **A general-purpose trace viewer.** These SDKs answer governance questions
  about agents. If you want distributed tracing for your whole system, run
  OpenTelemetry and send it somewhere built for that — you can do both, from
  the same spans.

## Next

- [Content policy](content-policy.md) — what leaves your process
- [Wire format](wire-format.md) — endpoints, authentication, what we accept
- [Attribute contract](../contract/ATTRIBUTES.md) — every key, frozen
