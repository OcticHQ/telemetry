# 0005 — No package manager at the repository root

- **Status**: accepted
- **Date**: 2026-08-15
- **Deciders**: platform maintainers

## Context and problem

Node is the first language here, and the JavaScript ecosystem's answer to a
monorepo is a root `package.json` with workspaces — hoisted dependencies, root
scripts, `husky` for hooks, maybe Turborepo for task orchestration. It is
genuinely convenient while every component is JavaScript.

It is also a trap the moment the second language arrives. A root workspace
makes `npm install` the first command every contributor runs, including the
one who came to fix a bug in the Go SDK. Root scripts written in JavaScript
become the only way to invoke anything, so a Python contributor debugging CI is
reading a Node script. None of that is visible as a cost while there is only
one language — it shows up as a migration later, which is precisely the class
of decision [ADR 0001](0001-one-repo-many-language-sdks.md) exists to avoid.

## Decision

**No `package.json`, no workspace, no `node_modules` at the repository root.**

Root-level tooling is chosen for being language-neutral:

| Concern | Tool | Why |
|---|---|---|
| helper scripts | **bash** + `jq` | present everywhere, no install step |
| command facade | **`make`** | `make node-test`, `make contract-check` |
| git hooks | **`pre-commit`** | self-installing, pinned hook environments |
| release | **release-please** (a GitHub Action) | nothing to install locally |
| formatting | **prettier**, via the pre-commit hook | brings its own environment |

Each component owns its manifest, its lockfile, its toolchain and its test
runner. `contract/` has a `package.json` because its generator is a Node
program — it is a *component* with a toolchain, not a root dependency, and it
is private and unpublishable.

`make` is a facade and nothing more. There is no dependency graph in the
Makefile, no caching, and no task orchestration; every target shells out to the
component's own commands, which stay canonical. That keeps `cd node && npm
test` working exactly as a Node developer expects.

### `pre-commit` rather than `husky`

Same reasoning `terraform-aws-modules` gives: hooks that shell out to
per-language tools have nothing to gain from a Node hook runner, and
`pre-commit`'s pinned, self-installing hook environments are what the
polyglot-tooling ecosystem standardised on. Choosing husky would reintroduce
the root `package.json` through the back door.

## Consequences

- **Positive**: a contributor installs exactly the toolchain for the component
  they are touching.
- **Positive**: adding Python or Go changes no root file except
  `release-please-config.json`, the manifest, `dependabot.yml` and a few
  Makefile targets.
- **Positive**: no hoisting, so each SDK is built against the dependency tree a
  real consumer has — the PoC measured duplicate `import-in-the-middle` copies
  silently breaking instrumentation patching, which a shared hoisted tree would
  have hidden.
- **Negative**: no cross-component task caching or affected-graph running. At
  this size the cost is seconds; revisit if it stops being.
- **Negative**: `make` is another thing to have installed, and it is awkward on
  Windows. It is optional — every target is one line you can run by hand.
- **Negative**: dependency updates are per component, so a shared devDependency
  can sit at two versions. Grouped Dependabot entries keep it visible.
- **Neutral**: contributors who expect a workspace will look for one. Both
  `AGENTS.md` and `CONTRIBUTING.md` say the absence is deliberate.

## Alternatives considered

- **npm workspaces at the root** — the ecosystem default, hoisting and one
  `npm ci`. Rejected: it puts npm in front of every contributor regardless of
  language, and hoisting hides the dependency-duplication failures this SDK
  exists to survive.
- **Turborepo or Nx** — real task graphs and caching. Rejected: heavier, JS-first,
  and solving a build-time problem we do not have at two components.
- **A `justfile` instead of a Makefile** — nicer syntax, no tab pitfalls.
  Rejected only because `make` is already installed everywhere and this is a
  facade over five commands. Not a decision worth defending if someone prefers
  `just`.
- **No facade at all**, documenting the raw commands. Rejected: the raw commands
  differ per language, and the first thing a newcomer needs is one entry point
  that runs what CI runs.
