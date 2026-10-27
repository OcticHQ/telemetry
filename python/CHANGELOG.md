# Changelog

## [0.3.0](https://github.com/OcticHQ/telemetry/compare/python-v0.2.0...python-v0.3.0) (2026-10-27)


### Features

* **contract:** name the Node SDK octichq-airlock-sdk-node in octic.sdk.name ([f185517](https://github.com/OcticHQ/telemetry/commit/f18551757205761bb5a67ff2cbb688bb2c2a21b1))


### Documentation

* **python:** add an instrumentation step to the consumer guide ([1e42cc7](https://github.com/OcticHQ/telemetry/commit/1e42cc78e934da041105e87d329c5b9edd97a7b4))

## [0.2.0](https://github.com/OcticHQ/telemetry/compare/python-v0.1.0...python-v0.2.0) (2026-09-23)


### ⚠ BREAKING CHANGES

* **python:** install `octichq-airlock-sdk` instead of `octic-telemetry`, and replace `from octic_telemetry import ...` with `from octichq_airlock_sdk import ...`.

### Features

* **python:** rename to octichq-airlock-sdk ([ba372e4](https://github.com/OcticHQ/telemetry/commit/ba372e487f1eb045fa8c6c5f0cbec7bc31da50f8))

## 0.1.0 (2026-09-22)


### Features

* **contract:** Added Python attribute generator ([#13](https://github.com/OcticHQ/telemetry/issues/13)) ([4424ddb](https://github.com/OcticHQ/telemetry/commit/4424ddbc75ea5d69af7215439e34d89793d4d1f0))
* **contract:** close octic.sdk.name to the SDKs that exist ([4fad2e0](https://github.com/OcticHQ/telemetry/commit/4fad2e00664760de760976f3351ee3bab4241caa))
* **python:** default content capture to none, and stop requiring an endpoint ([a9cc52a](https://github.com/OcticHQ/telemetry/commit/a9cc52a7ed1ba6224125ba670e51e7922a3908c8))
* **python:** the SDK core — scopes, annotations, content policy, encoder ([0302576](https://github.com/OcticHQ/telemetry/commit/030257650a06f6a54306691f9280ae924b6f4959))
* **python:** the spool, init(), and the guards around them ([b073ee5](https://github.com/OcticHQ/telemetry/commit/b073ee50176e73c08184025ac8fe3e3a7a6f7d54))


### Bug Fixes

* **python:** keep ruff's formatter off the generated contract ([0027d68](https://github.com/OcticHQ/telemetry/commit/0027d689d0077bbdca9efd4bf6536927b2220f56))


### Documentation

* teach the Python SDK, and stop docs/ being written in one language ([da4c35a](https://github.com/OcticHQ/telemetry/commit/da4c35a3d42de2a2a9584f8f2467c509f4befb2d))
