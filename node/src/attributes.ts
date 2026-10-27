/**
 * The SDK's view of the attribute contract.
 *
 * The names are no longer written here. They live in `contract/attributes.yaml`
 * and arrive as `attributes.gen.ts`, because a TypeScript file cannot be the
 * specification for the Python and Go ports, and because four hand-maintained
 * copies of the same list is how `assertions.ts` came to check eight content
 * keys while the exporter redacted fifteen.
 *
 * Semconv-owned names come through the generated file too, under the same
 * constant names the semconv package exports, rather than being imported from
 * it. That looks like a step back — an import would break the build if semconv
 * dropped a key. It does not, because the generator resolves the pinned release
 * and compares every name *and its value* on each run, which catches a silent
 * rename that an import would not, and `test/contract.test.ts` asserts the same
 * thing inside the SDK's own suite. What it buys is that ingest, the worker and
 * the PoC harness can all read one file without a semconv dependency in front
 * of it.
 *
 * Rule for adding anything: prefer an existing semantic convention, and only
 * fall back to `octic.*` where nothing exists. Note the GenAI conventions live
 * in semconv's `/incubating` export rather than the stable root, because that
 * part of the spec is still experimental — checking that is what caught
 * `gen_ai.conversation.id` the first time round.
 *
 * What leaves the package is narrower than what this file re-exports. `ATTR`
 * below is the published key surface; the named constants are also published;
 * the reader-side tables — `CONTENT_KEYS`, `CONTENT_PATTERNS`,
 * `EMITTED_ATTRIBUTES`, `INTERNAL_ATTRIBUTES`, `RESOURCE_DENY`, `FIELDS` — are
 * internal here and published separately in `@octichq/contracts`, generated
 * from this same YAML. A consumer writing telemetry needs the keys; a consumer
 * reading it needs the tables, and those are two different dependencies.
 */
import * as gen from './attributes.gen.ts';

/**
 * Every attribute key the contract owns, as one object rather than 28 top-level
 * exports.
 *
 * `ATTR.OCTIC_RUN_ID` over `ATTR_OCTIC_RUN_ID`: it keeps one name in a
 * consumer's import list instead of a growing wall of them, and it makes the
 * set discoverable by typing a dot. The values are the generated constants, so
 * nothing here restates a key.
 */
export const ATTR = Object.freeze({
  DEPLOYMENT_ENVIRONMENT_NAME: gen.ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  GEN_AI_AGENT_ID: gen.ATTR_GEN_AI_AGENT_ID,
  GEN_AI_AGENT_NAME: gen.ATTR_GEN_AI_AGENT_NAME,
  GEN_AI_CONVERSATION_ID: gen.ATTR_GEN_AI_CONVERSATION_ID,
  GEN_AI_DATA_SOURCE_ID: gen.ATTR_GEN_AI_DATA_SOURCE_ID,
  GEN_AI_OPERATION_NAME: gen.ATTR_GEN_AI_OPERATION_NAME,
  GEN_AI_PROMPT_NAME: gen.ATTR_GEN_AI_PROMPT_NAME,
  GEN_AI_RETRIEVAL_QUERY_TEXT: gen.ATTR_GEN_AI_RETRIEVAL_QUERY_TEXT,
  GEN_AI_TOOL_NAME: gen.ATTR_GEN_AI_TOOL_NAME,
  GEN_AI_TOOL_TYPE: gen.ATTR_GEN_AI_TOOL_TYPE,
  GEN_AI_WORKFLOW_NAME: gen.ATTR_GEN_AI_WORKFLOW_NAME,
  OCTIC_AGENT_ASSET_REF: gen.ATTR_OCTIC_AGENT_ASSET_REF,
  OCTIC_CONTENT_CAPTURE: gen.ATTR_OCTIC_CONTENT_CAPTURE,
  OCTIC_ENTITY_INPUT: gen.ATTR_OCTIC_ENTITY_INPUT,
  OCTIC_ENTITY_OUTPUT: gen.ATTR_OCTIC_ENTITY_OUTPUT,
  OCTIC_PROMPT_VERSION: gen.ATTR_OCTIC_PROMPT_VERSION,
  OCTIC_REDACTED: gen.ATTR_OCTIC_REDACTED,
  OCTIC_RUN_ID: gen.ATTR_OCTIC_RUN_ID,
  OCTIC_SCHEMA_VERSION: gen.ATTR_OCTIC_SCHEMA_VERSION,
  OCTIC_SDK_NAME: gen.ATTR_OCTIC_SDK_NAME,
  OCTIC_SDK_VERSION: gen.ATTR_OCTIC_SDK_VERSION,
  OCTIC_TARGET_ASSET_REF: gen.ATTR_OCTIC_TARGET_ASSET_REF,
  OCTIC_TARGET_NAME: gen.ATTR_OCTIC_TARGET_NAME,
  OCTIC_TARGET_TYPE: gen.ATTR_OCTIC_TARGET_TYPE,
  SERVICE_NAME: gen.ATTR_SERVICE_NAME,
  SERVICE_VERSION: gen.ATTR_SERVICE_VERSION,
  SESSION_ID: gen.ATTR_SESSION_ID,
  USER_ID: gen.ATTR_USER_ID,
});

export {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_GEN_AI_AGENT_ID,
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_DATA_SOURCE_ID,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROMPT_NAME,
  ATTR_GEN_AI_RETRIEVAL_QUERY_TEXT,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_TYPE,
  ATTR_GEN_AI_WORKFLOW_NAME,
  ATTR_OCTIC_AGENT_ASSET_REF,
  ATTR_OCTIC_CONTENT_CAPTURE,
  ATTR_OCTIC_ENTITY_INPUT,
  ATTR_OCTIC_ENTITY_OUTPUT,
  ATTR_OCTIC_PROMPT_VERSION,
  ATTR_OCTIC_REDACTED,
  ATTR_OCTIC_RUN_ID,
  ATTR_OCTIC_SCHEMA_VERSION,
  ATTR_OCTIC_SDK_NAME,
  ATTR_OCTIC_SDK_VERSION,
  ATTR_OCTIC_TARGET_ASSET_REF,
  ATTR_OCTIC_TARGET_NAME,
  ATTR_OCTIC_TARGET_TYPE,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_SESSION_ID,
  ATTR_USER_ID,
  CONTENT_HEURISTIC_MIN_LENGTH,
  CONTENT_KEYS,
  CONTENT_PATTERNS,
  CUSTOMER_ATTRIBUTE_PREFIX,
  EMITTED_ATTRIBUTES,
  FIELDS,
  GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
  GEN_AI_OPERATION_NAME_VALUE_INVOKE_WORKFLOW,
  GEN_AI_OPERATION_NAME_VALUE_RETRIEVAL,
  GEN_AI_OPERATION_NAME_VALUES,
  GEN_AI_TOOL_TYPE_VALUE_DATASTORE,
  GEN_AI_TOOL_TYPE_VALUE_EXTENSION,
  GEN_AI_TOOL_TYPE_VALUE_FUNCTION,
  GEN_AI_TOOL_TYPE_VALUES,
  INTERNAL_ATTRIBUTES,
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
  RESOURCE_DENY,
  type DerivedField,
} from './attributes.gen.ts';
