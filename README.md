# octic-telemetry

Agent telemetry SDKs for [Octic](https://octic.ai). One repository, one
attribute contract, one independently versioned SDK per language.

> **Pre-release.** The Node SDK is being finished in a proof of concept and
> lands here shortly. Nothing is published yet.

## What these SDKs are for

They **ship no instrumentation**. Bring whatever you already run — the official
OpenAI instrumentation, OpenLLMetry, the Vercel AI SDK's built-in telemetry, or
stock OpenTelemetry — and these packages add the layer above it: the layer that
knows *these five model calls were one agent doing one job, for that customer,
from that prompt template.*

That layer is the part interception cannot produce. Watching the network call
to a model tells you the model, the tokens and the latency. It cannot know
where a run began, which end user it was for, which prompt version produced the
output, or which governed asset the agent is — and none of it can be added to
the data afterwards.

## SDKs

| SDK | Package | Tag | Status |
|---|---|---|---|
| [Node](node) | `@octic/telemetry` (npm) | `node/vX.Y.Z` | scaffolded — SDK landing |
| Python | `octic-telemetry` (PyPI) | `python/vX.Y.Z` | planned |
| Go | `github.com/OcticHQ/octic-telemetry/go` | `go/vX.Y.Z` | planned |

Every SDK versions independently. `node` at `2.x` while `python` is at `0.1.0`
is normal and expected — there is no repo-wide version, and there is no root
changelog. Each component's `CHANGELOG.md` records its own version stream and
nothing else, which is what a consumer choosing between two releases wants to
read.

## The contract

[`contract/`](contract) is the reason these live in one repository.
`attributes.yaml` is the single source of truth for every attribute the SDKs
write and the ingest path reads; it generates each language's constants and the
published spec, and CI fails if any of them drift.

- [**`contract/ATTRIBUTES.md`**](contract/ATTRIBUTES.md) — the spec. Every key,
  its type, whether it is required, and which side owns it.
- The `octic.` namespace is reserved. Customer-supplied attributes are forced
  under `octic.custom.` so a tenant value can never overwrite a governance one.

## Documentation

| | |
|---|---|
| [docs/concepts.md](docs/concepts.md) | identity, runs, conversations, agents — the model, in no language |
| [docs/content-policy.md](docs/content-policy.md) | what leaves your process, and how to switch it off |
| [docs/wire-format.md](docs/wire-format.md) | OTLP endpoints, authentication, what we accept |
| [contract/ATTRIBUTES.md](contract/ATTRIBUTES.md) | the attribute spec |
| Each SDK's `README.md` | installation and usage for that language |

Internal decisions and in-flight work live in [`handbook/`](handbook).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the loop, and
[AGENTS.md](AGENTS.md) for the rules. The short version:

```bash
pre-commit install --install-hooks
pre-commit install --hook-type commit-msg

make install
make check
```

[Conventional Commits](https://www.conventionalcommits.org/) are enforced.
Which component releases is decided by the **files you touched**, not by the
commit scope.

## Licence

[Apache-2.0](LICENSE)
