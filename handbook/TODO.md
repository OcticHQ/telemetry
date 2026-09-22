# TODO

Cross-cutting follow-ups that don't deserve their own plan yet. Living
document.

Normally a line is deleted when it is done rather than ticked. Through the
SDK migration the completed ones are ticked and kept instead, so a session
picking the work up can see what has already been settled without reading the
git history for it. They get deleted when `0.1.0` ships. Progress across the
whole migration is tracked in `migration_progress.md`.

## Before the repository goes public

- [ ] **Reserve `@octichq` on npm.** Owning the GitHub org grants nothing on
      the npm registry — the scope is claimable by anyone until we claim it,
      and [ADR 0004](adr/0004-public-npm-and-the-octic-scope.md) depends on
      having it. Do this first; everything else here is reversible.
- [ ] **Configure npm trusted publishing** for `@octichq/telemetry`, pointing at
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
- [x] **Set `bootstrap-sha`** in `release-please-config.json` to the scaffold
      commit, so release-please does not walk history that predates it.
- [ ] Enable **Discussions** (the issue-template config links to it) and
      **private security advisories** (`SECURITY.md` links to it).
- [ ] Decide whether the **`npm` deployment environment** referenced by
      `_publish-node.yml` should require manual approval. It is created
      implicitly today and approves automatically, so the Release PR merge is
      currently the only gate.

## Landing the SDK

- [x] **Move `telemetry-poc/octic-telemetry/` into `node/`** as one
      `feat(node):` commit. Done — the copy is `4e9dab9`, the lint pass
      `de6d21e`. `private` stays `true`: publishing is gated on the rest of
      this section and on the production-readiness work, so the flag flips in
      the release pull request instead.
- [x] **Drop `publishConfig.tag` when the SDK is ready for `latest`.** It was
      `beta` so that early publishes could not become the version `npm install`
      resolves to — npm assigns `latest` by default no matter what the version
      string says, so `0.0.1-beta.0` would otherwise have landed as `latest`.
      Dropped when the beta line graduated to `0.2.0`; `private` had already
      flipped for the beta publishes.
- [x] **Take the PoC's `contract/attributes.yaml` at that moment.** This repo's
      copy was taken at scaffold time and the two drift until then — see the
      note at the bottom of `contract/README.md`, and delete it when it stops
      being true.
- [x] **Grow the `handWritten` drift list** in `contract/generate.ts` back to
      the full set: `attributes.ts`, `content.ts`, `annotations.ts`,
      `identity.ts`, `processor.ts`, `redacting-exporter.ts`,
      `redacting-log-processor.ts`. It is one entry today because those files
      do not exist yet.
- [x] **Carry the loader-hook fix** — done in the public-surface pull request,
      as `node/src/loader-hook.ts`. Written rather than carried: the
      `svc-raw/telemetry.ts` this line pointed at is in the PoC repository and
      has never existed in this one, so nothing was there to copy. It also
      promoted `import-in-the-middle` to a declared dependency, because the
      synchronous registration has to come from that package directly and must
      resolve to the same copy `@opentelemetry/instrumentation` hooks through.
- [ ] Delete the pre-release banners from both READMEs. (The scaffold notice
      in `node/src/index.ts` went with the move.)
- [ ] Add `node/examples/` — a runnable service per instrumentation stack, of
      the kind the PoC's `svc-*` directories already are. Left out of the
      scaffold because there is no API yet to demonstrate.

## Carried over from the PoC's NEXT_STEPS

These are the SDK-shaped items; the ingest-shaped ones stay with be-ingest.

- [x] **`BatchSpanProcessor` plus an explicit flush on exit.**
      `SimpleSpanProcessor` is one HTTP round-trip per span — measured at 51
      spans producing 51 queue entries, each ~2.2 KB because every export
      re-sends the whole resource block. Breaking-ish: it changes delivery
      timing that tests may depend on. Done in the batching pull request; see
      `handbook/plans/001-batch-processors-and-flush.md`. "Flush on exit" is
      explicitly *not* an exit hook — the application calls `shutdown()`, and
      the SDK registers no `process` listener, which is now pinned by a test.
- [x] **Failure behaviour.** A dead endpoint must never take a customer's app
      down: no unhandled rejections, no throw out of a processor or exporter
      callback, `resultCallback` exactly once, and `init()` that returns a
      handle rather than throwing. Done in the non-interference pull request.
      The bounded queue and drop-on-overflow half belongs to the batching one —
      `SimpleSpanProcessor` has no queue to bound.
- [ ] **Revisit the Node content default when the first tenant is onboarded.**
      It stays `full` there — decided in the public-surface pull request,
      reversing this line, which used to say flip it to `none` now. Opt-out is
      deliberate while nothing real is connected: a first integration whose
      traces show no prompts and no outputs cannot be told apart from a broken
      pipeline. The pairing to watch is `capture: 'full'` plus a spool directory
      — that writes prompts to the host's disk at rest.

      **Python already defaults to `none`**, because the spool is not its
      failure path but its only sink, so that pairing would be its normal state
      rather than an edge case. The two SDKs therefore disagree on purpose;
      `docs/content-policy.md` has the table, and each pins its own default with
      a test.
- [x] **Decide the OTLP protocol story.** JSON, and it stays implied by which
      exporter package is imported, because neither exporter takes a `protocol`
      option to say it twice. What the public-surface pull request added is the
      two things that were missing: a comment at the import naming protobuf as
      the stock default a reader will expect, and an assertion on the received
      `content-type` in `init.integration.test.ts`, so swapping the dependency
      fails a test instead of quietly changing the wire.

## Found during the non-interference work

- [ ] **`tracerProvider.register()` can silently do nothing.** It discards the
      boolean from `trace.setGlobalTracerProvider`, which returns `false` when a
      global provider is already registered — a host SDK that got there first
      wins, our provider never receives a span, and the handle we return
      flushes something nothing feeds. Detecting it needs either
      `@opentelemetry/api`'s private global symbol or reimplementing
      `register()`'s three lines, which pulls `@opentelemetry/context-async-hooks`
      from a dev dependency into a runtime one. The cheaper detector is the
      batching PR's "nothing exported N seconds after the first span" warning,
      which catches this without either — that warning now exists
      (`node/src/silence-watch.ts`), so this stays open only as the question of
      whether a *specific* message is still wanted on top of the generic one.
- [ ] **Warn when no `ContextManager` is installed.** A host SDK can register a
      provider without one; `context.with` then stores nothing, `context.active()`
      is always ROOT, and every scope in this package stamps nothing while spans
      keep arriving. Two lines to detect. Belongs with the rest of the
      observability work (`OCTIC_TELEMETRY_DEBUG`, the README troubleshooting
      list), not with non-interference — it prevents no crash and swallows
      nothing.
- [ ] **Expose the counters as `diagnose()` when there are real tickets.**
      `src/counters.ts` already maintains `spansAccepted`, `exportsFailed`,
      `attributesDropped`, `spansDropped`, `processorErrors` and
      `duplicateCallbacks`. Deliberately not public: a structured health object
      is a second product surface consumers assert on forever. Ship the shape
      once support cases say which fields matter.

## Tooling

- [ ] **Configure the PyPI trusted publisher before the first Python publish.**
      `.github/workflows/_publish-python.yml` authenticates by OIDC and carries
      no token, so the PyPI project must name this repository, that workflow
      file and the `pypi` environment as a trusted publisher. It cannot be done
      from this repository. Until it is, flipping `pypi: false` in `ci.yml`
      fails at the upload step with an authentication error and nothing more
      useful. The project name `octic-telemetry` should also be registered on
      PyPI before it is needed, rather than discovered to be taken.
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
