# AGENTS.md

First read for anyone working in this repo, human or agent. The reasoning
behind everything here lives in [`handbook/adr/`](handbook/adr/) — this file is
the condensed rules.

## What this repo is

Agent-telemetry SDKs for Octic, one per language, plus the attribute contract
they all implement. **It is public.** External developers read this source,
file issues against it, and install what it publishes.

Two consequences that change how you work here versus the backend repos:

1. **A tag is not inert.** `node/v1.2.3` publishes to public npm, and an npm
   version is immutable — it cannot be unpublished after 72 hours, and the
   number can never be reused. Rolling forward to a new version is the only
   fix. This is why releases go through a Release PR.
2. **The attribute names are an API.** Customer queries and our graph writes
   key off them. Renaming one is a major version with dual-write, not a
   refactor. [ADR 0003](handbook/adr/0003-attribute-contract-as-a-component.md)

## Layout

```
contract/          the cross-language source of truth — start here
node/              the Node SDK        →  @octichq/airlock-sdk
docs/              language-neutral prose
handbook/          adr/ plans/ TODO.md — internal
scripts/           bash. change detection, commit lint, registration checks
```

A language is a **top-level directory**. `python/` and `go/` sit beside
`node/`; nothing moves to accommodate them.

Per component:

```
<language>/
├── README.md         the registry page — self-contained, absolute links
├── CHANGELOG.md      owned by release-please — do not hand-edit
├── package.json      (node) name, version, and the release manifest
├── src/              including the generated attributes file
└── test/
```

## The rules that matter

1. **No root package manager.** No `package.json`, no workspace, no
   `node_modules` at the repo root. Root tooling is bash, `make` and
   `pre-commit`. The moment a Python contributor's first command is `npm
   install`, the layout has failed.
   [ADR 0005](handbook/adr/0005-no-root-package-manager.md)

2. **The contract is generated, never translated.** Adding a language means
   adding an emitter to `contract/generate.ts`, not hand-copying constants into
   a new file. A hand-written source that restates a key the contract owns is a
   CI failure — import it instead.
   [ADR 0003](handbook/adr/0003-attribute-contract-as-a-component.md)

3. **Generated artifacts are committed, and CI never writes them.** The
   pre-commit hook regenerates; CI runs `--check` and fails if stale. That is
   what keeps the merged commit equal to the reviewed commit — and it means
   building any SDK never requires running another language's toolchain.

4. **Path routes the release, scope documents it.** release-please partitions
   by the files a commit touched. `feat(node):` that edits `contract/` releases
   `contract`. Write accurate scopes because they are what the changelog reads
   like; do not rely on them to control what releases. Keep a commit inside one
   component where you can.

5. **Versions are independent, and there is no root `CHANGELOG.md`.** A root
   one would interleave unrelated version streams into a document where
   consecutive entries describe different artifacts and the numbers go up and
   down. The aggregate view is GitHub Releases and `git log`.

6. **Never hand-edit a version.** `node/package.json`'s `version`,
   `contract/version.txt`, `node/src/version.ts` and every `CHANGELOG.md` are
   owned by release-please.

7. **`octic.` is reserved.** Customer-supplied attributes go under
   `octic.custom.`. This is structural, not stylistic: span-option attributes
   are applied at construction while the processor stamps in `onStart`, so
   without the split a tenant key could overwrite `octic.run.id`.

8. **The SDKs ship no instrumentation.** Documenting a two-line
   `registerInstrumentations(...)` snippet costs a paragraph; shipping HTTP
   instrumentation costs a dependency, a version matrix, double-registration
   bugs, and a slope toward maintaining framework instrumentation for five
   frameworks.

## Tags and releases

`<component>/vX.Y.Z` — `node/v1.2.0`, `contract/v1.4.0`, later `go/v1.2.3`.
Slash-separated, which is also exactly what Go's multi-module support requires,
so the Go SDK needs no adaptation.

Merging a pull request releases nothing. release-please opens a **Release PR**
per component; merging *that* cuts the tag, writes the changelog, and triggers
the publish. [ADR 0002](handbook/adr/0002-per-sdk-versioning.md)

Pre-1.0: `feat` bumps the minor, `fix` bumps the patch, and a breaking change
bumps the minor rather than reaching 1.0 by accident.

## Commands

```bash
make check              # what CI runs
make contract-generate  # after editing contract/attributes.yaml
make node-test
```

Full list: `make help`. Per-component commands live in that component's
manifest and are the canonical form; the Makefile is a facade.

## Where documentation goes

- **A decision** — `handbook/adr/`. Append-only, one screen, indexed in
  `handbook/adr/README.md`.
- **In-flight work** — `handbook/plans/`, written before the work starts.
- **A loose end** — `handbook/TODO.md`.
- **How to use an SDK** — that SDK's `README.md`. It is the registry page, so
  it must stand alone: absolute links, no `../docs/`.
- **Anything language-neutral a user reads** — `docs/`.

If you are writing prose anywhere else, it probably belongs in one of those.
