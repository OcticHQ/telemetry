/**
 * What leaves the customer's process, and in what form.
 *
 * Message content is the one thing here that is unambiguously the customer's
 * data rather than telemetry about their data — prompts, tool arguments, model
 * output. Under a governance framing none of it is required: the agent, the run,
 * the prompt *name*, the token counts and the asset refs answer every question
 * the product asks, and all of them survive with content switched off.
 *
 * So the default is `none`. This SDK writes to a spool on the host's own disk,
 * and what it captures sits there at rest until a reader collects it; content
 * reaches that disk because someone chose `metadata` or `full`, per process or
 * per run, not because they installed a package.
 *
 * Three places produce it, measured from receiver/captured/:
 *
 *   our annotation spans   octic.entity.input / .output          preventable at source
 *   foreign span attributes gen_ai.input.messages, ...           not preventable
 *   log records            whole message bodies, replayed        not preventable
 *
 * We cannot stop foreign instrumentation writing content; we can stop it
 * leaving. That makes the export path the enforcement point, not the call site.
 */
import { createHash } from 'node:crypto';
import { context, type AttributeValue } from '@opentelemetry/api';
import { createContextScope } from './context-scope.ts';
import {
  ATTR_OCTIC_CONTENT_CAPTURE,
  CONTENT_HEURISTIC_MIN_LENGTH,
  CONTENT_KEYS,
  CONTENT_PATTERNS,
  RESOURCE_DENY,
} from './attributes.ts';

/**
 * `none`     drop it. Token counts, latency, model, and every governance
 *            attribute are unaffected — the product works at this setting.
 * `metadata` replace with length + hash. Enough to answer "is this the same
 *            system prompt as last run" without storing a byte of it.
 * `full`     send it, after `redact` and `maxLength`.
 */
export type ContentCapture = 'none' | 'metadata' | 'full';

export interface ContentOptions {
  /** Defaults to `none` — see the note at the top of the file. */
  capture?: ContentCapture;
  /**
   * Last chance to scrub a value the customer knows the shape of better than we
   * do. Runs only under `full`. Return undefined to drop the value.
   *
   * MUST NOT throw — and if it does we drop the value rather than falling
   * through to the original, because a broken redactor must fail closed.
   */
  redact?: (value: string, key: string) => string | undefined;
  /** Hard cap under `full`. Default 4096. */
  maxLength?: number;
  /** Exact keys to treat as non-content even if they look like content. */
  allowAttributes?: string[];
  /** Extra keys to treat as content — for instrumentation we have not measured. */
  contentAttributes?: string[];
}

export interface ContentPolicy {
  capture: ContentCapture;
  redact?: (value: string, key: string) => string | undefined;
  maxLength: number;
  allow: Set<string>;
  extra: Set<string>;
}

export const resolvePolicy = (options: ContentOptions = {}): ContentPolicy => ({
  capture: options.capture ?? 'none',
  ...(options.redact === undefined ? {} : { redact: options.redact }),
  maxLength: options.maxLength ?? 4096,
  allow: new Set(options.allowAttributes ?? []),
  extra: new Set(options.contentAttributes ?? []),
});

/**
 * The policy init() settled on, readable from the annotations without threading
 * it through every call. Module state, like the `initialized` guard next to it —
 * one process has one policy.
 *
 * The pre-init value is the same default, which is worth stating plainly: an
 * annotation that runs before init() serializes its input. That is reachable
 * only with no provider registered, so nothing exports it, but it stops being
 * harmless the day the default goes back to `none`.
 */
let active: ContentPolicy = resolvePolicy();

export const setActivePolicy = (policy: ContentPolicy): void => {
  active = policy;
};

export const activePolicy = (): ContentPolicy => active;

/** The level in effect right here: a `withContent()` override, else the policy. */
export const currentCapture = (): ContentCapture =>
  contentScope.from(context.active())?.capture ?? active.capture;

/**
 * Per-run override, on the same Context mechanism as identity and prompt.
 *
 * Stamped onto every span by the processor — including foreign ones, which is
 * the point — read back at export, and stripped before the span leaves. Lets a
 * customer run `none` globally and open up one low-risk agent, or the inverse.
 */
export const contentScope = createContextScope<{ capture: ContentCapture }>({
  key: 'octic.content',
  toAttributes: ({ capture }) => ({ [ATTR_OCTIC_CONTENT_CAPTURE]: capture }),
});

export const withContent = contentScope.with;

/**
 * The capture level the processor resolved for a span, keyed by the span object
 * itself rather than by an attribute on it.
 *
 * The attribute is still stamped — the contract declares it, and a host SDK that
 * copies spans before export needs something to fall back on — but it cannot be
 * the authority, because anything that can write a span attribute can write that
 * one. A caller passing `octic.content.capture: 'full'` in span options used to
 * reopen a process configured `none`, from application code that had no idea the
 * key existed.
 *
 * A WeakMap closes it because the identity is not forgeable: the SDK hands the
 * exporter the same object the processor saw, and nothing on the wire can point
 * at an entry it did not create. Weak so a dropped span is still collectable.
 *
 * What is recorded is the *override* — what `withContent()` asked for at this
 * span — and not the level the processor resolved. Those are different claims,
 * and conflating them made the processor's idea of the default (module state)
 * silently outrank the policy the exporter was constructed with. An entry with
 * no override still means something: it says our processor saw this span, so the
 * exporter knows the stamped attribute is redundant rather than authoritative.
 */
interface SpanCapture {
  /** undefined when no `withContent()` scope was open — fall back to the policy. */
  capture: ContentCapture | undefined;
}

const spanCapture = new WeakMap<object, SpanCapture>();

export const recordSpanCapture = (span: object, capture: ContentCapture | undefined): void => {
  spanCapture.set(span, { capture });
};

export const spanCaptureFor = (span: object): SpanCapture | undefined => spanCapture.get(span);

/**
 * The keys, the shape patterns and the length bound all come from
 * `contract/attributes.yaml` now — this file decides what to *do* about content,
 * not what content is. The classification has to be shared: the same list has to
 * reach ingest, which redacts for customers who do not run this SDK at all, and
 * the assertions, which are worthless if they check a shorter list than the
 * exporter enforces.
 *
 * A denylist alone fails open the day a vendor ships a key we have never seen —
 * the same silent-failure class as the missing loader hook, inverted into a
 * leak. An allowlist of non-content keys fails the other way and drops every new
 * token-count field. So all three together: known keys, shape patterns, and a
 * length bound on anything authored by a scope we do not control.
 */
const CONTENT_KEY_SET = new Set(CONTENT_KEYS);

export const isContent = (
  key: string,
  value: AttributeValue | undefined,
  foreignScope: boolean,
  policy: ContentPolicy,
): boolean => {
  if (policy.allow.has(key)) return false;
  if (CONTENT_KEY_SET.has(key) || policy.extra.has(key)) return true;
  if (CONTENT_PATTERNS.some(pattern => pattern.test(key))) return true;
  return foreignScope && textLength(value) > CONTENT_HEURISTIC_MIN_LENGTH;
};

/**
 * How much free text a value carries, for the length bound.
 *
 * Arrays count too. OTel attributes are primitives *or arrays of them*, and
 * several stacks write `gen_ai.input.messages` as `string[]` — measuring only
 * bare strings meant a foreign span could carry the entire conversation in an
 * array under a key we had never seen and sail past the heuristic.
 */
const textLength = (value: AttributeValue | undefined): number => {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) {
    return value.reduce<number>(
      (total, entry) => total + (typeof entry === 'string' ? entry.length : 0),
      0,
    );
  }
  return 0;
};

const summarize = (value: unknown): string => {
  const text =
    typeof value === 'string'
      ? value
      : // Same lib.d.ts lie as annotations.ts: `JSON.stringify` is declared to
        // return `string` and returns `undefined` for `undefined`, a function
        // or a symbol. Dropping the `??` here would put "undefined" — or throw
        // — into a redaction summary.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        (JSON.stringify(value) ?? String(value));
  return JSON.stringify({
    redacted: true,
    chars: text.length,
    sha256: createHash('sha256').update(text).digest('hex').slice(0, 16),
  });
};

/**
 * Returns the value to send, or undefined to drop the key entirely.
 *
 * Fails closed in every direction: an unexpected capture value, a throwing
 * redactor and a redactor returning undefined all end in no content leaving.
 */
export const applyCapture = (
  value: AttributeValue,
  key: string,
  capture: ContentCapture,
  policy: ContentPolicy,
): AttributeValue | undefined => {
  if (capture === 'metadata') return summarize(value);
  if (capture !== 'full') return undefined;

  if (typeof value === 'string') return redactString(value, key, policy);

  /**
   * Arrays element by element, rather than the blanket pass-through this used
   * to do for everything non-string.
   *
   * `full` is the setting a customer picks *because* they are relying on the
   * redactor, so handing an array straight to the wire was the one shape where
   * the redactor and `maxLength` both silently did nothing — and it is a shape
   * real instrumentation writes. If any element redacts away entirely the whole
   * attribute goes: a sparse array is a hole a consumer cannot interpret, and
   * failing closed is the rule everywhere else here.
   */
  if (Array.isArray(value)) {
    const kept: (string | number | boolean | null | undefined)[] = [];
    for (const entry of value) {
      if (typeof entry !== 'string') {
        kept.push(entry);
        continue;
      }
      const redacted = redactString(entry, key, policy);
      if (redacted === undefined) return undefined;
      kept.push(redacted);
    }
    return kept as AttributeValue;
  }

  return value;
};

/**
 * Cuts a string to `limit` UTF-16 units without splitting a surrogate pair.
 *
 * `slice` counts units, not characters, so cutting mid-pair leaves a lone high
 * surrogate — which is not valid UTF-8, and the exporter serializes attributes
 * as JSON on the way out. One emoji in a prompt at the wrong offset was enough
 * to put an unencodable character on the wire.
 */
export const truncate = (value: string, limit: number, marker: string): string => {
  if (value.length <= limit) return value;
  const cut = limit > 0 && isHighSurrogate(value.charCodeAt(limit - 1)) ? limit - 1 : limit;
  return `${value.slice(0, cut)}${marker}`;
};

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

/** The single-value `full` pass: customer redactor, then the hard length cap. */
const redactString = (value: string, key: string, policy: ContentPolicy): string | undefined => {
  try {
    const redacted = policy.redact === undefined ? value : policy.redact(value, key);
    if (redacted === undefined) return undefined;
    return truncate(redacted, policy.maxLength, '…[truncated]');
  } catch {
    return '[redaction-failed]';
  }
};

/** Log bodies are arbitrary AnyValue, so this mirrors applyCapture for them. */
export const applyCaptureToBody = (
  body: unknown,
  capture: ContentCapture,
  policy: ContentPolicy,
): unknown => {
  if (capture === 'metadata') return { redacted: true, ...JSON.parse(summarize(body)) };
  if (capture !== 'full') return { redacted: true };
  if (typeof body !== 'string') return body;
  return applyCapture(body, 'log.body', 'full', policy) ?? { redacted: true };
};

/**
 * Resource attributes nobody asked for. Traceloop's default detectors ship the
 * full argv, which is a well-known place for secrets in real deployments, plus
 * host and process identity we have no use for. Scrubbed at the same chokepoint
 * because it is the same problem: data leaving that nobody chose to send.
 *
 * The list is the contract's, for the same reason as the content keys: a
 * customer without our SDK gets this scrub at ingest instead, off one list.
 */
const RESOURCE_DENY_SET = new Set(RESOURCE_DENY);

export const isDeniedResourceAttribute = (key: string): boolean => RESOURCE_DENY_SET.has(key);
