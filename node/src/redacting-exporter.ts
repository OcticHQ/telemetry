/**
 * The enforcement point for span content.
 *
 * Why the exporter and not `SpanProcessor.onEnd`, which looks like the obvious
 * place: `ReadableSpan` declares every field readonly, including `attributes`,
 * and the SDK hands *the same instance* to every processor and exporter. Editing
 * it in onEnd is a type violation and action-at-a-distance on anyone else's
 * pipeline. So we copy.
 *
 * The second reason is the decisive one. Under `initWithExternalProvider()` the
 * host SDK owns the provider and the processor list is theirs to arrange; the
 * exporter is the one surface that is still ours in *both* entry modes. One
 * implementation covers both. `OcticSpanProcessor` stays enrichment-only.
 */
import type { ExportResult } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { Resource } from '@opentelemetry/resources';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { diag, type Attributes } from '@opentelemetry/api';
import { count } from './counters.ts';
import {
  ATTR_OCTIC_CONTENT_CAPTURE,
  ATTR_OCTIC_REDACTED,
  OCTIC_SDK_NAME_VALUES,
} from './attributes.ts';
import {
  applyCapture,
  isContent,
  isDeniedResourceAttribute,
  spanCaptureFor,
  type ContentCapture,
  type ContentPolicy,
} from './content.ts';

/**
 * The key the status message is classified under. Not a real attribute — the
 * message travels in its own field — but `applyCapture` takes a key so a
 * customer redactor can branch on where a value came from, and "status.message"
 * is what that value is.
 */
const STATUS_MESSAGE_KEY = 'status.message';

/**
 * The instrumentation scopes that are ours, so everything else is foreign.
 *
 * Foreign is the interesting half: a span we did not create can carry an entire
 * conversation in a bare string under a key nobody has named, so the content
 * heuristic runs on those and not on ours. Getting the test wrong in the
 * permissive direction is therefore a leak, which is why the vocabulary is the
 * contract's `octic.sdk.name` enum rather than a literal — one SDK renaming
 * itself cannot silently exempt another's spans.
 *
 * Every member, not just this SDK's own, because the rule is "did one of our
 * SDKs make this", and that sentence should read the same in every language
 * that implements it.
 */
const OUR_SCOPES: ReadonlySet<string> = new Set(OCTIC_SDK_NAME_VALUES);

/**
 * Which capture level applies to this span, in order of how much we trust it.
 *
 * An entry in the map means our processor started this span, so the question is
 * settled here: either a `withContent()` override was open, or the policy this
 * exporter was built with applies. The stamped attribute is not consulted at
 * all in that case — it is writable by anything that can write an attribute,
 * which is the hole this exists to close.
 *
 * The attribute is the fallback only when there is no entry, which means a host
 * SDK copied the span between processor and exporter. An unrecognised value is
 * still safe: `applyCapture` treats anything that is not `metadata` or `full`
 * as "drop", so an unknown level fails closed rather than open.
 */
const resolveCapture = (span: ReadableSpan, policy: ContentPolicy): ContentCapture => {
  const recorded = spanCaptureFor(span);
  if (recorded !== undefined) return recorded.capture ?? policy.capture;

  const stamped = span.attributes[ATTR_OCTIC_CONTENT_CAPTURE];
  return typeof stamped === 'string' ? (stamped as ContentCapture) : policy.capture;
};

/** One resource serves every span from a process; scrub it once. */
const scrubbedResources = new WeakMap<Resource, Resource>();

const scrubResource = (resource: Resource): Resource => {
  const cached = scrubbedResources.get(resource);
  if (cached !== undefined) return cached;

  const entries = Object.entries(resource.attributes).filter(
    ([key]) => !isDeniedResourceAttribute(key),
  );
  const scrubbed =
    entries.length === Object.keys(resource.attributes).length
      ? resource
      : resourceFromAttributes(Object.fromEntries(entries));

  scrubbedResources.set(resource, scrubbed);
  return scrubbed;
};

export class RedactingSpanExporter implements SpanExporter {
  private readonly inner: SpanExporter;
  private readonly policy: ContentPolicy;

  constructor(inner: SpanExporter, policy: ContentPolicy) {
    this.inner = inner;
    this.policy = policy;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    /**
     * Resource detection can still be in flight. Reading `.attributes` before it
     * settles would materialize a snapshot missing whatever had not resolved —
     * silently, and only on fast-starting processes. The inner exporter would
     * have awaited this itself; we take the resource away from it, so we inherit
     * the obligation.
     */
    const pending = spans.filter(span => span.resource.asyncAttributesPending === true);
    if (pending.length === 0) {
      this.inner.export(this.sanitizeAll(spans), resultCallback);
      return;
    }
    void Promise.all(
      // `?? Promise.resolve()` rather than passing `undefined` into the
      // aggregator: `asyncAttributesPending` being true implies the method
      // exists, but the type does not say so, and `Promise.all` over a
      // possibly-undefined element hides that from the reader.
      pending.map(span => span.resource.waitForAsyncAttributes?.() ?? Promise.resolve()),
    ).then(
      () => {
        this.inner.export(this.sanitizeAll(spans), resultCallback);
      },
      /**
       * A rejecting detector must not cost the batch.
       *
       * Without this handler the rejection went nowhere: the spans were
       * dropped *and* `resultCallback` was never called, so a processor
       * counting in-flight exports waited on a batch that had already been
       * abandoned. Exporting unwaited is the lesser loss — the resource is
       * whatever resolved before the failure, which is the same snapshot the
       * inner exporter would have taken on its own.
       */
      (error: unknown) => {
        diag.warn(
          'octic-telemetry: resource detection failed; exporting with what resolved',
          error,
        );
        this.inner.export(this.sanitizeAll(spans), resultCallback);
      },
    );
  }

  /**
   * Per span, not per batch. A span the copy cannot be built from is one span;
   * letting it throw here would lose every other span in the batch and — since
   * `export` is called from inside the processor — take the throw somewhere
   * nothing can act on it.
   */
  private sanitizeAll(spans: ReadableSpan[]): ReadableSpan[] {
    const sanitized: ReadableSpan[] = [];

    for (const span of spans) {
      try {
        sanitized.push(this.sanitize(span));
      } catch (error) {
        diag.warn('octic-telemetry: a span could not be sanitized; sending it stripped', error);
        try {
          /**
           * Content is the thing that must not leak, so the fallback keeps the
           * span's identity and drops everything that could carry content.
           * `events` is set explicitly rather than inherited: a throwing
           * `events` getter is one of the ways to arrive here, and inheriting
           * it would reach the same getter again at serialization.
           */
          sanitized.push(
            Object.create(span, {
              attributes: { value: {}, enumerable: true },
              events: { value: [], enumerable: true },
              status: { value: { code: span.status.code }, enumerable: true },
            }) as ReadableSpan,
          );
        } catch {
          count('spansDropped');
        }
      }
    }

    return sanitized;
  }

  /**
   * The attribute pass, shared by the span's own attributes and every event's.
   *
   * Returns a new map rather than editing, and reports whether anything was
   * withheld, because the caller has to raise `octic.redacted` on the span even
   * when the thing withheld was three levels down inside an event.
   */
  private sanitizeAttributes(
    source: Attributes,
    foreign: boolean,
    capture: ContentCapture,
  ): { attributes: Attributes; redacted: boolean } {
    const attributes: Attributes = {};
    let redacted = false;

    for (const [key, value] of Object.entries(source)) {
      // Carried on the span only to get the policy here; not something we ship.
      if (key === ATTR_OCTIC_CONTENT_CAPTURE) continue;
      if (value === undefined) continue;

      if (!isContent(key, value, foreign, this.policy)) {
        attributes[key] = value;
        continue;
      }
      const kept = applyCapture(value, key, capture, this.policy);
      if (kept === undefined) {
        redacted = true;
        continue;
      }
      if (kept !== value) redacted = true;
      attributes[key] = kept;
    }

    return { attributes, redacted };
  }

  private sanitize(span: ReadableSpan): ReadableSpan {
    const foreign = !OUR_SCOPES.has(span.instrumentationScope.name);
    const capture = resolveCapture(span, this.policy);

    const { attributes, redacted: attributesRedacted } = this.sanitizeAttributes(
      span.attributes,
      foreign,
      capture,
    );
    let redacted = attributesRedacted;

    /**
     * Events, which is where `recordException` puts `exception.message` and
     * `exception.stacktrace`.
     *
     * These were invisible here until this existed: the old copy rebuilt only
     * `attributes`, so events rode through on the prototype and an error
     * message quoting the prompt left the process at every capture level,
     * including `none`. Event attributes are classified by the same rules as
     * span attributes — the contract lists the two exception keys explicitly,
     * because our own annotation spans are not `foreign` and the length
     * heuristic therefore never fires on them.
     */
    const events = span.events.map(event => {
      const sanitized = this.sanitizeAttributes(event.attributes ?? {}, foreign, capture);
      if (sanitized.redacted) redacted = true;
      return { ...event, attributes: sanitized.attributes };
    });

    /**
     * And the status message, which `withTool()` sets to `error.message` — the
     * same string as the exception event, reached by a different field.
     *
     * Always treated as content: it is free-form text authored by application
     * or vendor code, which is exactly the population the policy governs. The
     * status *code* is untouched, so "this run failed" survives at every level
     * even when what failed does not.
     */
    const status =
      span.status.message === undefined
        ? span.status
        : (() => {
            const kept = applyCapture(
              span.status.message,
              STATUS_MESSAGE_KEY,
              capture,
              this.policy,
            );
            if (kept === span.status.message) return span.status;
            redacted = true;
            return kept === undefined
              ? { code: span.status.code }
              : { code: span.status.code, message: String(kept) };
          })();

    /** So the UI can say "withheld by policy" rather than "this agent sent nothing". */
    if (redacted) attributes[ATTR_OCTIC_REDACTED] = true;

    /**
     * Object.create rather than a literal: `spanContext` is a method, and
     * ReadableSpan gains fields across minor releases. A hand-built copy drops
     * whatever was added and does it quietly.
     */
    return Object.create(span, {
      attributes: { value: attributes, enumerable: true },
      events: { value: events, enumerable: true },
      status: { value: status, enumerable: true },
      resource: { value: scrubResource(span.resource), enumerable: true },
    }) as ReadableSpan;
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}
