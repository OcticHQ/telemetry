# Changelog

## [0.3.1](https://github.com/OcticHQ/telemetry/compare/node-v0.3.0...node-v0.3.1) (2026-10-27)


### Bug Fixes

* **node:** carry OTEL_RESOURCE_ATTRIBUTES on the resource ([0113081](https://github.com/OcticHQ/telemetry/commit/0113081c7619408cea2c44eea433f82c851fa826))

## [0.3.0](https://github.com/OcticHQ/telemetry/compare/node-v0.2.0...node-v0.3.0) (2026-10-27)


### ⚠ BREAKING CHANGES

* **contract:** `octic.sdk.name` for Python spans is now `octichq-airlock-sdk`; anything matching `octic-python` must match the new value. The Node export `OCTIC_SDK_NAME_VALUE_OCTIC_PYTHON` is renamed to `OCTIC_SDK_NAME_VALUE_OCTICHQ_AIRLOCK_SDK`. Regenerate the sibling `contracts` repository with `make contract-generate`.
* **node:** `instrumentationScope.name` on our own spans is `octic-node`, was `octic-telemetry`. `export *` from the attribute contract is replaced by an `ATTR` namespace plus named exports, and the reader-side tables (`CONTENT_KEYS`, `CONTENT_PATTERNS`, `CONTENT_HEURISTIC_MIN_LENGTH`, `EMITTED_ATTRIBUTES`, `INTERNAL_ATTRIBUTES`, `RESOURCE_DENY`, `FIELDS`, `DerivedField`) are no longer published — use `@octichq/contracts`. `Spool`, `resolveSpoolOptions`, `SpoolConfig` and `SpoolManifest` are no longer exported. `IdentitySpanProcessor` is deprecated in favour of `OcticSpanProcessor`. `ExternalProviderTelemetry.identityProcessor`, `.traceExporter`, `.flushLogs` and `.shutdownLogs` are now `.spanProcessor`, `.spanExporter`, `.forceFlush` and `.shutdown`.

### Features

* **contract:** close octic.sdk.name to the SDKs that exist ([4fad2e0](https://github.com/OcticHQ/telemetry/commit/4fad2e00664760de760976f3351ee3bab4241caa))
* **contract:** name the Node SDK octichq-airlock-sdk-node in octic.sdk.name ([f185517](https://github.com/OcticHQ/telemetry/commit/f18551757205761bb5a67ff2cbb688bb2c2a21b1))
* **contract:** name the Python SDK octichq-airlock-sdk in octic.sdk.name ([7b731b7](https://github.com/OcticHQ/telemetry/commit/7b731b7e564b095c81fc41c2b21980fa824add79))
* **node:** default to spool-only, no auth, content capture none and traces only ([dada273](https://github.com/OcticHQ/telemetry/commit/dada2734f110c692a599215055a8d199b1f8ff97))
* **node:** rename to @octichq/airlock-sdk ([b2cc29f](https://github.com/OcticHQ/telemetry/commit/b2cc29f669b759880d6496b84f0020b1eeddb525))
* **node:** settle the public surface before the first stable release ([899cd16](https://github.com/OcticHQ/telemetry/commit/899cd16c9ece2991625afd6fc34f25be96e519df))

## [0.2.0](https://github.com/OcticHQ/telemetry/compare/node-v0.2.0-beta.2...node-v0.2.0) (2026-09-21)


### Bug Fixes

* **node:** publish to latest as the beta line graduates to 0.2.0 ([23bbfa9](https://github.com/OcticHQ/telemetry/commit/23bbfa9087323f43522301b5805342688093f1e2))

## [0.2.0-beta.2](https://github.com/OcticHQ/telemetry/compare/node-v0.2.0-beta.1...node-v0.2.0-beta.2) (2026-08-24)


### ⚠ BREAKING CHANGES

* **node:** the top-level `apiKey` option and the `auth: 'apiKey'` string are removed. `init({ apiKey })` becomes `init({ auth: { kind: 'apiKey', apiKey } })`.

### Features

* **node:** batch spans and log records ([f1d7602](https://github.com/OcticHQ/telemetry/commit/f1d7602145e67c9636304691a336b05eee06a310))
* **node:** refresh the ingest token before it expires ([#25](https://github.com/OcticHQ/telemetry/issues/25)) ([2734cfd](https://github.com/OcticHQ/telemetry/commit/2734cfd2c5e9869cf0fc8c9950a4ad2118cfdace))

## [0.2.0-beta.1](https://github.com/OcticHQ/telemetry/compare/node-v0.1.0-beta.0...node-v0.2.0-beta.1) (2026-08-23)


### Bug Fixes

* **node:** ensure non-interference with the consuming applications ([#15](https://github.com/OcticHQ/telemetry/issues/15)) ([a77444f](https://github.com/OcticHQ/telemetry/commit/a77444fce1f5baaac2abaa51d0ef04e6e4c6d17d))

## [0.1.0-beta.0](https://github.com/OcticHQ/telemetry/compare/node-v0.0.1-beta.0...node-v0.1.0-beta.0) (2026-08-19)


### Features

* **node:** Migrate the Node SDK from the proof of concept ([#10](https://github.com/OcticHQ/telemetry/issues/10)) ([38528bc](https://github.com/OcticHQ/telemetry/commit/38528bcd7fa24002494e0563223582e8ac791004))

## 0.0.1-beta.0 (2026-08-17)


### Features

* publish the Node SDK under the [@octichq](https://github.com/octichq) npm scope ([#7](https://github.com/OcticHQ/telemetry/issues/7)) ([4f0fe5b](https://github.com/OcticHQ/telemetry/commit/4f0fe5b37b72ea09ed840ad39dffc2d772c1d298))
