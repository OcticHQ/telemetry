# 0002 — Independent per-SDK versioning via release-please and component-prefixed tags

- **Status**: accepted
- **Date**: 2026-08-15
- **Deciders**: platform maintainers

## Context and problem

This repo produces N artifacts on independent version lines, in different
languages, published to different registries. A fix to `node` must not bump
`python`, and the contract has its own version line so be-ingest can cite the
revision it implements.

The org already solved the N-artifact problem once, in `terraform-aws-modules`:
per-module semantic-release driven by a bash loop, `--tag-format
"<module>/v${version}"`, per-module changelogs, no release pull request. Its
[ADR 0002] considered release-please in manifest mode and **rejected** it, then
the repo removed it (`7458ee3`, 2026-08-10). Copying the org is normally the
right instinct, so the burden here is to say precisely why we do not.

## Decision

**release-please in manifest mode, tagging `<component>/vX.Y.Z`.**

```json
{
  "separator": "/",
  "include-component-in-tag": true,
  "bump-minor-pre-major": true,
  "separate-pull-requests": true,
  "packages": {
    "node":     { "release-type": "node",   "component": "node",
                  "package-name": "@octic/telemetry",
                  "extra-files": ["src/version.ts"] },
    "contract": { "release-type": "simple", "component": "contract" }
  }
}
```

### Why not semantic-release, as the rest of the org does

`terraform-aws-modules` gave three reasons for rejecting release-please. Two
apply to us unchanged, and we accept them. The third is the load-bearing one
and it inverts:

> *"a gate whose value is limited here — a module tag is inert, since nothing
> deploys when it is cut and consumers pin deliberately."*

A tag here is not inert. `node/v1.2.3` publishes to public npm. **An npm
version is immutable**: it cannot be unpublished after 72 hours, the number can
never be reused, and the only remedy for a mistake is rolling forward in
public. Under the org's model, nothing human stands between merging a pull
request and that artifact existing. The Release PR is that seat, and it is
worth the second merge.

Two further reasons are specific to this repo:

**A 0.x phase.** semantic-release has no pre-major mode — a component's first
release is `1.0.0`. `terraform-aws-modules` accepted that deliberately, because
a module exists to be pinned. We are the opposite case: the SDK has planned
breaking changes ahead of it (the content default flipping to `none`, batching,
the protobuf path). Promising a stable major before any of that has happened
would be a promise we already know we will break.

**Multi-language.** `semantic-release-monorepo` identifies a component by a
`package.json`. A Python or Go SDK would need a decoy npm manifest with no
other reason to exist, and the tool still could not write the version into
`pyproject.toml` or a Go version file — that would stay manual, which is where
drift lives. release-please has first-class `node`, `python`, `go` and `simple`
strategies.

### Tag format: `<component>/vX.Y.Z`

`node/v1.2.0`, `contract/v1.4.0`. Slash-separated — the same namespace
`terraform-aws-modules` uses, so the org reads one shape everywhere, and
**exactly what Go's multi-module support requires**, so `go/` will need no
adaptation.

This matters more than the tool choice. Both release-please and
semantic-release read tags as their state, so a repo tagged this way can switch
between them — as `terraform-aws-modules` demonstrated, in three days. The tag
format is the durable decision; the tool is swappable, and we should revisit it
at 1.0.

### Partition by path, not by commit scope

release-please routes a commit to a component by the files it touched. A commit
scoped `feat(node):` that edits `contract/` releases `contract`. Scopes are
expected — they are what makes a changelog readable — but they are
documentation, not routing.

### The version must reach the wire

`extra-files: ["src/version.ts"]` stamps the SDK version into a source constant
in the same commit as the `package.json` bump. The PoC hardcoded `0.0.0`, so
every span it produced claimed SDK version `0.0.0`. Telemetry about telemetry
that cannot tell two releases apart is worse than none, and a unit test asserts
the two stay equal.

### Changelogs are per component. There is no root CHANGELOG.md.

`node/CHANGELOG.md` records the `node` stream and nothing else, which is what a
consumer choosing between two versions wants. A root file would interleave
unrelated streams into a document where consecutive entries describe different
artifacts and the numbers go up and down — actively misleading, not merely
redundant. The aggregate view is GitHub Releases and `git log`.

## Consequences

- **Positive**: one human review between a merged commit and a permanent public
  artifact.
- **Positive**: a real 0.x phase, so pre-1.0 breakage costs a minor bump and
  says so.
- **Positive**: adding Python or Go is a config entry, not a new release model.
- **Negative**: two merges per release, and a model that differs from every
  other Octic repo. Contributors have to be told; `CONTRIBUTING.md` says it
  twice.
- **Negative**: a Release PR can sit unmerged, so "merged to main" and
  "released" drift apart. Visible, at least — the open PR *is* the backlog.
- **Neutral**: release-please needs the same org GitHub App token
  (`SEMANTIC_RELEASE_*`) that semantic-release needs, to push past the branch
  ruleset.

## Alternatives considered

- **semantic-release + `semantic-release-monorepo`**, as `terraform-aws-modules`
  does — one merge, byte-identical to the org. Rejected for the three reasons
  above: no publish gate, no 0.x, and a decoy `package.json` per non-JS
  language. Also unmaintained since early 2024 and already flagged as such in
  that repo's own `handbook/TODO.md`.
- **One shared version across all SDKs**, bumped together. Rejected: a Python
  release note that says "no changes in this language" every time Node ships,
  and a customer who cannot tell whether an upgrade affects them.
- **Manual tagging.** Rejected for the reason every repo here rejects it: the
  step that gets skipped is the changelog, and the changelog is the only
  artifact a consumer reads before upgrading.

[ADR 0002]: https://github.com/OcticHQ/terraform-aws-modules/blob/main/handbook/adr/0002-per-module-versioning.md
