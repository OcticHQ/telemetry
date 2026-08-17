/**
 * The enforcement point for log content — and the half a span-only redactor
 * misses entirely.
 *
 * `@opentelemetry/instrumentation-openai` puts *all* message content on the logs
 * signal and none on spans; the AI SDK does the reverse. Scrub one and a
 * customer switching stacks starts exporting prompts with no visible change.
 *
 * Unlike spans, mutation here is the sanctioned path — sdk-logs says so:
 *
 *   "A LogRecordProcessor may freely modify logRecord for the duration of the
 *    OnEmit call."
 *
 * so this edits in place and must be registered *before* the exporting
 * processor: MultiLogRecordProcessor calls onEmit in array order.
 *
 * `onEmit` also receives the Context, so the per-run override is read straight
 * from the scope with no attribute round-trip.
 */
import { context, type Context } from '@opentelemetry/api';
import type { LogRecordProcessor, SdkLogRecord } from '@opentelemetry/sdk-logs';
import { ATTR_OCTIC_REDACTED } from './attributes.ts';
import {
  applyCapture,
  applyCaptureToBody,
  contentScope,
  isContent,
  type ContentPolicy,
} from './content.ts';

export class RedactingLogRecordProcessor implements LogRecordProcessor {
  private readonly policy: ContentPolicy;

  constructor(policy: ContentPolicy) {
    this.policy = policy;
  }

  onEmit(record: SdkLogRecord, ctx?: Context): void {
    const capture = contentScope.from(ctx ?? context.active())?.capture ?? this.policy.capture;

    if (capture === 'full' && this.policy.redact === undefined) return;

    /**
     * `octic.redacted` is raised only where something actually changed.
     *
     * It used to go on whenever a body existed at all, which meant a record
     * that passed through untouched still arrived claiming content had been
     * withheld — the exact confusion the flag exists to prevent, inverted. The
     * span path compares before and after; so does this now.
     */
    let redacted = false;

    const body = record.body;
    if (body !== undefined) {
      const kept = applyCaptureToBody(body, capture, this.policy);
      if (kept !== body) {
        record.setBody(kept as never);
        redacted = true;
      }
    }

    /**
     * Attributes too: content leaks onto log records as attributes as well as
     * bodies, and a record is always foreign — we emit none of our own.
     */
    for (const [key, value] of Object.entries(record.attributes)) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        continue;
      }
      if (!isContent(key, value, true, this.policy)) continue;
      const kept = applyCapture(value, key, capture, this.policy);
      if (kept === value) continue;
      /**
       * Emptied rather than deleted: `SdkLogRecord` exposes no way to remove an
       * attribute, so the closest available thing to "gone" is a value with
       * nothing in it. This diverges from the span path, which drops the key —
       * deliberately, and not worth papering over with a fake key elsewhere.
       */
      record.setAttribute(key, kept ?? '');
      redacted = true;
    }

    if (redacted) record.setAttribute(ATTR_OCTIC_REDACTED, true);
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
