# @octichq/airlock-sdk

Agent telemetry for [Octic](https://octic.ai) — OpenTelemetry spans, stamped
with the Octic attribute contract.

> **Spool-only by default.** The SDK writes telemetry to a local directory and
> does not talk to any Octic service: no credential, no network call. A
> separate reader process delivers what it writes.

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
npm install @octichq/airlock-sdk @opentelemetry/api
```

`@opentelemetry/api` is a peer dependency, and exactly one copy of it must
exist in your tree — two copies mean two context managers, and the stamping
silently stops working.

## Use

```ts
// telemetry.ts — imported before anything else
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

Telemetry must finish initialising before the libraries it observes are
imported. Start the process with `--import`, not a top-of-file import — get
this wrong and the run exits cleanly, reports no error, and produces nothing.

Call `await telemetry.shutdown()` from your own shutdown path — the package
registers no exit hook.

Then annotate what only your application knows:

```ts
import { withIdentity, withWorkflow, withTool, withPrompt } from '@octichq/airlock-sdk';

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

The default is **`none`**, because the SDK writes to a directory on the host's
own disk and content there sits at rest. Set it per process with
`init({ content: { capture: 'full' } })`, or per run with `withContent`.

## Where the telemetry goes

To a spool directory on local disk: `$OCTIC_SPOOL_DIR` if it is set, then
`/var/spool/octic`, then a per-user directory. Each export batch is written as
an OTLP/JSON segment, and a separate reader delivers it. Nothing is sent over
the network by default.

To send over OTLP/HTTP instead, and spool only what could not be delivered:

```ts
init({
  serviceName: 'checkout-agent',
  endpoint: 'https://ingest.octic.ai',
  auth: { kind: 'apiKey', apiKey: process.env.OCTIC_API_KEY! },
  spool: { mode: 'fallback' },
});
```

## Requirements

- Node 20 or newer.
- Exactly one `@opentelemetry/api` in the dependency tree.
- ESM. The package ships compiled JavaScript with type declarations; it is not
  transpiled for CommonJS.

## Links

- [Repository](https://github.com/OcticHQ/telemetry)
- [Usage guide](https://github.com/OcticHQ/telemetry/blob/main/docs/node-consumer-guide.md)
- [Concepts](https://github.com/OcticHQ/telemetry/blob/main/docs/concepts.md)
- [Attribute contract](https://github.com/OcticHQ/telemetry/blob/main/contract/ATTRIBUTES.md)
  — every key this SDK writes, frozen
- [Content policy](https://github.com/OcticHQ/telemetry/blob/main/docs/content-policy.md)
- [Changelog](https://github.com/OcticHQ/telemetry/blob/main/node/CHANGELOG.md)

## Licence

Apache-2.0
