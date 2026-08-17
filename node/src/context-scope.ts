/**
 * The one pattern this package is built out of.
 *
 * Identity, agent, run id and prompt template are all the same thing: knowledge
 * only the application has, scoped to a region of execution, that has to end up
 * on spans somebody else created. The mechanism is always
 *
 *   put a value on the OTel Context  ->  SpanProcessor.onStart reads it  ->  attributes
 *
 * and `onStart` fires for every span the tracer provider makes, including spans
 * from instrumentation that has never heard of us. That is the whole
 * architecture, so it is worth having exactly once.
 *
 * The alternative — a wrapper span per concept — would work but adds a row to
 * the waterfall for every piece of metadata, and cannot attach anything to a
 * span that instrumentation opened and closed on its own.
 */
import { context, createContextKey, type Attributes, type Context } from '@opentelemetry/api';

export interface ScopeDefinition<T> {
  /** Context key name. Namespaced, since the Context is shared with everyone. */
  key: string;
  toAttributes: (value: T) => Attributes;
  /**
   * How a nested `with()` combines with an enclosing one. Omit to replace.
   *
   * Identity merges — an outer middleware sets the conversation and an inner
   * call adds a business id without clobbering it. Agent and prompt replace,
   * because an inner declaration means "this part is different".
   */
  merge?: (existing: T, incoming: T) => T;
}

export interface ContextScope<T> {
  from: (ctx: Context) => T | undefined;
  contextWith: (ctx: Context, value: T) => Context;
  /** Runs `fn` with `value` attached to every span started inside it. */
  with: <R>(value: T, fn: () => R) => R;
  attributesFrom: (ctx: Context) => Attributes | undefined;
}

export const createContextScope = <T>({
  key,
  toAttributes,
  merge,
}: ScopeDefinition<T>): ContextScope<T> => {
  const contextKey = createContextKey(key);

  const from = (ctx: Context): T | undefined => ctx.getValue(contextKey) as T | undefined;

  const contextWith = (ctx: Context, value: T): Context => {
    const existing = from(ctx);
    return ctx.setValue(contextKey, existing !== undefined && merge ? merge(existing, value) : value);
  };

  return {
    from,
    contextWith,
    with: (value, fn) => context.with(contextWith(context.active(), value), fn),
    attributesFrom: ctx => {
      const value = from(ctx);
      return value === undefined ? undefined : toAttributes(value);
    },
  };
};
