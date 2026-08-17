# 0004 — Publish to public npm under `@octichq`, not GitHub Packages

- **Status**: accepted
- **Date**: 2026-08-15
- **Deciders**: platform maintainers

## Context and problem

Every Node package Octic publishes today goes to **GitHub Packages** under the
`@octichq` scope — `@octichq/contracts` is consumed that way by be-api,
be-worker and be-ingest, and the CI machinery for it already exists and works.

This SDK is installed by people outside the company. That single difference
breaks the existing arrangement.

## Decision

**`@octichq/telemetry` on public npm.** `@octichq/contracts` stays on GitHub
Packages. The scope name is shared; the registries are not.

### Why not GitHub Packages

**GitHub Packages requires authentication to install a package even when it is
public.** A consumer must create a personal access token and write an `.npmrc`
before `npm install` works. No external developer will do that to try an SDK,
and a meaningful fraction will not be *allowed* to put a GitHub PAT in their CI.
It is not friction; it is a wall.

### Why the scope stays `@octichq`

One scope across the org is one thing to reserve, one thing to defend against
typosquatters, and one thing for whoever adds the next Node package to reason
about. A separate public-facing scope buys a marginally prettier package name
and costs a permanent "which one is this?" question on every future package.

**The scope is a one-way door.** Renaming a published npm package is a
migration for every consumer plus a deprecation shim we would maintain
indefinitely. Settling it before the first publish is free, which is why this
ADR exists now rather than when it becomes urgent.

### Consequence for the contract

A public package cannot depend on a private one, so the SDK cannot import
`@octichq/contracts` — sharing a scope does not change that; the packages live
on different registries under different auth. The shared shapes therefore live
here and are published as a **document** (`contract/ATTRIBUTES.md`) that
be-ingest and be-worker read, with generated constants on each side.
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

- **Positive**: `npm install @octichq/telemetry` works with no setup, which is
  the entire proposition.
- **Positive**: provenance, and no publish credential to rotate or leak.
- **Positive**: one org scope, so there is no rule to remember about which
  package uses which name.
- **Positive**: the npm package page is a real landing page, so `node/README.md`
  is documentation with an audience.
- **Negative**: **npm resolves a scope to one registry, not a package.** A
  repository whose `.npmrc` maps `@octichq:registry=https://npm.pkg.github.com`
  — every backend repo that consumes `@octichq/contracts` — will look for
  `@octichq/telemetry` on GitHub Packages and fail. External consumers have no
  such mapping and are unaffected. If a backend repo ever instruments itself
  with this SDK, it needs a per-package override or a mirrored publish. This is
  the price of the shared scope, and it is paid internally rather than by
  customers.
- **Negative**: two registries and two auth models in the org, now without a
  scope name to tell them apart.
- **Negative**: `node/README.md` must be self-contained with absolute links —
  npmjs.com renders it outside the repo and relative links break.
- **Negative**: owning `@octichq` on GitHub Packages grants nothing on npm,
  where the scope is claimable by anyone until we claim it. Reserving it there
  is a prerequisite, not a follow-up.
- **Neutral**: the SDK keeps its own copy of contract constants rather than
  importing them, with a generated-file check instead of a dependency.

## Alternatives considered

- **GitHub Packages under `@octichq`** — reuses the existing pipeline exactly.
  Rejected: the PAT requirement makes external adoption effectively impossible.
- **A separate public scope on npm** — a product-shaped name, and no collision
  with the GitHub Packages scope. Rejected: a second namespace to reserve,
  defend and explain, for a cosmetic gain.
- **An unscoped `octic-telemetry` on npm** — shortest to type. Rejected: no
  namespace to grow into when the second package arrives, and unscoped names
  are the ones typosquatters target.
- **Both registries** — publish to each. Rejected: two artifacts with the same
  version that can differ, for no gain over one public one.
