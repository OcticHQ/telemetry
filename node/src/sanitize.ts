/**
 * The attribute pass applied to everything *this SDK* stamps onto a span.
 *
 * Not a crash guard — measured, and worth stating so the next person does not
 * re-derive it. `Span.setAttribute` validates with `isAttributeValue` and, on a
 * value it will not take, emits a `diag.warn` and returns; a `Symbol`, a
 * `BigInt`, a function, a plain object and a mixed array all vanish without
 * throwing anything. The problem is the vanishing, not a throw: a consumer who
 * put a business id in `withIdentity()` and never sees it on a span has no way
 * to find out why, and OTel's warning names the key without naming us.
 *
 * So this drops the same values OTel would, and *counts* them, and says which
 * key under `OCTIC_TELEMETRY_DEBUG=1`. Silence is the failure this package
 * exists to remove; a guard that produces silence of its own is the same bug
 * wearing our name.
 *
 * Deliberately scoped to maps we author — the processor's per-span defaults and
 * each context scope's output. Attributes a customer or foreign instrumentation
 * put on their own span are not ours to rewrite.
 */
import { diag, type Attributes, type AttributeValue } from '@opentelemetry/api';
import { activePolicy, truncate } from './content.ts';
import { count } from './counters.ts';

/**
 * Matches OTel's own `spanAttributeCountLimit` default
 * (`sdk-trace/build/src/TracerProvider.js`). Ours applies per map rather than
 * per span, so it bounds what one `setAttributes` call can add; the SDK still
 * enforces the real per-span total underneath.
 */
const MAX_ATTRIBUTES = 128;

/**
 * Long enough for any key a convention defines, short enough that a key built
 * by string concatenation from customer data cannot become the payload.
 * Dropped rather than truncated: a truncated key is a different key, and a
 * different key that silently collides with a real one is worse than no key.
 */
const MAX_KEY_LENGTH = 255;

const isPrimitive = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'boolean' || isFiniteNumber(value);

/**
 * `NaN` and `Infinity` are `typeof 'number'`, so OTel accepts them and the JSON
 * serializer then writes `null`. A number that arrives as `null` is worse than
 * an absent attribute, because it reads as "measured, and empty".
 */
const isFiniteNumber = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * OTel takes an array only when its elements share one primitive type; `null`
 * and `undefined` are holes and do not decide the type. A mixed array is
 * dropped whole — there is no partial form of it that means the same thing.
 */
const isHomogeneousArray = (value: unknown[]): boolean => {
  let kind: string | undefined;
  for (const element of value) {
    if (element === null || element === undefined) continue;
    if (!isPrimitive(element)) return false;
    kind ??= typeof element;
    if (typeof element !== kind) return false;
  }
  return true;
};

const capStrings = (value: AttributeValue, limit: number): AttributeValue => {
  if (typeof value === 'string') return truncate(value, limit, '…[truncated]');
  if (!Array.isArray(value)) return value;
  return value.map(element =>
    typeof element === 'string' ? truncate(element, limit, '…[truncated]') : element,
  ) as AttributeValue;
};

const drop = (key: string, why: string): void => {
  count('attributesDropped');
  diag.debug(`octic-telemetry: dropped attribute ${key} — ${why}`);
};

/**
 * Returns a new map. `dropped` is returned as well as counted so a caller can
 * report per-span rather than only per-process.
 */
export const sanitizeAttributes = (
  source: Attributes,
): {
  attributes: Attributes;
  dropped: number;
} => {
  const { maxLength } = activePolicy();
  const attributes: Attributes = {};
  let dropped = 0;
  let kept = 0;

  /**
   * Widened on purpose. The declared type says these are already
   * `AttributeValue`s; the values reach us from application JavaScript through
   * an `Identity` or `Agent` a `.js` consumer built with no checker at all, so
   * the runtime population is `unknown` and every check below is load-bearing.
   */
  const entries: [string, unknown][] = Object.entries(source);

  for (const [key, value] of entries) {
    if (value === undefined || value === null) continue;

    if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
      dropped += 1;
      /** Truncated in the message too — the oversized key is the payload here. */
      drop(truncate(key, 64, '…'), `the key is empty or over ${MAX_KEY_LENGTH} characters`);
      continue;
    }

    if (kept >= MAX_ATTRIBUTES) {
      dropped += 1;
      drop(key, `more than ${MAX_ATTRIBUTES} attributes in one map`);
      continue;
    }

    const usable = Array.isArray(value) ? isHomogeneousArray(value) : isPrimitive(value);
    if (!usable) {
      dropped += 1;
      drop(key, `${describe(value)} is not something OpenTelemetry can carry`);
      continue;
    }

    attributes[key] = capStrings(value as AttributeValue, maxLength);
    kept += 1;
  }

  return { attributes, dropped };
};

/** Names the type without stringifying the value, which for a Symbol throws. */
const describe = (value: unknown): string => {
  if (Array.isArray(value)) return 'a mixed array';
  if (typeof value === 'number') return 'a non-finite number';
  return `a ${typeof value}`;
};
