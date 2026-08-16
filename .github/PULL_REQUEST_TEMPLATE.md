<!--
Merging this PR does not release anything. Merging the Release PR that
release-please opens afterwards is what cuts the tag and publishes.

Which component releases is decided by the FILES you touched, not by the
commit scope. Write accurate scopes anyway — they are what the changelog
reads like.
-->

## What and why

<!-- One paragraph. What changes, and what problem it solves. -->

## Component(s)

<!-- node / contract / docs-only / tooling -->

## Checklist

- [ ] Commits are Conventional Commits (`./scripts/check-commits.sh "$(git merge-base origin/main HEAD)"`)
- [ ] The change is confined to one component where it reasonably could be
- [ ] Contract artifacts regenerated and committed if `attributes.yaml` moved
      (`cd contract && npm run generate`)
- [ ] New behaviour has a test
- [ ] Public API changes are reflected in the component's README

## Breaking change?

<!--
If yes, the commit must be marked `!` or carry a BREAKING CHANGE footer, and
this section must say what a consumer has to do.

Breaking for this repo is wider than a changed function signature. It includes
renaming or removing an attribute the contract marks `emitted`, because
customer queries and our graph writes key off those names — see
contract/README.md.
-->

No.
