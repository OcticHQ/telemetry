# @octic/telemetry

Agent telemetry for Node — OTLP wiring, durable identity, and agent
annotations.

> **Not published yet.** This package is scaffolding while the SDK is finished
> in a separate proof of concept. The pipeline below is real; the surface is
> not. Watch
> [OcticHQ/octic-telemetry](https://github.com/OcticHQ/octic-telemetry).

## What it is, and what it is not

**It ships no instrumentation.** Bring whatever you already run — the official
OpenAI instrumentation, OpenLLMetry, the Vercel AI SDK's built-in telemetry, or
stock OpenTelemetry — and this package adds the layer above it: the layer that
knows *these five model calls were one agent doing one job, for that customer,
from that prompt template.*

That layer is the part no interception can produce. Intercepting the network
call to a model tells you the model, the tokens and the latency. It cannot know
where a run began, which end user it was for, or which governed asset the agent
is. None of it can be added to the data afterwards.

The mechanism is one OpenTelemetry `SpanProcessor`. It reads values off the
OTel Context and stamps them onto every span created through the global
provider — **including spans this package did not create**. That is why your
instrumentation, whichever you chose, comes out carrying your identity.

## Install

```bash
npm install @octic/telemetry @opentelemetry/api
```

`@opentelemetry/api` is a peer dependency, and exactly one copy of it must
exist in your tree — two copies mean two context managers, and the stamping
silently stops working.

## Use

```ts
// telemetry.ts — imported before anything else
import { init } from '@octic/telemetry';

init({
  endpoint: 'https://ingest.octic.ai',
  apiKey: process.env.OCTIC_API_KEY,
  serviceName: 'checkout-agent',
  agent: { id: 'refunds', name: 'Refunds Agent' },
  environment: 'production',
});
```

```bash
node --import ./telemetry.ts server.ts
```

Telemetry must finish initialising before the libraries it observes are
imported. Start the process with `--import`, not a top-of-file import — get
this wrong and the run exits cleanly, reports no error, and produces nothing.

Then annotate what only your application knows:

```ts
import { withIdentity, withWorkflow, withTool, withPrompt } from '@octic/telemetry';

await withIdentity({ conversationId, userId }, () =>
  withWorkflow({ name: 'refund-request', input: message }, () =>
    withPrompt({ template: 'refund-triage', version: '3' }, async () => {
      // your model calls and tool calls, instrumented by whatever you already run
    }),
  ),
);
```

| Call | What it does |
|---|---|
| `init` | wiring, once, before anything else |
| `withIdentity` | conversation and end user; sets context, emits no span |
| `withAgent` | only if one process runs several agents |
| `withPrompt` | which template produced this call |
| `withWorkflow` | the run root, and the run id |
| `withRetrieval` | a lookup that fetched context |
| `withTool` | a tool execution |
| `withContent` | override the content policy for one run |

## Content policy

Prompts, tool arguments and model output are your data rather than telemetry
about it, and none of them are needed to answer a governance question — the
agent, the run, the prompt *name*, the token counts and the asset references
all survive with content switched off.

| level | what leaves your process |
|---|---|
| `full` | the content, after your `redact` hook and `maxLength` |
| `metadata` | `{"redacted":true,"chars":86,"sha256":"a3d44d6b…"}` |
| `none` | nothing. Everything else is untouched, and the product works here |

Set it per process in `init({ content: { capture: 'none' } })`, or per run with
`withContent`.

## Requirements

- Node 20 or newer.
- Exactly one `@opentelemetry/api` in the dependency tree.
- ESM. The package ships compiled JavaScript with type declarations; it is not
  transpiled for CommonJS.

## Links

- [Repository](https://github.com/OcticHQ/octic-telemetry)
- [Concepts](https://github.com/OcticHQ/octic-telemetry/blob/main/docs/concepts.md)
- [Attribute contract](https://github.com/OcticHQ/octic-telemetry/blob/main/contract/ATTRIBUTES.md)
  — every key this SDK writes, frozen
- [Content policy](https://github.com/OcticHQ/octic-telemetry/blob/main/docs/content-policy.md)
- [Changelog](https://github.com/OcticHQ/octic-telemetry/blob/main/node/CHANGELOG.md)

## Licence

Apache-2.0
