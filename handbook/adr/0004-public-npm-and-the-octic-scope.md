# 0004 — Publish to public npm under `@octic`, not GitHub Packages under `@octichq`

- **Status**: accepted
- **Date**: 2026-08-15
- **Deciders**: platform maintainers

## Context and problem

Every Node package Octic publishes today goes to **GitHub Packages** under the
`@octichq` scope — `@octichq/contracts` is consumed that way by be-api,
be-worker and be-ingest, and the CI machinery for it already exists and works.

This SDK is installed by people outside the company. That single difference
breaks the existing arrangement in two places at once.

## Decision

**`@octic/telemetry` on public npm.** `@octichq/contracts` stays where it is.

### Why not GitHub Packages

**GitHub Packages requires authentication to install a package even when it is
public.** A consumer must create a personal access token and write an `.npmrc`
before `npm install` works. No external developer will do that to try an SDK,
and a meaningful fraction will not be *allowed* to put a GitHub PAT in their CI.
It is not friction; it is a wall.

### Why the scope changes

`@octichq` exists because `@octic` was taken on the GitHub org namespace. That
constraint is GitHub's and does not apply to npm. The published name is the one
customers type, read in stack traces and search for, so it should be the
product name.

**This is a one-way door.** Renaming a published npm package is a migration for
every consumer plus a deprecation shim we would maintain indefinitely. Doing it
before the first publish is free, which is why this ADR exists now rather than
when it becomes urgent.

### Consequence for the contract

A public package cannot depend on a private one, so the SDK cannot import
`@octichq/contracts`. The shared shapes therefore live here and are published
as a **document** (`contract/ATTRIBUTES.md`) that be-ingest and be-worker read,
with generated constants on each side.
[ADR 0003](0003-attribute-contract-as-a-component.md)

### Authentication for publishing

**npm trusted publishing (OIDC)**, not a long-lived `NPM_TOKEN`. The workflow
requests an `id-token`, npm verifies the workflow identity, and the publish
carries a provenance attestation linking the tarball to the commit and the run
that built it. That badge is worth real trust for a package that runs inside a
customer's process and handles their prompts.

It requires the repository to be public and the npm package to be configured
for trusted publishing before the first publish. If it is unavailable, the
fallback is an `NPM_TOKEN` secret — at the cost of a long-lived credential and
no provenance.

## Consequences

- **Positive**: `npm install @octic/telemetry` works with no setup, which is the
  entire proposition.
- **Positive**: provenance, and no publish credential to rotate or leak.
- **Positive**: the npm package page is a real landing page, so `node/README.md`
  is documentation with an audience.
- **Negative**: two registries and two auth models in the org. Whoever adds the
  next Node package has to know which side it is on.
- **Negative**: `node/README.md` must be self-contained with absolute links —
  npmjs.com renders it outside the repo and relative links break.
- **Negative**: the name is claimable by anyone until we claim it. Reserving
  `@octic` on npm is a prerequisite, not a follow-up.
- **Neutral**: the SDK keeps its own copy of contract constants rather than
  importing them, with a generated-file check instead of a dependency.

## Alternatives considered

- **GitHub Packages under `@octichq`** — reuses the existing pipeline exactly.
  Rejected: the PAT requirement makes external adoption effectively impossible.
- **Public npm under `@octichq`** — solves installation while keeping one scope
  across the org. Rejected: it exports a GitHub-namespace collision into the
  product's public name forever, for internal tidiness.
- **An unscoped `octic-telemetry` on npm** — shortest to type. Rejected: no
  namespace to grow into when the second package arrives, and unscoped names
  are the ones typosquatters target.
- **Both registries** — publish to each. Rejected: two artifacts with the same
  version that can differ, for no gain over one public one.
