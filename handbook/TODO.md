# TODO

Cross-cutting follow-ups that don't deserve their own plan yet. Living
document — delete a line when it is done, don't tick it.

## Before the repository goes public

- [ ] **Reserve `@octicai` on npm.** The scope is claimable by anyone until we
      claim it, and [ADR 0004](adr/0004-public-npm-and-the-octic-scope.md)
      depends on having it. Do this first; everything else here is reversible.
      `@octic` is gone — `octic` is held on npm by an unrelated user, which is
      what forced the scope. Confirm `@octicai` is actually free before relying
      on it; the registry does not answer that anonymously.
- [ ] **Configure npm trusted publishing** for `@octicai/telemetry`, pointing at
      this repository and `.github/workflows/_publish-node.yml`. Without it the
      publish job needs an `NPM_TOKEN` secret and produces no provenance.
- [ ] **Confirm the CODEOWNERS team slug.** `.github/CODEOWNERS` currently
      guesses `@OcticHQ/platform`. An unresolvable owner requests review from
      nobody and looks exactly like a repo with no required reviewers.
- [ ] **Add this repo to the org secrets' access list** for
      `SEMANTIC_RELEASE_CLIENT_ID` / `SEMANTIC_RELEASE_PRIVATE_KEY`. The
      release job fails at the token step otherwise.
- [ ] **Branch ruleset on `main`**: require the PR checks, require review, and
      put the Semantic Release app on the bypass list — release-please pushes
      the release branch and the tag as that identity.
- [ ] **Set `bootstrap-sha`** in `release-please-config.json` to the scaffold
      commit, so release-please does not walk history that predates it.
- [ ] Enable **Discussions** (the issue-template config links to it) and
      **private security advisories** (`SECURITY.md` links to it).
- [ ] Decide whether the **`npm` deployment environment** referenced by
      `_publish-node.yml` should require manual approval. It is created
      implicitly today and approves automatically, so the Release PR merge is
      currently the only gate.

## Landing the SDK

- [ ] **Move `telemetry-poc/octic-telemetry/` into `node/`** as one
      `feat(node):` commit, and flip `node/package.json` `private` to `false`
      in the same pull request.
- [ ] **Drop `publishConfig.tag` when the SDK is ready for `latest`.** It is
      `beta` so that early publishes cannot become the version `npm install`
      resolves to — npm assigns `latest` by default no matter what the version
      string says, so `0.0.1-beta.0` would otherwise land as `latest`. Leaving
      it set is the mirror failure: a GA release nobody can install without
      naming a tag. Flip it in the same pull request as `private`.
- [ ] **Take the PoC's `contract/attributes.yaml` at that moment.** This repo's
      copy was taken at scaffold time and the two drift until then — see the
      note at the bottom of `contract/README.md`, and delete it when it stops
      being true.
- [ ] **Grow the `handWritten` drift list** in `contract/generate.ts` back to
      the full set: `attributes.ts`, `content.ts`, `annotations.ts`,
      `identity.ts`, `processor.ts`, `redacting-exporter.ts`,
      `redacting-log-processor.ts`. It is one entry today because those files
      do not exist yet.
- [ ] **Carry the loader-hook fix** — the PoC's `init.ts` still calls the
      deprecated `module.register` (Node DEP0205); `svc-raw/telemetry.ts` has
      the working `module.registerHooks` replacement.
- [ ] Delete the scaffold notice from `node/src/index.ts` and the pre-release
      banners from both READMEs.
- [ ] Add `node/examples/` — a runnable service per instrumentation stack, of
      the kind the PoC's `svc-*` directories already are. Left out of the
      scaffold because there is no API yet to demonstrate.

## Carried over from the PoC's NEXT_STEPS

These are the SDK-shaped items; the ingest-shaped ones stay with be-ingest.

- [ ] **`BatchSpanProcessor` plus an explicit flush on exit.**
      `SimpleSpanProcessor` is one HTTP round-trip per span — measured at 51
      spans producing 51 queue entries, each ~2.2 KB because every export
      re-sends the whole resource block. Breaking-ish: it changes delivery
      timing that tests may depend on.
- [ ] **Failure behaviour.** A dead endpoint must never take a customer's app
      down: bounded queue, drop on overflow, no unhandled rejections. This is
      the one item that is a bug rather than an improvement.
- [ ] **Flip the content default from `full` to `none`.** Deliberately opt-out
      while nothing real is connected, and it stops being defensible the moment
      a tenant is onboarded. One line in `content.ts`, a doc pass, and a test
      pins it either way.
- [ ] **Decide the OTLP protocol story.** Every PoC stack exports JSON because
      of how the exporter is constructed; a stock exporter sends protobuf by
      default. Pin ours to `http/json` explicitly rather than by accident.

## Tooling

- [ ] **Revisit release-please at 1.0.**
      [ADR 0002](adr/0002-per-sdk-versioning.md) chose it partly for the 0.x
      mode, which stops mattering at 1.0. The tag namespace is portable to
      semantic-release, so converging on the org model is a live option — make
      it a decision rather than a default.
- [ ] **Semconv version is pinned in two manifests** (`contract/` and `node/`)
      and must track. A mismatch fails the generator, which is the right
      direction, but Dependabot will bump them independently.
- [ ] **Consider OTel Weaver** when the second language starts. The YAML is
      shaped so the migration should be mechanical, and building it for one
      language would have been speculative.
