# @octichq/airlock-sdk

Telemetry for workloads that run in [Airlock](https://octic.ai). Your workload's
OpenTelemetry spans, tagged with the agent, the run and the prompt, and shown
with the run in the Airlock console.

## How it works in Airlock

Your workload never sends telemetry anywhere. The SDK writes each batch of spans
to a directory on local disk, and Airlock collects it from there:

1. Airlock starts your workload with `OCTIC_SPOOL_DIR` set to that run's spool
   directory.
2. The SDK writes OTLP/JSON segments into it. No socket is opened and no key or
   credential is needed.
3. Airlock picks up the segments while the run is going and once more after your
   workload exits, then stores them against the run.
4. The run's spans appear in the console beside its other evidence, tagged with
   the run, the workload and the approved manifest it ran under.

Because Airlock reads the directory after your process exits, a workload that
crashes keeps what it had already written. What it loses is whatever was still
queued in memory, so call `shutdown()` before you exit.

## What it is, and what it is not

**It ships no instrumentation.** Bring whatever you already run — the official
OpenAI instrumentation, OpenLLMetry, the Vercel AI SDK's built-in telemetry, or
stock OpenTelemetry — and this package adds the layer above it: the layer that
knows _these five model calls were one agent doing one job, from that prompt
template, touching that datastore._

That layer is the part no interception can produce. Intercepting the network
call to a model tells you the model, the tokens and the latency. It cannot know
where a run began, which prompt template produced a call, or which asset a tool
read. None of it can be added to the data afterwards.

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
// telemetry.ts — loaded before anything else
import { init } from '@octichq/airlock-sdk';

export const telemetry = init({
  serviceName: 'loan-assessor',
  agent: { id: 'loan-assessor', name: 'Loan Assessor' },
});
```

```bash
node --import ./telemetry.ts server.ts
```

Put that in your image's `CMD`. Telemetry must finish initialising before the
libraries it observes are imported, so start the process with `--import`, not a
top-of-file import — get this wrong and the run exits cleanly, reports no error,
and produces no model-call spans.

Then register instrumentation for your model client after `init()`, and
annotate what only your workload knows:

```ts
import { withPrompt, withTool, withWorkflow } from '@octichq/airlock-sdk';

const decision = await withWorkflow(
  { name: 'assess-application', runId: process.env.AIRLOCK_RUN_ID },
  async () => {
    const reply = await withPrompt({ template: 'assessment', version: '3' }, () =>
      client.chat.completions.create({ ... }),
    );
    const income = await withTool(
      { name: 'read_statement', target: { name: 'bank_statement', type: 'datastore' } },
      () => readStatement(),
    );
    return decide(reply, income);
  },
);

await telemetry.shutdown();
```

Passing `AIRLOCK_RUN_ID` as the `runId` makes the run id on your spans the same
as the one Airlock assigned to the run, so the two line up in the console.
Airlock records its own copy of the run id alongside your spans either way.

| Call | What it does |
|---|---|
| `init` | wiring, once, before anything else |
| `withWorkflow` | the run root, and the run id |
| `withPrompt` | which template produced this call |
| `withTool` | a tool execution, and what it touched |
| `withRetrieval` | a lookup that fetched context |
| `withAgent` | only if one process runs several agents |
| `withIdentity` | conversation and end user; sets context, emits no span |
| `withContent` | override the content policy for one run |

Whatever a wrapped function returns is recorded as its output, subject to the
content policy.

## Content policy

Prompts, tool arguments and model output are your data rather than telemetry
about it, and none of them are needed to see what a run did — the agent, the
run, the prompt _name_, the token counts, the timings and the tool targets all
survive with content switched off.

| level | what is written |
|---|---|
| `none` | nothing. The default. Everything else is untouched |
| `metadata` | `{"redacted":true,"chars":86,"sha256":"a3d44d6b…"}` |
| `full` | the content, after your `redact` hook and `maxLength` |

The default is **`none`**. Turn it on per process with
`init({ content: { capture: 'full' } })`, or per run with `withContent`, and
prefer `metadata` where you only need to tell two runs apart.

## Outside Airlock

The SDK works the same anywhere. Without `OCTIC_SPOOL_DIR` it writes to
`/var/spool/octic`, then a per-user directory, and something else has to
deliver what it writes. To send over OTLP/HTTP instead, and spool only what
could not be delivered:

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
