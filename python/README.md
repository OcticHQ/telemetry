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

## Airlock runs: agent key, sealed input, data fetch and receipts

None of these need `init()`, and none of them raise.

### Receipts (data-blind runs)

In a data-blind run an agent can state facts about its own run. Each receipt is
checked against the vocabulary in
[RECEIPTS.md](https://github.com/OcticHQ/telemetry/blob/main/contract/RECEIPTS.md)
and written to the spool directory in the call.

```python
from octichq_airlock_sdk import record_receipt

ok = record_receipt("input.read", {"airlock.bytes": 1024})  # False if refused
```

`record_receipt` returns `False` for a type or attribute off the vocabulary, a
missing required attribute, a bad value, an unwritable spool, or a 257th receipt.

### The order (data-blind and data-fetch runs)

The FIU seals the run's parameters to a key your agent makes at start, so a
data-blind or data-fetch agent begins the same way:

1. Make an X25519 key pair with your own HPKE library; Python's standard
   library has no X25519. The SDK neither makes nor holds the private key.
2. `attest_key(public_key)`. If it is refused, end the run with its `reason`.
3. `sealed_input()`, which waits until the FIU's parameters arrive.
4. Open them: HPKE base mode, X25519-HKDF-SHA256 / HKDF-SHA256 /
   ChaCha20Poly1305, no AAD, with the info
   `airlock.agent-params.v1|<AIRLOCK_RUN_ID>|<AIRLOCK_MANIFEST_DIGEST>`.

### Agent key

```python
import sys

from octichq_airlock_sdk import attest_key

attested = attest_key(public_key)  # the raw 32-byte X25519 public key
if not attested.ok:
    sys.exit(f"attestation refused: {attested.reason}")
# attested.key_id, attested.bundle, attested.attestation["mode"], ["token"]
```

`attest_key` sends only the public key. The gate quotes it and has Airlock list
it before answering, so it waits up to 60 seconds without hearing from the
gate. It logs nothing; the result is the report. `AttestResult` is a frozen
dataclass: `ok`, `key_id`, `bundle` and `attestation` (`None` or empty when
refused) and `reason` (`None` when `ok`). A refusal from the gate passes its
token through as `reason`. The reasons:

| `reason` | When |
|---|---|
| `not_sealed_run` | `AIRLOCK_RUN_MODE` is neither `data_blind` nor `data_fetch`; the gate is not contacted |
| `no_gate` | `AIRLOCK_GATE_SOCKET` is unset or empty |
| `malformed` | the key is not 32 bytes in a byte buffer (`bytes`, `bytearray` or a byte `memoryview`; the gate is not contacted); also the gate's token for a request it rejects, which does not use up the run's attestation |
| `already_attested` | another key is already attested on this run. Stop |
| `attest_failed` | the quote or the listing failed, and the run is halting |
| `unsupported` | the gate does not offer attestation (an older orchestrator, or another run mode) |
| `gate_unreachable` | the request fails to connect, errors, or times out |
| `gate_error` | an internal gate error, an unexpected status, or a refusal that is not a token |
| `read_failed` | the gate's answer is not a key id, a bundle and an attestation |

### Sealed input (data-blind and data-fetch runs)

```python
from octichq_airlock_sdk import sealed_input

blob = sealed_input()  # bytes, or None; waits for the parameters
```

When `AIRLOCK_RUN_MODE` is `data_blind` or `data_fetch`, `sealed_input()` waits
for the run's sealed input: it asks the gate every 2 seconds until the
parameters arrive, with no limit of its own, since Airlock's deadline stops
the run. A refused or reset connection, a timeout, or a gate error (5xx) is
retried, with a warning once per distinct problem. It returns `None` straight
away in any other mode, and, with a warning, without `AIRLOCK_GATE_SOCKET`, if
the socket does not exist, is not a socket or cannot be used on the first try,
or if the gate answers any status other than 200, 404 or a 5xx.

In an asyncio agent, `sealed_input` blocks the calling thread while it waits,
and `attest_key` for up to 60 seconds, so call them with
`await asyncio.to_thread(sealed_input)` and
`await asyncio.to_thread(attest_key, public_key)`.

### Data fetch (data-fetch runs)

In a data-fetch run the agent opens its sealed parameters, hands the FIU's
credentials to the gate, and reads back what the gate fetched.

```python
from octichq_airlock_sdk import fetch_data, sealed_input

# The sealed input is sealed to your agent's key; opening it is your code.
# The field names here follow Airlock's test contract. The FIU and your agent
# agree the real layout.
params = open_sealed_parameters(sealed_input())
result = fetch_data(
    credentials=params["aa_credentials"],  # passed through unchanged
    consent_id=params["consent_id"],
    fi_data_range=params["fi_data_range"],  # {"from", "to"}, RFC 3339
)
if result.ok:
    for name, data in result.entries.items():  # dict[str, bytes]
        handle(name, data)
else:
    print(f"fetch refused: {result.reason}")
```

`fetch_data` sends the request to the gate and waits up to 330 seconds without
hearing from it for the exchange, then reads each entry the gate names, waiting
up to 30 seconds without hearing from the gate for each. It logs nothing; the
result is the report. `FetchResult` is a frozen dataclass: `ok`, `entries`
(empty when refused) and `reason` (`None` when `ok`).

The SDK keeps no copy of the credentials once the request is written. It
zeroes the bytes it sent, but Python cannot wipe a `str` or `bytes`, so the
JSON text built along the way stays in memory until it is garbage-collected.
Your agent still holds its own copy, in the opened parameters: drop it once
`fetch_data` returns.

A refusal from the gate passes its token through as `reason`: for example
`malformed`, `already_fetched`, `not_ready` before the sealed parameters have
arrived, or the exchange's own refusal token. An agent that waits for
`sealed_input()` first never sees `not_ready`. The SDK's own reasons:

| `reason` | When |
|---|---|
| `not_data_fetch` | `AIRLOCK_RUN_MODE` is not `data_fetch`; the gate is not contacted |
| `no_gate` | `AIRLOCK_GATE_SOCKET` is unset or empty |
| `malformed` | the request cannot be serialized as JSON, is over 64 KiB, or the range lacks `from` or `to` (the gate is not contacted); also the gate's own token for a request it rejects |
| `unsupported` | the gate does not offer the fetch (an orchestrator without data-fetch runs) |
| `gate_unreachable` | the request fails to connect, errors, or times out |
| `gate_error` | an internal gate error, any other status, or a refusal that is not a token |
| `read_failed` | the gate's answer is not a list of names, or reading an entry fails |

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
