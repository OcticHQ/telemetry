/**
 * `@octicai/telemetry` — agent telemetry for Node.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SCAFFOLD. The SDK itself still lives in the `telemetry-poc` repository, under
 * `octic-telemetry/`, and moves here in one `feat(node):` commit. What is here
 * now is deliberately the smallest thing that makes the pipeline real: it
 * builds, it type-checks, it lints, it tests, it packs, and it is covered by the
 * contract drift gate. A release pipeline nobody has run is a release pipeline
 * that does not work.
 *
 * When the SDK lands, this file becomes the public barrel:
 *
 *     init, initWithExternalProvider
 *     withIdentity, withAgent, withPrompt, withContent, currentRunId
 *     withWorkflow, withTool, withRetrieval
 *     IdentitySpanProcessor, RedactingSpanExporter, RedactingLogRecordProcessor
 *     export * from './attributes.ts'
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This file is on the contract's `handWritten` drift list, so it must not
 * restate any attribute key the contract owns — import it from
 * `./attributes.gen.ts` instead. See `contract/README.md`.
 */
export { SDK_NAME, SDK_VERSION } from './version.ts';
