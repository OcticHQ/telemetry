# Contributing

How to work in this repo. The *rules* — layout, the contract, what counts as
breaking — are in [`AGENTS.md`](AGENTS.md) and the [handbook](handbook/); this
is the practical loop.

Read [`AGENTS.md`](AGENTS.md) first if you have not. Nothing below repeats it
except where you would otherwise get it wrong.

## Prerequisites

| Tool | Why | Install |
|---|---|---|
| `pre-commit` | runs the hooks below | `pipx install pre-commit` |
| `jq` | the helper scripts | `brew install jq` / `apt install jq` |
| Node 24 | the Node SDK and the contract generator | `nvm use` (see `.nvmrc`) |
| `make` | the command facade — optional | already installed |

You only need a language's toolchain if you are touching that language. Working
on the Python SDK will not require Node — except when you change the contract,
because its generator is a Node program. That is the one crossing, and it is
deliberate: one generator with an emitter per language beats one generator per
language drifting apart.

### First-time setup

```bash
pre-commit install --install-hooks
pre-commit install --hook-type commit-msg
```

Both lines are needed — the second installs the commit-message check, which
`pre-commit install` alone does not.

This is `pre-commit` rather than husky. A Node hook runner at the repo root
would put `npm install` in front of every contributor regardless of language,
which is exactly what the layout exists to avoid.

## The development loop

```bash
make install     # every component's dependencies
make check       # what CI runs
```

Or work inside one component, which is faster and is what you will actually do:

```bash
cd node
npm ci
npm run test       # node --test, no key, no network, ~1s
npm run typecheck  # the tests are type-stripped at runtime and check nothing
npm run lint
```

`npm run typecheck` is not optional discipline. The tests are `.ts` executed by
Node's type stripping, so a test can assert against a field that does not exist
and stay green forever. `tsc` is the only thing that notices.

Before opening a pull request that changes the published surface:

```bash
npm run pack:check   # publint + attw against the real tarball
npm publish --dry-run
```

These read the built package the way npm, Node and bundlers will. They are
cheap, and they catch the class of defect you cannot fix afterwards, because
the version is already permanent.

## Changing the contract

`contract/attributes.yaml` is the source of truth. Editing it is the only edit
in this repo that reaches every SDK and both backend services at once.

```bash
cd contract
npm ci
npm run generate    # writes node/src/attributes.gen.ts and ATTRIBUTES.md
npm run check       # what CI runs
```

The pre-commit hook regenerates for you: edit the YAML, commit, and the hook
rewrites the artifacts and stops the commit with "files were modified by this
hook" — `git add` them and commit again. The generated files land in the same
commit as the change that caused them, which is what keeps CI green.

**Never hand-edit `node/src/attributes.gen.ts` or `contract/ATTRIBUTES.md`.**
Never restate a contract-owned key as a literal in hand-written source either —
`npm run check` fails the build for it, listing the file and the string. Import
it instead. That check exists because the leak-shaped failure is `content.ts`
deciding a key is not content when the contract says it is.

Adding an attribute is additive and cheap. Renaming or removing one is a
breaking change to every consumer's saved queries, and needs a major version
with dual-write.

## Adding a language

1. Create the top-level directory — `python/`, `go/`. Not `packages/python`:
   the directory name becomes the git tag prefix and, for Go, part of the
   import path.
2. Register it in **both** `release-please-config.json` and
   `.release-please-manifest.json`, seeded at `0.0.0`. This is the step people
   forget and the failure is silent — an unregistered component is never
   released and nothing says so. `./scripts/check-component-registration.sh`
   catches it, and both a hook and CI run that.
3. Add an emitter and a `LANGUAGES` entry in `contract/generate.ts`, and commit
   the generated constants.
4. Add `.github/workflows/_<language>.yml` and one `if:` line in each of
   `pr.yml` and `ci.yml`. Nothing else in either file changes.
5. Add a `dependabot.yml` entry and Makefile targets.
6. Write the component `README.md` as a registry page: self-contained,
   absolute links.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/), same as every
other Octic repo:

```
feat(node): add withSession()
fix(node): flush the log processor before exit
feat(contract)!: rename octic.entity.input to octic.run.input
docs: describe the content policy levels
```

**Scope does not route the release — the files you touched do.** A commit
editing `contract/` releases `contract` no matter what the scope says. Write
accurate scopes anyway, because they are what the changelog reads like, but do
not rely on them to control what releases.

**Keep a commit inside one component where you can.** A commit touching two
correctly releases both, which is right, but means a `node` release carrying a
`contract` changelog entry.

```bash
./scripts/check-commits.sh "$(git merge-base origin/main HEAD)"
```

runs the same check CI does. A commit release-please cannot parse is skipped
silently — a `fix` typed as `fixed` ships nothing and warns nobody, which is
why this is a CI gate and not just a hook.

### Breaking changes

Wider than a changed function signature. It is a breaking change if you:

- remove or rename a function, option, or exported type;
- rename or remove an attribute the contract marks `emitted`, because customer
  queries and our graph writes key off the name;
- narrow an accepted value, or change what an existing attribute means;
- change the default content policy in the direction of sending *more*.

Additive is not breaking: a new attribute, a new alias for a `consumed` field,
a new optional option.

## Opening a pull request

CI runs on every pull request: the contract gate (always, repo-wide), then per
changed component — lint, format, typecheck, tests, and a pack check that lints
the real tarball — plus the commit and registration checks. Results land in a
sticky comment that updates on every push.

Only *changed* components are checked on a pull request. Pushes to `main` check
everything, because that is the last gate before a version can exist.

### Review checklist

- New behaviour has a test.
- Contract artifacts regenerated and committed if `attributes.yaml` moved.
- No contract-owned key restated as a literal.
- The component's `README.md` reflects any public surface change, and its links
  are absolute.
- Breaking changes are marked `!` and say what a consumer must do.
- No version or `CHANGELOG.md` edited by hand.

The commit types deserve a specific look. They decide the version, and the
Release PR that follows is a summary, not a second review of the code.

## How a release happens

**Merging your pull request releases nothing.**

1. Your pull request merges to `main`.
2. `ci.yml` re-checks everything, then runs release-please, which opens (or
   updates) a **Release PR** per component with releasable commits —
   `chore(main): release node 0.2.0`. It contains the version bumps and the
   changelog, and nothing else.
3. Merging that Release PR cuts `node/v0.2.0`, publishes a GitHub Release, and
   triggers the npm publish.

Components with only `chore`/`docs`/`style` commits release nothing at all.

That second merge is the point, and it is where this repo diverges from the
rest of the org. An npm version is immutable and cannot be unpublished after 72
hours, so the Release PR is the one human review standing between a merged
commit and a permanent public artifact. Read it as such: the version number,
the changelog, and whether a breaking change is actually marked as one.

## Where documentation goes

- **A decision** — `handbook/adr/`. Append-only, MADR format, one screen. Copy
  `handbook/adr/0000-template.md` and add a row to `handbook/adr/README.md`.
- **In-flight work** — `handbook/plans/`, written before the work starts.
- **A loose end** — `handbook/TODO.md`.
- **How to use an SDK** — that SDK's `README.md`.
- **Anything language-neutral a user reads** — `docs/`.

If you are writing prose anywhere else — a long comment, a thread you would
link to — it probably belongs in one of those.
