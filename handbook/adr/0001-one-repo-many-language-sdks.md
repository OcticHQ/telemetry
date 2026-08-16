# 0001 — One repository, many language SDKs

- **Status**: accepted
- **Date**: 2026-08-15
- **Deciders**: platform maintainers

## Context and problem

Octic will ship an agent-telemetry SDK in more than one language. Node is
first; Python is explicitly planned and deferred until demand appears; Go
follows the sensor.

The default at Octic is one repository per artifact — `be-api`, `be-worker`,
`be-ingest` and `contracts` are each their own repo with their own pipeline.
Applying that default here gives `octic-telemetry-node`,
`octic-telemetry-python`, `octic-telemetry-go`.

The problem is that these artifacts are not independent in the way those
services are. They implement **the same specification**: the same attribute
names, the same three-level content policy, the same reserved namespace, the
same rule about which foreign attributes we read and which we refuse. Two SDKs
disagreeing about an attribute name is not a bug in either one — it is a
product that reports different things depending on which language the customer
wrote their agent in, and nothing in either repository would notice.

## Decision

**One repository, one directory per language at the top level, one shared
contract, independent versions.**

```
contract/     attributes.yaml + generator + the published spec
node/         @octic/telemetry
python/       (later)
go/           (later)
```

### The contract is the reason

`contract/attributes.yaml` generates each language's constants and the public
spec. It is checked in CI on every pull request, repo-wide, whether or not any
SDK changed. Change the spec without regenerating every language and the build
fails.

That check is only possible because the languages share a working tree. Across
repositories the equivalent is a published package that each SDK depends on,
which for a *public* SDK means publishing it to three registries and accepting
that a consumer's lockfile can pin a stale one. The failure mode moves from
"CI is red" to "two customers see different attribute names."

### Language directories are top-level

Not `packages/<language>` and not `sdk/<language>`. The directory name becomes
the git tag prefix (`node/v1.2.3`) and, for Go, part of the import path — Go's
multi-module support requires the tag to be `<subdir>/vX.Y.Z`, so
`github.com/OcticHQ/octic-telemetry/go` with tag `go/v1.2.3` is the shortest
form that works. A `packages/` segment would sit in every Go consumer's import
line forever, for the benefit of a convention from a different ecosystem.

### Versions stay independent

There is no repo-wide version and no root changelog. `node` at `2.x` while
`python` starts at `0.1.0` is the expected state.
[ADR 0002](0002-per-sdk-versioning.md)

## Consequences

- **Positive**: the contract cannot silently diverge between languages. This is
  the entire point.
- **Positive**: one issue tracker, one CONTRIBUTING, one place a developer
  looks for "does Octic have an SDK for X".
- **Positive**: a cross-language change — a new attribute, a policy change —
  is one reviewable pull request instead of N coordinated ones.
- **Negative**: contributors clone code in languages they do not work in. Kept
  cheap by [ADR 0005](0005-no-root-package-manager.md): no root package
  manager, and a component's toolchain is installed only if you touch it.
- **Negative**: CI must partition by component or every push runs every
  language's suite. Handled by change detection feeding a per-language
  reusable workflow.
- **Neutral**: the repository is public, so the layout is part of the public
  face of the product.

## Alternatives considered

- **One repository per language SDK** — the org default, and it isolates
  release pipelines cleanly. Rejected: the contract would have to be published
  as a package to three registries to be shared, and a stale pin would produce
  silent cross-language divergence rather than a red build.
- **A monorepo with the contract published as `@octichq/contracts`** — reuses
  machinery we already have. Rejected: `@octichq/contracts` is on GitHub
  Packages, which requires a PAT to install even for public packages. A public
  SDK cannot depend on it. See [ADR 0004](0004-public-npm-and-the-octic-scope.md).
- **Keeping the SDK inside the `telemetry-poc` repo** — zero migration.
  Rejected: external consumers read the source and file issues, and neither
  should land in a repository full of throwaway harnesses. Renaming a published
  package later is a migration; doing it now is free.
