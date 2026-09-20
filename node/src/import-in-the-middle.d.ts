/**
 * Types for the one import-in-the-middle entry point we use.
 *
 * The package ships `register-hooks.d.ts` beside `register-hooks.mjs`, and
 * TypeScript will not pair those: a specifier ending in `.mjs` is matched
 * against `.d.mts`, so the declarations it publishes are unreachable from the
 * specifier Node needs. Dropping the extension is not an option either — the
 * package declares no `exports` map, so Node resolves the subpath with the
 * CommonJS algorithm, whose extension search covers `.js`, `.json` and `.node`
 * but not `.mjs`.
 *
 * So the signatures are restated here, narrowed to what `loader-hook.ts` calls.
 * Keep them in step with the upstream file when the dependency is bumped; both
 * are small, and a wrong signature here is a compile error rather than a silent
 * runtime difference.
 */
declare module 'import-in-the-middle/register-hooks.mjs' {
  /**
   * Registers import-in-the-middle as a synchronous, in-thread loader hook via
   * `module.registerHooks()`. Throws where `supportsSyncHooks()` is false.
   */
  export function register(options?: {
    include?: (string | RegExp)[];
    exclude?: (string | RegExp)[];
  }): void;

  /**
   * Whether the running Node can correctly run the synchronous loader. False on
   * versions that have `module.registerHooks()` but predate the nullish
   * CommonJS `source` fix, which is why this is not a `typeof` check.
   */
  export function supportsSyncHooks(): boolean;
}
