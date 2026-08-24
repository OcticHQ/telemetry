# Changelog

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
