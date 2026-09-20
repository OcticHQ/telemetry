/**
 * The ESM loader hook, which had no coverage at all before this file.
 *
 * It is worth testing for one reason: every way it can fail is silent. A hook
 * that does not install, or installs against a second copy of
 * import-in-the-middle, leaves a process that starts cleanly, runs correctly,
 * exits 0 and emits nothing from anything it did not annotate by hand. There is
 * no error to assert on, so what gets asserted is the arrangement.
 *
 * What this cannot test in-process: that the hook actually patches a module.
 * Installing a loader is a one-way door for the process that does it, and a
 * test runner that has already imported its own graph is the wrong place to
 * take it. `node/examples/` is where that ends up being demonstrated.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { supportsSyncHooks } from 'import-in-the-middle/register-hooks.mjs';

import { installLoaderHook } from '../src/loader-hook.ts';

const require = createRequire(import.meta.url);

describe('the loader hook', () => {
  /**
   * The hazard that made this a dependency change rather than a one-line swap.
   *
   * `@opentelemetry/instrumentation` calls `Hook()` on the copy of
   * import-in-the-middle *it* resolves, while `loader-hook.ts` registers the
   * loader through the copy *we* resolve. Two copies means instrumentation
   * registering against one registry and the loader patching through another,
   * and the result is a process that instruments nothing without saying so.
   *
   * Resolving both the way each package does is the closest a unit test gets to
   * asserting they are one module.
   */
  it('resolves the same import-in-the-middle that instrumentation uses', () => {
    const ours = require.resolve('import-in-the-middle');
    const theirs = createRequire(require.resolve('@opentelemetry/instrumentation')).resolve(
      'import-in-the-middle',
    );

    assert.equal(
      ours,
      theirs,
      'a split install would leave ESM auto-instrumentation patching nothing, silently',
    );
  });

  /**
   * The gate is import-in-the-middle's, not a `typeof module.registerHooks`
   * check of our own: the function has existed since Node 22.15 but returned
   * the wrong thing for CommonJS pulled into an ESM graph until well after
   * that, so availability is the wrong question. Pinning the type rather than
   * the answer, because the answer is a property of whichever Node is running.
   */
  it('decides which mechanism to use from the running Node, not from us', () => {
    assert.equal(typeof supportsSyncHooks(), 'boolean');
  });

  /**
   * Called from `setup()`, where a throw would take down the consumer's
   * application over telemetry. The second call also stands in for the case
   * `init()`'s latch exists to prevent — it adds a second hook, which is waste,
   * but it must not be an error.
   */
  it('never throws, on either the first call or a second', () => {
    assert.doesNotThrow(() => {
      installLoaderHook();
    });
    assert.doesNotThrow(() => {
      installLoaderHook();
    });
  });
});
