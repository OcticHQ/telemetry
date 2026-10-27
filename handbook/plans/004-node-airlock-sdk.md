# 004 — The Node SDK becomes `@octichq/airlock-sdk`

Status: accepted

The Node SDK takes the Python SDK's spool-only defaults, is renamed, and is
published to public npm. The reasoning is
[ADR 0007](../adr/0007-node-ships-spool-only-by-default.md); this is the order of
the work.

## The steps

Each is one commit, kept inside one component where it can be.

1. **The contract names the SDK `octichq-airlock-sdk-node`.** `octic.sdk.name`
   in `contract/attributes.yaml` replaces `octic-node`, and
   `make contract-generate` rewrites both languages' constants. The Node sources
   and tests that import the old constant move with it.
2. **The package is `@octichq/airlock-sdk`.** `node/package.json`,
   `release-please-config.json`, and every prose mention outside the
   changelogs. ADR 0004 is left as it was written.
3. **The defaults.**

   | Option | Was | Now |
   |---|---|---|
   | `endpoint` | required | optional, `https://ingest.octic.ai`, recorded in the manifest only |
   | `auth` | `undefined`, warned about as missing | `'none'` |
   | `spool.mode` | `'fallback'` | `'only'`, and the spool is always on |
   | `content.capture` | `'full'` | `'none'` |
   | logs signal | always registered | only with the HTTP transport |

   `spool: { mode: 'fallback' }` plus a credential is the opt-in to HTTP. A
   credential under `'only'` warns once that it is unused. Tests that exercise
   HTTP, auth or logs opt in explicitly; new tests pin that a bare
   `init({ serviceName })` writes a manifest and a traces segment, and no logs
   segment.
4. **Publishing.** `_publish-node.yml`, a reusable workflow, becomes a top-level
   `publish-node.yml` triggered by the node tag, for the reason
   `publish-python.yml` gives: trusted publishing does not accept a reusable
   workflow. Public npm only. The `publish-node` job leaves `ci.yml`.
5. **Docs.** `docs/node-consumer-guide.md`, in the four steps of the Python one;
   `node/README.md` without the pre-release banner; the root README's SDK table;
   `docs/content-policy.md` and `docs/wire-format.md` where they describe Node's
   old defaults.

## Outside this repository

- Before the Release PR is merged: reserve `@octichq` on npm and add a trusted
  publisher for `@octichq/airlock-sdk` naming this repository,
  `publish-node.yml` and the `npm` environment. `handbook/TODO.md` carries both.
- The Airlock console lists the SDK scope names it treats as its own, and gains
  `octichq-airlock-sdk-node`.

## Not covered

No Node workload has run through Airlock. The defaults are checked by the unit
and integration suites against a spool directory, not by a deployment.
