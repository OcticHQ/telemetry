/**
 * octic-telemetry — the PoC distro package.
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
 * See ../README.md for what this is trying to prove.
 */
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
  type EntityOptions,
  type WorkflowOptions,
  type Target,
} from './annotations.ts';
export { IdentitySpanProcessor } from './processor.ts';
export { RedactingSpanExporter } from './redacting-exporter.ts';
export { RedactingLogRecordProcessor } from './redacting-log-processor.ts';
export { SpoolingLogRecordExporter, SpoolingSpanExporter } from './spool-exporter.ts';
export {
  Spool,
  resolveSpoolOptions,
  SEGMENT_SUFFIX,
  SPOOL_FORMAT_VERSION,
  type SpoolConfig,
  type SpoolManifest,
  type SpoolMode,
  type SpoolOptions,
  type SpoolOverflow,
  type SpoolSignal,
  type SpoolStats,
} from './spool.ts';
export * from './attributes.ts';
