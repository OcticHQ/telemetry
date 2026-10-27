# Content policy

Prompts, tool arguments and model output are **your data**, not telemetry about
it. This page says exactly what leaves your process and how to change it.

## The three levels

| level | what leaves your process |
|---|---|
| `full` | the content, after your redact hook and the length cap |
| `metadata` | `{"redacted":true,"chars":86,"sha256":"a3d44d6b…"}` — enough to tell whether two runs used the same prompt, without the prompt |
| `none` | nothing |

**Every governance attribute is identical at all three levels.** The agent, the
run id, the conversation, the prompt *name* and version, the token counts, the
latencies and the asset references all survive with content switched off. The
product answers the same questions at `none` as at `full`; you lose the ability
to read what was said, and nothing else.

## Setting it

Per process:

```ts
init({ /* … */, content: { capture: 'none' } });
```

```python
init(..., content=ContentOptions(capture="full"))   # Python defaults to none
```

Per run, on the same Context mechanism as identity — so the override reaches
foreign spans too:

```ts
withContent({ capture: 'metadata' }, () => /* … */);
```

```python
with with_content("metadata"):
    ...
```

## The default is `none`

| SDK | default |
|---|---|
| Node | `none` |
| Python | `none` |

Both SDKs write to a spool directory by default, so what they capture sits on
the host's own disk at rest until a reader collects it. Defaulting to `full`
would put a consumer's prompts on their disk as a consequence of installing a
package. Opt in when you want the text.

Each SDK pins its own default with a test, so neither can change by accident.

## Where it is enforced

Not in one place, because content arrives on **two signals** and
instrumentation libraries disagree about which:

- **Spans** — a redacting wrapper around the span exporter.
- **Log records** — a redacting processor ahead of the exporting one. This is
  not an edge case: the official OpenAI instrumentation puts *all* content on
  the logs signal.

An SDK that does not carry the logs signal enforces only the first, and the
second arrives with the signal. The Python SDK is traces-only today. The Node
SDK carries both when it exports over HTTP, and traces only when it writes to
the spool alone, which is its default.

The span side is enforced at the **exporter** rather than in a `SpanProcessor`,
for two reasons that are worth knowing if you are reading the source: a
`ReadableSpan` is declared readonly and its instance is shared with every other
processor in the pipeline, and the exporter is the only surface still ours when
a host SDK owns the provider.

The chosen level is recorded off-span, so a caller cannot forge a weaker policy
by writing the policy attribute into their own span options. An unrecognised
value **fails closed**.

## What else the exporter drops

Resource detectors ship attributes nobody asked for. `process.command_args` is
the full argv — a well-known place for secrets — and it is dropped along with
a denylist of similar attributes, at every content level including `full`.

## The classification is not a hand-maintained list

Which attribute keys count as content is derived from the
[attribute contract](../contract/ATTRIBUTES.md): every attribute carrying
`class: content`. Each SDK's redaction list and the published spec are generated
from the same source and cannot disagree, and CI fails if a hand-written source
restates one of those keys as a literal.

That check exists for exactly one failure: code deciding a key is not content
when the contract says it is. That is a leak, and it is silent.

At `none` and `metadata`, enforcement is also checked **by shape, not only by
key** — a length bound on values authored by foreign instrumentation — so a
content-bearing key we have never seen still does not escape.
