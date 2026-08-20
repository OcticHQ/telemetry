# contract/

The Octic agent-telemetry attribute contract. **This is the reason the SDKs
share a repository.**

| File | What it is |
|---|---|
| [`attributes.yaml`](attributes.yaml) | the source of truth — hand-edited |
| [`generate.ts`](generate.ts) | the emitters, one per language |
| [`ATTRIBUTES.md`](ATTRIBUTES.md) | **generated** — the published, language-neutral spec |
| `version.txt` | **generated** — owned by release-please, tagged `contract/vX.Y.Z` |
| [`CHANGELOG.md`](CHANGELOG.md) | **generated** — owned by release-please |

```
attributes.yaml ──generate──┬─► node/src/attributes.gen.ts          the Node SDK
                            ├─► python/…/attributes_gen.py          the Python constants
                            └─► ATTRIBUTES.md                       the public spec
```

## Working on it

```bash
cd contract
npm ci
npm run generate      # write the artifacts
npm run check         # fail if they are stale, or if a hand-written list drifted
```

`npm run check` is what CI runs, repo-wide, on every pull request — it is the
one gate that crosses language boundaries. Change `attributes.yaml` without
committing the regenerated constants for **every** language and the build fails.
That is what stops a second SDK quietly disagreeing with the first.

Generated files are written by the pre-commit hook, so they land in the same
commit as the change that caused them. CI only verifies; it never writes.

## Two things that look like versions and are not the same thing

- **`schema_version`** inside `attributes.yaml` is the wire-level schema, and it
  appears on every span as `octic.schema.version`. It moves only when a removal
  or a type change breaks a reader.
- **`version.txt`** is the release version of this document, `contract/vX.Y.Z`,
  so be-ingest and be-worker can cite the contract revision they implement. It
  moves on every releasable change, including additive ones.

`package.json` here is the generator's own toolchain. It is private, its version
is meaningless, and nothing in this directory is published to npm.

## Three populations, frozen in three different senses

Restated from the YAML's own header, because it is the thing most often got
wrong:

- **`stability: emitted`** — attributes our SDKs write. Freezing these is an API
  promise: a rename is a major version with dual-write, because customer queries
  and our graph writes key off them. This half is also the port spec for a new
  language.
- **`stability: consumed`** — attributes foreign instrumentation writes. We
  cannot freeze what we do not own. What is frozen is the *reader*: the
  canonical field name, the aliases we accept, and the normalisation. Upstream
  renaming something is an additive alias, never a break.
- **`stability: denied`** — attributes we refuse to carry. Frozen here is the
  policy, not the key list; the list grows as vendors ship new detectors.

## Adding a language

Add an entry to the `LANGUAGES` table at the bottom of `generate.ts` and write
its emitter. Never hand-translate the constants — that is precisely the drift
this file exists to prevent, and the `handWritten` list is the check that
catches it when someone does.

See [handbook/adr/0003-attribute-contract-as-a-component.md](../handbook/adr/0003-attribute-contract-as-a-component.md).
