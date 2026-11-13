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

## Airlock runs: receipts, sealed input and data fetch

None of these need `init()`, and none of them throw or reject.

### Receipts (data-blind runs)

In a data-blind run an agent can state facts about its own run. Each receipt is
checked against the vocabulary in
[RECEIPTS.md](https://github.com/OcticHQ/telemetry/blob/main/contract/RECEIPTS.md)
and written to the spool directory in the call.

```ts
import { recordReceipt } from '@octichq/airlock-sdk';

const ok = recordReceipt('input.read', { 'airlock.bytes': 1024 }); // false if refused
```

`recordReceipt` returns `false` for a type or attribute off the vocabulary, a
missing required attribute, a bad value, an unwritable spool, or a 257th receipt.

### Sealed input (data-blind and data-fetch runs)

```ts
import { sealedInput } from '@octichq/airlock-sdk';

const blob = await sealedInput(); // Uint8Array, or null
```

`sealedInput()` returns the run's sealed input from the gate when
`AIRLOCK_RUN_MODE` is `data_blind` or `data_fetch`, and `null` otherwise.

### Data fetch (data-fetch runs)

In a data-fetch run the agent opens its sealed parameters, hands the FIU's
credentials to the gate, and reads back what the gate fetched.

```ts
import { fetchData, sealedInput } from '@octichq/airlock-sdk';

// The sealed input is sealed to your agent's key; opening it is your code.
// The field names here follow Airlock's test contract. The FIU and your agent
// agree the real layout.
const params = openSealedParameters(await sealedInput());
const result = await fetchData({
  credentials: params.aa_credentials, // passed through unchanged
  consentId: params.consent_id,
  fiDataRange: params.fi_data_range, // { from, to }, RFC 3339
});
if (result.ok) {
  for (const [name, bytes] of result.entries) handle(name, bytes);
} else {
  console.error(`fetch refused: ${result.reason}`);
}
```

`fetchData` sends the request to the gate and waits up to 330 seconds for the
exchange, then reads each entry the gate names, waiting up to 30 seconds for
each. Both limits are how long it waits without hearing from the gate. It keeps no reference to the
credentials once the request is written, zeroes the request buffer after
sending it, and writes no warnings; the result is the report. A refusal from
the gate passes its token through as `reason` (for example `malformed`,
`already_fetched`, or the exchange's own refusal token). The SDK's own reasons:

| `reason` | When |
|---|---|
| `not_data_fetch` | `AIRLOCK_RUN_MODE` is not `data_fetch`; the gate is not contacted |
| `no_gate` | `AIRLOCK_GATE_SOCKET` is unset or empty |
| `malformed` | the request cannot be serialized as JSON, is over 64 KiB, or the range lacks `from` or `to` (the gate is not contacted); also the gate's own token for a request it rejects |
| `unsupported` | the gate does not offer a data fetch (an older orchestrator, or another run mode) |
| `gate_unreachable` | the request fails to connect, errors, or times out |
| `gate_error` | an internal gate error, an unexpected status, or a refusal that is not a token |
| `read_failed` | the gate's answer is not a list of names, or reading an entry fails |

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
