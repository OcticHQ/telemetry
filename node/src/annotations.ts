/**
 * Run-scoped annotations: the part no instrumentation can produce for us.
 *
 * Patching a provider SDK can only ever see one HTTP call. It cannot know that
 * five of those calls were one agent doing one job, which is why an unannotated
 * two-call run arrives as two unrelated traces. Only the application knows where
 * the work starts and ends, so only the application can say so.
 *
 * Note `input` is an explicit parameter rather than something inferred from the
 * callback's arguments. A wrapper that serializes the wrapped function's args
 * records nothing when it is handed a zero-arg closure — which is exactly what
 * happened in ../../openai-openllmetry, where the tool span reads
 * `{"args":[],"kwargs":{}}`. Making the input explicit removes the trap.
 */
import { diag, SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';
import {
  ATTR_GEN_AI_DATA_SOURCE_ID,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_RETRIEVAL_QUERY_TEXT,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_TYPE,
  ATTR_GEN_AI_WORKFLOW_NAME,
  ATTR_OCTIC_ENTITY_INPUT,
  ATTR_OCTIC_ENTITY_OUTPUT,
  ATTR_OCTIC_TARGET_ASSET_REF,
  ATTR_OCTIC_TARGET_NAME,
  ATTR_OCTIC_TARGET_TYPE,
  GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
  GEN_AI_OPERATION_NAME_VALUE_INVOKE_WORKFLOW,
  GEN_AI_OPERATION_NAME_VALUE_RETRIEVAL,
  GEN_AI_TOOL_TYPE_VALUE_FUNCTION,
} from './attributes.ts';
import { currentCapture, truncate } from './content.ts';
import { mintRunId, runScope } from './run.ts';
import { SDK_NAME, SDK_VERSION } from './version.ts';

/**
 * The instrumentation scope our own annotation spans are created under.
 *
 * It is the SDK's name and version, not a third pair: the scope on a span and
 * the `octic.sdk.*` pair on its resource then cannot disagree about who wrote
 * it, and the exporter's foreign-span test (`redacting-exporter.ts`) is reading
 * the same contract-owned vocabulary that produced them. Both were `'0.0.0'`
 * literals until the public-surface pass, which meant every span this SDK ever
 * produced claimed a version that could not identify a release.
 */
export const TRACER_NAME = SDK_NAME;
export const TRACER_VERSION = SDK_VERSION;

/**
 * What a span touched: a datastore, another service, an external tool. The
 * governance product needs this per span, not per run — "this agent read the
 * transactions store" is a different statement from "this agent ran".
 */
export interface Target {
  name: string;
  type?: 'datastore' | 'service' | 'tool';
  /** The graph join key, so a policy can be evaluated against what was touched. */
  assetRef?: string;
}

export interface EntityOptions {
  name: string;
  /** Recorded as-is. Pass the real arguments; see the note above. */
  input?: unknown;
  target?: Target;
}

export interface ToolOptions extends EntityOptions {
  /**
   * What kind of thing the *model* called — `function`, `extension` or
   * `datastore`. Defaults to `function`, which is what `withTool()` wraps.
   *
   * Deliberately not derived from `target.type`. That answers a different
   * question — what the tool reached, which is the asset-graph one — and
   * feeding it here is what made our spans say `service` where the Vercel AI
   * SDK says `function` for the same call.
   */
  toolType?: string;
}

export interface WorkflowOptions extends EntityOptions {
  /** Supply one to correlate with an id the application already minted. */
  runId?: string;
}

/** Attributes have to be primitives, and an unbounded blob is nobody's friend. */
const MAX_SERIALIZED = 8192;

/**
 * Our own content is the one kind we can decline to produce rather than produce
 * and then strip. Worth doing: serializing an 8KB object costs real CPU, and a
 * value that was never created cannot escape through a bug in the exporter.
 *
 * Above `none` the raw value is serialized here and the exporter applies the
 * capture level, so the transform lives in exactly one place.
 */
const captureContent = (value: unknown): string | undefined =>
  currentCapture() === 'none' ? undefined : serialize(value);

const serialize = (value: unknown): string => {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    // lib.d.ts types `JSON.stringify` as returning `string`. It returns
    // `undefined` for `undefined`, a function or a symbol, so the check is load
    // -bearing and the rule is reading a declaration that is wrong.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (text === undefined) return String(value);
    return truncate(text, MAX_SERIALIZED, '…[truncated]');
  } catch {
    return '[unserializable]';
  }
};

const contentAttribute = (key: string, value: unknown): Attributes => {
  if (value === undefined) return {};
  const captured = captureContent(value);
  return captured === undefined ? {} : { [key]: captured };
};

const targetAttributes = (target: Target | undefined): Attributes =>
  target === undefined
    ? {}
    : {
        [ATTR_OCTIC_TARGET_NAME]: target.name,
        ...(target.type === undefined ? {} : { [ATTR_OCTIC_TARGET_TYPE]: target.type }),
        ...(target.assetRef === undefined
          ? {}
          : { [ATTR_OCTIC_TARGET_ASSET_REF]: target.assetRef }),
      };

/**
 * Which attribute carries the name and the input, per span kind.
 *
 * There used to be one `octic.entity.name` for all three. It duplicated
 * `gen_ai.tool.name` and `gen_ai.data_source.id` on two of them and reinvented
 * `gen_ai.workflow.name` on the third, so it is gone: each kind writes its
 * natural semantic convention, and a consumer asking "what is this span called"
 * resolves the `entity_name` field through the contract's alias table rather
 * than branching on the operation.
 */
interface EntityKeys {
  name: string;
  input: string;
}

/**
 * Records a customer's failure on the span without ever becoming one.
 *
 * `recordException` is not safe to call on an arbitrary thrown value. Given
 * something with no `code`, `name` or `message` it falls through to
 * `` diag.warn(`Failed to record an exception ${exception}`) `` — and a thrown
 * `Symbol` in that template literal raises `TypeError: Cannot convert a Symbol
 * value to a string`. That TypeError would then replace the customer's own
 * thrown value on the way out of the `catch`, which is the exact substitution
 * this package promises never to make. JavaScript permits throwing anything;
 * this has to survive all of it.
 *
 * `String(error)` is safe for a Symbol specifically — `String()` is the one
 * conversion the language allows — but it is not safe for an object with a
 * throwing `toString`, so the whole thing is wrapped rather than only the first
 * call.
 */
const recordFailure = (span: Span, error: unknown): void => {
  try {
    span.recordException(error as Error);
  } catch (recordingFailure) {
    diag.warn('octic-telemetry: could not record the exception on the span', recordingFailure);
  }

  try {
    const message = error instanceof Error ? error.message : String(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message });
  } catch {
    /** The code is what a consumer branches on; losing the message is survivable. */
    try {
      span.setStatus({ code: SpanStatusCode.ERROR });
    } catch {
      /* Nothing left to try, and the customer's error is still on its way out. */
    }
  }
};

const runEntity = <T>(
  operation: string,
  keys: EntityKeys,
  attributes: Attributes,
  { name, input, target }: EntityOptions,
  fn: () => Promise<T>,
): Promise<T> =>
  trace.getTracer(TRACER_NAME, TRACER_VERSION).startActiveSpan(
    `${operation} ${name}`,
    {
      attributes: {
        ...attributes,
        ...targetAttributes(target),
        [ATTR_GEN_AI_OPERATION_NAME]: operation,
        [keys.name]: name,
        ...contentAttribute(keys.input, input),
      },
    },
    async span => {
      try {
        const result = await fn();
        // `T` is unconstrained, so the checker sees no overlap with `undefined`
        // — but the common call is `withTool(opts, async () => { … })` with no
        // return, where `T` is `void` and `result` is `undefined` at runtime.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        const output = result === undefined ? undefined : captureContent(result);
        if (output !== undefined) {
          span.setAttribute(ATTR_OCTIC_ENTITY_OUTPUT, output);
        }
        return result;
      } catch (error) {
        recordFailure(span, error);
        /**
         * The customer's error, unchanged — same object, same stack, same
         * `cause`. Recording it is telemetry and telemetry is never allowed to
         * alter it. The `finally` below ends the span before this rethrow
         * reaches the caller, so their own `catch` can already read it.
         */
        throw error;
      } finally {
        span.end();
      }
    },
  );

/**
 * One unit of agent work — the root span the LLM calls nest under. This is the
 * span that makes a run visible as a run.
 *
 * Also opens the run scope, so every span underneath carries the run id whether
 * or not it is a direct child, and whoever created it.
 */
export const withWorkflow = <T>(options: WorkflowOptions, fn: () => Promise<T>): Promise<T> => {
  const id = options.runId ?? mintRunId(options.name);
  return runScope.with({ id }, () =>
    runEntity(
      GEN_AI_OPERATION_NAME_VALUE_INVOKE_WORKFLOW,
      { name: ATTR_GEN_AI_WORKFLOW_NAME, input: ATTR_OCTIC_ENTITY_INPUT },
      {},
      options,
      fn,
    ),
  );
};

/** One tool execution. Plain application code, invisible to instrumentation. */
export const withTool = <T>(options: ToolOptions, fn: () => Promise<T>): Promise<T> =>
  runEntity(
    GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
    { name: ATTR_GEN_AI_TOOL_NAME, input: ATTR_OCTIC_ENTITY_INPUT },
    { [ATTR_GEN_AI_TOOL_TYPE]: options.toolType ?? GEN_AI_TOOL_TYPE_VALUE_FUNCTION },
    options,
    fn,
  );

/**
 * One retrieval — a vector search, a document lookup, anything that fetched
 * context for the model. `retrieval` is a real `gen_ai.operation.name` value, so
 * this span needs no invented vocabulary; only the asset reference is ours.
 *
 * The query goes on `gen_ai.retrieval.query.text` rather than the generic entity
 * input, because a retrieval query genuinely is text. The result does NOT go on
 * the matching `gen_ai.retrieval.documents`: this wrapper returns whatever the
 * application returns, and calling that "documents" would assert a shape nobody
 * validates. It stays on `octic.entity.output`, which is honest about being
 * arbitrary.
 */
export const withRetrieval = <T>(options: EntityOptions, fn: () => Promise<T>): Promise<T> =>
  runEntity(
    GEN_AI_OPERATION_NAME_VALUE_RETRIEVAL,
    {
      name: ATTR_GEN_AI_DATA_SOURCE_ID,
      /**
       * The semconv key says `query.text`, so it only gets text. Hand it an
       * object and it would carry `{"query":"..."}` — a serialized structure
       * under a name that promises a string, which is the same lie we declined
       * to tell with `gen_ai.retrieval.documents`. Callers that pass a plain
       * query get the semantic convention; callers that pass a structure get
       * the honest generic key.
       */
      input:
        typeof options.input === 'string'
          ? ATTR_GEN_AI_RETRIEVAL_QUERY_TEXT
          : ATTR_OCTIC_ENTITY_INPUT,
    },
    {},
    options,
    fn,
  );
