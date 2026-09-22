# Architectural Decision Records

MADR-style, one screen each, numbered and append-only. A decision that no
longer holds is **superseded**, never edited: flip its status to
`superseded-by-NNNN` and leave the body alone, so the reasoning that led there
survives alongside the reasoning that led away.

Copy [`0000-template.md`](0000-template.md) and add a row below.

| # | Decision | Status |
|---|---|---|
| [0001](0001-one-repo-many-language-sdks.md) | One repository, many language SDKs | accepted |
| [0002](0002-per-sdk-versioning.md) | Per-SDK versioning via release-please, tags `<component>/vX.Y.Z` | accepted |
| [0003](0003-attribute-contract-as-a-component.md) | The attribute contract is a component, not a library | accepted |
| [0004](0004-public-npm-and-the-octic-scope.md) | Public npm under `@octichq`, not GitHub Packages | accepted |
| [0005](0005-no-root-package-manager.md) | No package manager at the repository root | accepted |
| [0006](0006-python-ships-spool-only.md) | Ship the Python SDK spool-only, with no transport | accepted |

## When to write one

Lower bar than the backend repos. This repository is public and what it
publishes cannot be recalled — an npm version is immutable, and an attribute
name customers have written queries against is an API. **If a choice would be
expensive to reverse for someone who does not work here, write an ADR**, even
when the code expressing it is twenty lines.

These are visible to anyone. Write for a reader outside the company, and keep
customer names and unannounced plans out of them.
