/**
 * The ESM loader hook, without which ESM auto-instrumentation patches nothing.
 *
 * Instrumentation for an ESM graph works by intercepting module *loading*, so
 * it needs a hook installed before the instrumented library is imported — hence
 * `node --import ./telemetry.ts server.ts`. Get this wrong and the failure is
 * the quiet one this package exists to remove: the process exits 0 having
 * emitted nothing at all.
 *
 * Two ways to install it, and the choice is the running Node's, not ours:
 *
 *   `module.registerHooks`   synchronous, in-thread. Hook registrations are
 *                            visible to the loader directly, with no
 *                            acknowledgement step and no IPC round trip per
 *                            resolved module.
 *   `module.register`        the asynchronous loader on its own thread. Node
 *                            deprecated the shape we use it in (DEP0205), but
 *                            it is still the only one that works below
 *                            22.22.3 / 24.11.1 / 25.1.0 / 26.
 *
 * `supportsSyncHooks()` is import-in-the-middle's own version check rather than
 * ours — `module.registerHooks` has existed since 22.15 but rejected the nullish
 * CommonJS `source` the loader returns for `require()`s pulled into an ESM graph
 * until nodejs/node#59929, so "the function exists" is the wrong question.
 *
 * ## Why import-in-the-middle is a direct dependency
 *
 * `@opentelemetry/instrumentation` ships `hook.mjs` for the asynchronous path
 * and nothing for the synchronous one, so the sync registration has to come from
 * import-in-the-middle itself. It then matters a great deal that the copy we
 * register is *the same resolved module* as the one
 * `@opentelemetry/instrumentation` calls `Hook()` on: two copies means
 * instrumentation registering against one registry while the loader patches
 * through another, and nothing is instrumented, silently. Declaring the
 * dependency at a range compatible with the one instrumentation declares is
 * what keeps a single copy at the top of `node_modules`. It is not a proof —
 * a consumer can still arrange a split install — which is the other reason
 * `silence-watch.ts` exists.
 */
import { register } from 'node:module';
import { diag } from '@opentelemetry/api';
import {
  register as registerSyncHooks,
  supportsSyncHooks,
} from 'import-in-the-middle/register-hooks.mjs';

/**
 * Registers the hook, or explains why it could not.
 *
 * Never throws: it is called from `setup()`, and a loader that will not install
 * costs telemetry rather than the consumer's process. Not idempotent either —
 * a second call adds a second hook — which is one of the reasons `setup()` runs
 * at most once per process. See the list above `State` in `init.ts`.
 */
export const installLoaderHook = (): void => {
  try {
    if (supportsSyncHooks()) {
      registerSyncHooks();
      diag.debug('octic-telemetry: ESM loader hook installed (synchronous)');
      return;
    }

    /**
     * DEP0205. Kept deliberately: it is the only path that works on the Node
     * versions the gate rejects, and a deprecation warning is a better outcome
     * than an uninstrumented process.
     */
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
    diag.debug(
      `octic-telemetry: ESM loader hook installed (asynchronous; node ${process.versions.node} predates the synchronous one)`,
    );
  } catch (error) {
    /**
     * Warn rather than debug. Unlike most of what this package swallows, the
     * consequence is not a missing attribute — it is a run that produces no
     * spans at all from anything it did not annotate by hand, and the only
     * other signal for that is the silence warning several seconds later.
     */
    diag.warn(
      'octic-telemetry: could not install the ESM loader hook; ESM auto-instrumentation will not patch anything',
      error,
    );
  }
};
