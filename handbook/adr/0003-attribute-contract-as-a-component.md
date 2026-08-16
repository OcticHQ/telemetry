# 0003 — The attribute contract is a component, not a library

- **Status**: accepted
- **Date**: 2026-08-15
- **Deciders**: platform maintainers

## Context and problem

Every SDK writes the same attributes, reads the same foreign ones, and refuses
the same denied ones. be-ingest and be-worker read what the SDKs write. Five
independent implementations of one list is five chances to disagree, and a
disagreement does not fail anywhere — it produces a customer whose Python
agents and Node agents cannot be queried the same way.

The obvious answer is a shared library. It does not work here: a *public* SDK
cannot depend on `@octichq/contracts`, which lives on GitHub Packages and needs
a PAT to install ([ADR 0004](0004-public-npm-and-the-octic-scope.md)). And a
TypeScript file cannot be the specification for a Python port regardless.

## Decision

**`contract/attributes.yaml` is the source of truth. It is read at build time
only, and it generates per-language constants plus the published spec.**

```
attributes.yaml ──generate──┬─► node/src/attributes.gen.ts
                            ├─► (later) python/…/attributes_gen.py
                            └─► ATTRIBUTES.md          the public spec
```

### Generated, never translated

Adding a language means adding an emitter and a `LANGUAGES` entry in
`contract/generate.ts`. Hand-copying the constants into a new file is the exact
failure this prevents, so the generator also enforces the negative: a list of
hand-written sources that **must not restate** any key the contract owns. A
literal match is an error naming the file and the string.

That check is the leak-shaped one. The keys classified as content drive
redaction; `content.ts` deciding a key is not content when the contract says it
is means customer prompts leave a process that was configured not to send them.

### Generated artifacts are committed

`node/src/attributes.gen.ts` is in git. Building any SDK therefore never
requires running another language's toolchain — a Go contributor never installs
Node. CI verifies with `--check` and never writes, so the merged commit equals
the reviewed commit; the pre-commit hook does the writing.

### It is a release component

`contract/vX.Y.Z`, `release-type: simple`, its own `CHANGELOG.md`. be-ingest
and be-worker cite the contract revision they implement, independently of any
SDK's version. `ATTRIBUTES.md` is the published document those services read
instead of importing a package they cannot reach.

### Three populations, frozen in three senses

- **`emitted`** — what our SDKs write. Freezing these is an API promise:
  customer queries and our graph writes key off them, so a rename is a major
  version with dual-write. This half is also the port spec.
- **`consumed`** — what foreign instrumentation writes. We cannot freeze what
  we do not own. What is frozen is the *reader*: canonical name, accepted
  aliases, normalisation. An upstream rename is an additive alias, never a
  break.
- **`denied`** — what we refuse to carry. Frozen here is the policy, not the
  list; the list grows as vendors ship new detectors.

### Two numbers that are not the same thing

`schema_version` in the YAML is the wire schema, and rides on every span as
`octic.schema.version`; it moves only when a removal or type change breaks a
reader. `version.txt` is the release version of the document, and moves on
every releasable change including additive ones.

## Consequences

- **Positive**: cross-language divergence is a red build rather than a support
  ticket.
- **Positive**: the semconv constants are verified against the pinned package
  at generate time — value and name, not just that the symbol exists — so an
  upstream rename surfaces here rather than in a customer's trace.
- **Negative**: the generator is a Node program, so a Python-only contributor
  needs Node to change the contract. Accepted: one generator with N emitters
  beats N generators drifting.
- **Negative**: the semconv range is pinned in two manifests (`contract/` and
  `node/`) and must track. A mismatch fails the generator, which is the right
  direction.
- **Neutral**: `contract/package.json` is a private toolchain manifest whose
  version means nothing. Named `@octic/telemetry-contract-tools` so it cannot
  be mistaken for something publishable.

## Alternatives considered

- **Share `@octichq/contracts`** — already exists and already serves be-api and
  be-worker. Rejected: GitHub Packages needs a PAT even for public packages, so
  no external consumer could install the SDK.
- **Publish the contract as its own public npm package** and have the SDK
  depend on it. Rejected for now: it adds a registry dependency and a version
  matrix between two packages we always release together, to solve a problem
  the monorepo already solves. Reconsider if a customer wants the constants
  without the SDK.
- **Semconv YAML plus OTel Weaver** — the industry-standard toolchain for
  exactly this. Rejected at one language: it pays off at language two, and
  building it for one is speculative. Revisit when Python starts; the YAML here
  is deliberately shaped so the migration is mechanical.
- **A TypeScript file as the source of truth**, generating the rest. Rejected:
  it makes one language privileged, and a Python port written against a `.ts`
  file is a translation by hand with extra steps.
