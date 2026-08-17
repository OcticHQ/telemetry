/**
 * The mechanism this whole PoC exists to test.
 *
 * `SpanProcessor.onStart` fires for *every* span the tracer provider creates —
 * including spans created by instrumentation that has never heard of this
 * package. It receives the Context the span was started in, which is where the
 * scopes below put their values.
 *
 * That is what makes "bring your own instrumentation" viable: we do not need to
 * patch, wrap or even know about OpenLLMetry, @opentelemetry/instrumentation-openai
 * or the Vercel AI SDK. We only need their spans to be created through the
 * global tracer provider — and enriching them is then a hook the SDK already
 * offers us.
 *
 * Four scopes now share one loop. That the list grew from one to four without
 * the mechanism changing is the evidence that it generalises: identity was not
 * a special case, it was the first instance of the pattern.
 */
import type { Attributes, Context } from '@opentelemetry/api';
import type { Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { agentScope } from './agent.ts';
import { ATTR_OCTIC_CONTENT_CAPTURE } from './attributes.ts';
import { activePolicy, contentScope, recordSpanCapture } from './content.ts';
import type { ContextScope } from './context-scope.ts';
import { identityScope } from './identity.ts';
import { promptScope } from './prompt.ts';
import { runScope } from './run.ts';

/**
 * Listed explicitly rather than self-registered on creation. A registry
 * populated by import side effects would depend on every scope module having
 * been loaded before the first span starts — silently stamping nothing when it
 * has not, which is exactly the class of failure this package exists to remove.
 */
type AttributeSource = Pick<ContextScope<unknown>, 'attributesFrom'>;

/**
 * `contentScope` is deliberately not in this list, though it used to be. It
 * carries policy rather than data, so it is resolved separately below — always,
 * and not only when a `withContent()` override happens to be open. See `onStart`.
 */
const SCOPES: AttributeSource[] = [identityScope, agentScope, runScope, promptScope];

export class IdentitySpanProcessor implements SpanProcessor {
  /**
   * Attributes that would normally live on the resource, applied per span
   * instead.
   *
   * Needed when a host SDK owns the tracer provider: the resource is then
   * *theirs*, and everything init() put on ours — the agent, the environment,
   * which SDK produced this — never reaches a span. Measured with OpenLLMetry,
   * where the agent came through empty until this existed.
   *
   * Applied before the context scopes so a per-run `withAgent()` still wins.
   */
  private readonly defaults: Attributes;

  constructor(defaults: Attributes = {}) {
    this.defaults = defaults;
  }

  onStart(span: Span, parentContext: Context): void {
    span.setAttributes(this.defaults);

    for (const scope of SCOPES) {
      const attributes = scope.attributesFrom(parentContext);
      if (attributes) span.setAttributes(attributes);
    }

    /**
     * The capture level, recorded off-span as well as on it, for every span
     * rather than only when an override is open.
     *
     * Both halves matter. Recording against the span object is what makes the
     * level unforgeable at export — an attribute is writable by anyone who can
     * write attributes, and a caller passing `octic.content.capture: 'full'` in
     * span options used to reopen a process configured `none`. Stamping
     * unconditionally closes the same hole from the other side: span-option
     * attributes are applied when the span is constructed and `onStart` runs
     * after, so writing here overwrites whatever the caller supplied rather than
     * leaving it in place whenever no scope happens to be open.
     *
     * Only the override goes in the map. The resolved level would make this
     * processor's view of the default outrank the policy the exporter holds,
     * which are not the same object in every arrangement; the exporter owns the
     * fallback. The attribute stays because the contract declares it and a host
     * SDK that copies spans before export loses the map entry — and it is
     * stripped before the span leaves either way.
     */
    const override = contentScope.from(parentContext)?.capture;
    recordSpanCapture(span, override);
    span.setAttribute(ATTR_OCTIC_CONTENT_CAPTURE, override ?? activePolicy().capture);
  }

  /** Enrichment only — export is somebody else's processor. */
  onEnd(): void {}

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
}
