# Changelog

## [0.3.0](https://github.com/OcticHQ/telemetry/compare/contract-v0.2.0...contract-v0.3.0) (2026-10-27)


### ⚠ BREAKING CHANGES

* **contract:** `octic.sdk.name` for Python spans is now `octichq-airlock-sdk`; anything matching `octic-python` must match the new value. The Node export `OCTIC_SDK_NAME_VALUE_OCTIC_PYTHON` is renamed to `OCTIC_SDK_NAME_VALUE_OCTICHQ_AIRLOCK_SDK`. Regenerate the sibling `contracts` repository with `make contract-generate`.

### Features

* **contract:** close octic.sdk.name to the SDKs that exist ([4fad2e0](https://github.com/OcticHQ/telemetry/commit/4fad2e00664760de760976f3351ee3bab4241caa))
* **contract:** cover the Python pipeline module in the drift check ([d883be5](https://github.com/OcticHQ/telemetry/commit/d883be5f4fd7e8bc3386964e6f49bd235603378b))
* **contract:** cover the rest of the Python sources in the drift check ([e3c50b2](https://github.com/OcticHQ/telemetry/commit/e3c50b2f58a13c51e72a0d7e5b70eae66f5fb41b))
* **contract:** name the Node SDK octichq-airlock-sdk-node in octic.sdk.name ([f185517](https://github.com/OcticHQ/telemetry/commit/f18551757205761bb5a67ff2cbb688bb2c2a21b1))
* **contract:** name the Python SDK octichq-airlock-sdk in octic.sdk.name ([7b731b7](https://github.com/OcticHQ/telemetry/commit/7b731b7e564b095c81fc41c2b21980fa824add79))
* **contract:** teach the drift check to read Python ([35f05a4](https://github.com/OcticHQ/telemetry/commit/35f05a4c62bca5bc2fbdc4dd4c10c9c0576e38e0))

## [0.2.0](https://github.com/OcticHQ/telemetry/compare/contract-v0.2.0-beta.2...contract-v0.2.0) (2026-09-21)


### Documentation

* **contract:** graduate to 0.2.0 and name the tags as they are ([4f192cf](https://github.com/OcticHQ/telemetry/commit/4f192cfa31fa221d82a476c8923401af0a61b3dc))

## [0.2.0-beta.2](https://github.com/OcticHQ/telemetry/compare/contract-v0.2.0-beta.1...contract-v0.2.0-beta.2) (2026-08-23)


### Features

* **contract:** emit the reader half of the contract into @octichq/contracts ([#21](https://github.com/OcticHQ/telemetry/issues/21)) ([9298ae7](https://github.com/OcticHQ/telemetry/commit/9298ae758466af1e5bd6fd00f1a362b40e558000))

## [0.2.0-beta.1](https://github.com/OcticHQ/telemetry/compare/contract-v0.2.0-beta.0...contract-v0.2.0-beta.1) (2026-08-23)


### Bug Fixes

* **node:** ensure non-interference with the consuming applications ([#15](https://github.com/OcticHQ/telemetry/issues/15)) ([a77444f](https://github.com/OcticHQ/telemetry/commit/a77444fce1f5baaac2abaa51d0ef04e6e4c6d17d))

## [0.2.0-beta.0](https://github.com/OcticHQ/telemetry/compare/contract-v0.1.0-beta.0...contract-v0.2.0-beta.0) (2026-08-20)


### Features

* **contract:** Added Python attribute generator ([#13](https://github.com/OcticHQ/telemetry/issues/13)) ([4424ddb](https://github.com/OcticHQ/telemetry/commit/4424ddbc75ea5d69af7215439e34d89793d4d1f0))

## [0.1.0-beta.0](https://github.com/OcticHQ/telemetry/compare/contract-v0.0.1-beta.0...contract-v0.1.0-beta.0) (2026-08-19)


### Features

* **node:** Migrate the Node SDK from the proof of concept ([#10](https://github.com/OcticHQ/telemetry/issues/10)) ([38528bc](https://github.com/OcticHQ/telemetry/commit/38528bcd7fa24002494e0563223582e8ac791004))

## 0.0.1-beta.0 (2026-08-17)


### Features

* publish the Node SDK under the [@octichq](https://github.com/octichq) npm scope ([#7](https://github.com/OcticHQ/telemetry/issues/7)) ([4f0fe5b](https://github.com/OcticHQ/telemetry/commit/4f0fe5b37b72ea09ed840ad39dffc2d772c1d298))
