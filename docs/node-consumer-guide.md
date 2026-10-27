# Octic Agent SDK for Node

Adds the context your telemetry is missing — which agent, which run, which user,
which prompt — to the spans your application already produces.

Four steps: install, initialize, instrument, annotate.

## 1. Install

```bash
npm install @octichq/airlock-sdk @opentelemetry/api
```

Node 20 or newer, ESM. `@opentelemetry/api` is a peer dependency, and exactly
one copy of it must be installed — two copies mean the tags are set in one and
read from the other, and nothing is tagged.

## 2. Initialize

In a file of its own, loaded before your application:

```ts
// telemetry.ts
import { init } from '@octichq/airlock-sdk';

export const telemetry = init({
  serviceName: 'checkout-agent',
  agent: { id: 'refunds', name: 'Refunds Agent' },
  environment: 'production',
});
```

```bash
node --import ./telemetry.ts server.ts
```

Start the process with `--import`, not with an import at the top of
`server.ts`. Instrumentation patches libraries as they load, so a library loaded
before `init()` runs is not observed — and the process exits cleanly having
reported nothing.

Spans are written to a spool directory on local disk, and Octic picks them up
from there. Nothing is sent over the network, and no key or credential is
needed.

When your service shuts down, flush what is queued:

```ts
await telemetry.shutdown();
```

The SDK registers no exit hook of its own, so call this from your shutdown path
— a `SIGTERM` handler, a `finally`, your framework's close hook.

## 3. Instrument your model calls

This SDK does not trace your model calls itself. It tags and stores the spans
that OpenTelemetry instrumentation creates. If nothing in your process is
instrumented, the model calls do not appear at all, and nothing reports an
error.

If you already run OpenTelemetry instrumentation for your model provider, you
are done — it is picked up as long as it is registered after `init()`. If not,
add one. For example, for the OpenAI client:

```bash
npm install @opentelemetry/instrumentation @opentelemetry/instrumentation-openai
```

```ts
// telemetry.ts, after init()
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { OpenAIInstrumentation } from '@opentelemetry/instrumentation-openai';

registerInstrumentations({ instrumentations: [new OpenAIInstrumentation()] });
```

Every model call now produces a span carrying the model, token counts, latency
and errors, tagged with your agent.

Other options:

- **Official OpenTelemetry instrumentation** for other libraries, published as
  `@opentelemetry/instrumentation-*` packages.
- **[OpenLLMetry](https://github.com/traceloop/openllmetry-js)** —
  instrumentation for Anthropic, Bedrock, LangChain, LlamaIndex, vector
  databases and more.
- **The Vercel AI SDK's built-in telemetry** — set
  `experimental_telemetry: { isEnabled: true }` on its calls.

If an all-in-one SDK such as Traceloop, Datadog or Langfuse is already set up in
your service, it owns the tracer provider and `init()` cannot register one. Use
`initWithExternalProvider()` instead — see [Other options](#other-options).

## 4. Annotate

Wrap the work you want to see. Everything inside a wrapper — including calls
made by libraries that know nothing about Octic — is tagged automatically.

```ts
import { withIdentity, withTool, withWorkflow } from '@octichq/airlock-sdk';

const reply = await withIdentity({ conversationId, userId }, () =>
  withWorkflow({ name: 'refund-request', input: message }, async () => {
    const response = await client.chat.completions.create({ ... });

    const order = await withTool({ name: 'lookup_order' }, () => lookupOrder(orderId));

    return response;
  }),
);
```

That is it. Your spans now carry the user, the conversation, the run and the
tool call. Whatever a wrapped function returns is recorded as its output.

### The wrappers

**Who this is for** — wrap your request handler:

```ts
await withIdentity({ conversationId: 'conv-123', userId: 'user-456' }, () => handle(request));
```

**One unit of work** — wrap a whole agent turn. This is the important one: it
groups everything inside it into a single run.

```ts
await withWorkflow({ name: 'refund-request', input: message }, async () => {
  ...
  return result;
});
```

**A tool call**, and what it touched:

```ts
await withTool(
  { name: 'lookup_order', target: { name: 'orders-db', type: 'datastore' } },
  () => lookupOrder(orderId),
);
```

**A lookup that fetched context** — a vector search, a document fetch:

```ts
await withRetrieval({ name: 'policy-docs', input: 'refund window' }, () => search(query));
```

**Which prompt produced a call** — wrap the model call:

```ts
await withPrompt({ template: 'refund-triage', version: '3' }, () =>
  client.chat.completions.create({ ... }),
);
```

`withWorkflow`, `withTool` and `withRetrieval` take an async function.
`withIdentity` and `withPrompt` take any function and return what it returns.

## Capturing prompts and output

**Prompt text and model output are not captured by default.** Everything else
is: the agent, the run, the user, the prompt name and version, the token counts,
the timings and the tool names. You get the full picture of what happened
without the text of what was said.

If you do want the text — for debugging, or for evaluating output quality — turn
it on:

```ts
init({
  serviceName: 'checkout-agent',
  content: { capture: 'full' },
});
```

`capture: 'metadata'` is the middle option: a length and a hash instead of the
text, enough to tell whether two runs used the same prompt without storing it.

Under `full`, you can scrub values on the way out:

```ts
init({
  serviceName: 'checkout-agent',
  content: {
    capture: 'full',
    redact: (value, key) => (key.includes('password') ? undefined : value),
    maxLength: 4096,
  },
});
```

## Troubleshooting

| What you see | Why |
|---|---|
| Spans have none of your tags | Two copies of `@opentelemetry/api` are installed. Run `npm ls @opentelemetry/api` — there must be exactly one. |
| Nothing at all | Run with `OCTIC_TELEMETRY_DEBUG=1` and read what it prints at startup. |
| Your own spans are tagged, library spans are not | The libraries loaded before `init()` ran. Start the process with `node --import ./telemetry.ts`. |
| Workflow and tool spans appear, model calls do not | Nothing instrumented your model client, or it was registered before `init()` ran. See [step 3](#3-instrument-your-model-calls). |

`init()` never throws, and neither does any other part of the SDK. If telemetry
cannot work, your application still runs.

## Span destinations

Spans are written to a directory on local disk and shipped from there. The SDK
uses `$OCTIC_SPOOL_DIR` if it is set, then `/var/spool/octic` if it is
writable, otherwise a per-user directory under your home or temp directory.

To choose it yourself:

```ts
init({
  serviceName: 'checkout-agent',
  spool: { dir: '/var/spool/octic' },
});
```

The directory is capped at 64 MiB and 72 hours, and old entries are dropped
first, so it cannot grow without limit.

## Other options

`init()` takes a few more optional config options:

| Option |  |
|---|---|
| `serviceVersion` | your service's version |
| `resourceAttributes` | extra attributes on every span |
| `endpoint` | where Octic should receive the data; defaults to Octic's ingest |
| `batch` | batching sizes and timings |
| `spool: { mode: 'fallback' }` with `auth` | send over OTLP/HTTP instead, and spool only what could not be delivered |

And a few more wrappers, for unusual cases:

| | |
|---|---|
| `withAgent` | only if one process runs more than one agent |
| `withContent` | change content capture for one run instead of the process |

If another library in your process already owns OpenTelemetry's tracer provider,
use `initWithExternalProvider()` instead. Add the `spanProcessor` it returns to
that library's provider, then the `spanExporter` wrapped in a
`BatchSpanProcessor`.

## Licence

Apache-2.0.
