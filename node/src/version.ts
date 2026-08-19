/**
 * The package version, as a value the SDK can put on the wire.
 *
 * This is stamped by release-please in the same commit as the `package.json`
 * bump — see the `extra-files` entry in `release-please-config.json`. Reading
 * `package.json` at runtime is the obvious alternative and it is wrong here:
 * the package is ESM-only, `files` ships `dist` alone, and a bundler that
 * inlines the import would freeze whatever version happened to be on disk.
 *
 * The failure this prevents is quiet. The PoC hardcoded `0.0.0`, so every span
 * it produced claimed SDK version `0.0.0` — telemetry about telemetry that
 * cannot tell two releases apart is worse than none, and the first support
 * ticket is where you find out.
 *
 * The trailing marker comment is load-bearing. Do not remove it.
 */
export const SDK_VERSION = '0.1.0-beta.0'; // x-release-please-version

/** The name reported alongside the version, as `octic.sdk.name`. */
export const SDK_NAME = 'octic-node';
