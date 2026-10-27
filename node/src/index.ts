/**
 * `@octichq/telemetry` — agent telemetry for Node.
 *
 * No instrumentation. One setup call, and a set of annotations for the things
 * instrumentation cannot see:
 *
 *   init()           wire OTel up correctly, point it at us, declare the agent
 *
 *   withIdentity()   durable identity: conversation, end user, business ids
 *   withAgent()      which agent — only when one process runs several
 *   withPrompt()     which prompt template produced a model call
 *
 *   withWorkflow()   the agent-run root span, and the run id
 *   withTool()       tool execution, which is invisible application code
 *   withRetrieval()  a lookup that fetched context for the model
 *
 * The first group sets context and emits no spans; the second emits spans. Both
 * end up as attributes on spans we did not create, by the same mechanism.
 *
 * See ./README.md for what this is and how to wire it up.
 *
 * This file is on the contract's `handWritten` drift list, so it must not
 * restate any attribute key the contract owns — import it from
 * `./attributes.gen.ts` instead. See `contract/README.md`.
 */
export { type AuthOptions } from './auth.ts';
export {
  init,
  initWithExternalProvider,
  type InitOptions,
  type Telemetry,
  type ExternalProviderTelemetry,
  type SpoolHandle,
} from './init.ts';
export {
  identityHook,
  withIdentity,
  withIdentityContext,
  identityFrom,
  type Identity,
} from './identity.ts';
export { withAgent, type Agent } from './agent.ts';
export {
  withContent,
  type ContentCapture,
  type ContentOptions,
  type ContentPolicy,
} from './content.ts';
export { withPrompt, type Prompt } from './prompt.ts';
export { currentRunId } from './run.ts';
export {
  withWorkflow,
  withTool,
  withRetrieval,
  TRACER_NAME,
  type EntityOptions,
  type WorkflowOptions,
  type Target,
} from './annotations.ts';
export { OcticSpanProcessor } from './processor.ts';
// Re-exported *because* it is deprecated: the alias is the migration path, and
// a consumer only sees the deprecation notice if the old name still resolves.
// eslint-disable-next-line @typescript-eslint/no-deprecated
export { IdentitySpanProcessor } from './processor.ts';
export { RedactingSpanExporter } from './redacting-exporter.ts';
export { RedactingLogRecordProcessor } from './redacting-log-processor.ts';
export { SpoolingLogRecordExporter, SpoolingSpanExporter } from './spool-exporter.ts';
/**
 * The spool's shape, not its machinery. `Spool` itself, `resolveSpoolOptions`,
 * `SpoolConfig` and `SpoolManifest` stay internal: a process that reads a spool
 * directory is a separate program implementing ../../contract/SPOOL.md, and
 * what it needs is that document. Exporting the class instead invites a reader
 * built against our internals, which then breaks on a refactor that broke no
 * contract.
 */
export {
  SEGMENT_SUFFIX,
  SPOOL_FORMAT_VERSION,
  type SpoolMode,
  type SpoolOptions,
  type SpoolOverflow,
  type SpoolSignal,
  type SpoolStats,
} from './spool.ts';
export { ATTR } from './attributes.ts';
export {
  CUSTOMER_ATTRIBUTE_PREFIX,
  GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
  GEN_AI_OPERATION_NAME_VALUE_INVOKE_WORKFLOW,
  GEN_AI_OPERATION_NAME_VALUE_RETRIEVAL,
  GEN_AI_OPERATION_NAME_VALUES,
  GEN_AI_TOOL_TYPE_VALUE_DATASTORE,
  GEN_AI_TOOL_TYPE_VALUE_EXTENSION,
  GEN_AI_TOOL_TYPE_VALUE_FUNCTION,
  GEN_AI_TOOL_TYPE_VALUES,
  OCTIC_CONTENT_CAPTURE_VALUE_FULL,
  OCTIC_CONTENT_CAPTURE_VALUE_METADATA,
  OCTIC_CONTENT_CAPTURE_VALUE_NONE,
  OCTIC_CONTENT_CAPTURE_VALUES,
  OCTIC_SCHEMA_VERSION,
  OCTIC_SDK_NAME_VALUE_OCTICHQ_AIRLOCK_SDK,
  OCTIC_SDK_NAME_VALUE_OCTICHQ_AIRLOCK_SDK_NODE,
  OCTIC_SDK_NAME_VALUES,
  OCTIC_TARGET_TYPE_VALUE_DATASTORE,
  OCTIC_TARGET_TYPE_VALUE_SERVICE,
  OCTIC_TARGET_TYPE_VALUE_TOOL,
  OCTIC_TARGET_TYPE_VALUES,
  RESERVED_ATTRIBUTE_PREFIX,
} from './attributes.ts';
export { SDK_NAME, SDK_VERSION } from './version.ts';
