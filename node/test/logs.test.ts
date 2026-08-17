/**
 * The logs signal — the half a span-only redactor misses entirely.
 *
 * `@opentelemetry/instrumentation-openai` puts *all* message content on log
 * records and none on spans; the AI SDK does the reverse. Scrub one and a
 * customer switching stacks starts exporting prompts with no visible change.
 *
 * Driven through a real `LoggerProvider` rather than by calling `onEmit` by
 * hand, because the ordering is the mechanism: `MultiLogRecordProcessor` calls
 * `onEmit` in array order and sdk-logs sanctions mutation during that call, so
 * the redactor only works if it sits ahead of the processor that exports. A
 * test that calls `onEmit` directly cannot tell whether that is true.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { context } from '@opentelemetry/api';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';

import { resolvePolicy, withContent, type ContentOptions } from '../src/content.ts';
import { RedactingLogRecordProcessor } from '../src/redacting-log-processor.ts';
import { fakeLogRecord, installContextManager } from './support/harness.ts';

installContextManager();

const FOREIGN_SCOPE = '@vendor/instrumentation-openai';
const CARD = 'my card is 4111 1111 1111 1111';

/**
 * A provider wired the way `init()` wires one: redactor first, exporter second.
 */
const buildLogs = (content: ContentOptions) => {
  const exporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({
    processors: [
      new RedactingLogRecordProcessor(resolvePolicy(content)),
      new SimpleLogRecordProcessor({ exporter }),
    ],
  });
  return { exporter, logger: provider.getLogger(FOREIGN_SCOPE) };
};

const emitted = (content: ContentOptions, body: unknown, attributes: Record<string, string> = {}) => {
  const { exporter, logger } = buildLogs(content);
  logger.emit({ body: body as never, attributes });
  const records = exporter.getFinishedLogRecords();
  assert.equal(records.length, 1, 'exactly one record exported');
  return records[0]!;
};

describe('the body, where instrumentation-openai puts everything', () => {
  it('is replaced wholesale under none', () => {
    const record = emitted({ capture: 'none' }, { content: CARD });
    assert.deepEqual(record.body, { redacted: true });
    assert.ok(!JSON.stringify(record.body).includes('4111'));
  });

  it('is summarized under metadata', () => {
    const record = emitted({ capture: 'metadata' }, { content: CARD });
    assert.equal((record.body as { redacted: boolean }).redacted, true);
    assert.ok(!JSON.stringify(record.body).includes('4111'));
  });

  it('is left alone under full with no redactor', () => {
    assert.deepEqual(emitted({ capture: 'full' }, { content: 'keep me' }).body, {
      content: 'keep me',
    });
  });

  it('is redacted under full when a string body meets a redactor', () => {
    const record = emitted(
      { capture: 'full', redact: value => value.replace(/\b(?:\d[ -]*?){13,16}\b/g, '[card]') },
      CARD,
    );
    assert.equal(record.body, 'my card is [card]');
  });

  it('survives a record with no body at all', () => {
    const record = emitted({ capture: 'none' }, undefined, { 'event.name': 'gen_ai.choice' });
    assert.equal(record.body, undefined);
  });
});

describe('log attributes', () => {
  it('are redacted too, not just the body', () => {
    const record = emitted({ capture: 'none' }, undefined, {
      'gen_ai.input.messages': CARD,
      'event.name': 'gen_ai.user.message',
    });
    assert.equal(record.attributes['gen_ai.input.messages'], '');
    assert.equal(record.attributes['event.name'], 'gen_ai.user.message');
  });

  /**
   * Emptied rather than deleted, because `SdkLogRecord` exposes no way to
   * remove an attribute. This diverges from the span path, which drops the key
   * outright — pinned here so a future reader does not "fix" one into the
   * other without noticing they are different APIs.
   */
  it('are emptied rather than removed, unlike on spans', () => {
    const record = emitted({ capture: 'none' }, undefined, { 'gen_ai.input.messages': CARD });
    assert.equal('gen_ai.input.messages' in record.attributes, true);
    assert.equal(record.attributes['gen_ai.input.messages'], '');
  });

  it('catch a long value from a foreign scope under an unknown key', () => {
    const record = emitted({ capture: 'none' }, undefined, {
      'vendor.brand.new.transcript': 'x'.repeat(400),
      'vendor.brand.new.reason': 'stop',
    });
    assert.equal(record.attributes['vendor.brand.new.transcript'], '');
    assert.equal(record.attributes['vendor.brand.new.reason'], 'stop');
  });
});

describe('octic.redacted on a log record', () => {
  it('is set when the body was withheld', () => {
    assert.equal(emitted({ capture: 'none' }, { content: CARD }).attributes['octic.redacted'], true);
  });

  it('is set when only an attribute was withheld', () => {
    const record = emitted({ capture: 'none' }, undefined, { 'gen_ai.input.messages': CARD });
    assert.equal(record.attributes['octic.redacted'], true);
  });

  /**
   * The flag used to go on whenever a body existed, so a record that passed
   * through untouched still claimed content had been withheld — the confusion
   * the flag exists to prevent, inverted.
   */
  it('is absent when nothing changed', () => {
    const record = emitted(
      { capture: 'full', redact: value => value },
      { content: 'nothing to redact here' },
    );
    assert.equal(record.attributes['octic.redacted'], undefined);
  });

  it('is absent for a record with no content at all', () => {
    const record = emitted({ capture: 'none' }, undefined, { 'event.name': 'gen_ai.choice' });
    assert.equal(record.attributes['octic.redacted'], undefined);
  });
});

describe('processor ordering', () => {
  /**
   * The whole mechanism. If the redactor is registered after the exporting
   * processor, the exporter has already seen the record and the mutation is
   * pointless — this asserts the pipeline as `init()` builds it delivers the
   * redacted version, not merely that the redactor could have run.
   */
  it('means the exporter receives the redacted record', () => {
    const record = emitted({ capture: 'none' }, { content: CARD });
    assert.ok(!JSON.stringify(record.body).includes('4111'));
  });

  /**
   * The same pipeline with the two processors swapped, to show the ordering is
   * load-bearing rather than incidental.
   *
   * This has to snapshot the body at export time instead of using
   * `InMemoryLogRecordExporter`, which keeps a *reference* — the redactor then
   * mutates the very object the test would inspect, and the wrong order looks
   * safe. A real OTLP exporter serializes when it is called, which is what this
   * stand-in reproduces and what makes the leak visible.
   */
  it('leaks when the redactor is registered after the exporter', () => {
    const serialized: string[] = [];
    const serializingExporter = {
      export: (records: { body?: unknown }[], done: (result: { code: number }) => void) => {
        serialized.push(...records.map(record => JSON.stringify(record.body)));
        done({ code: 0 });
      },
      shutdown: () => Promise.resolve(),
      forceFlush: () => Promise.resolve(),
    };

    const provider = new LoggerProvider({
      processors: [
        new SimpleLogRecordProcessor({ exporter: serializingExporter as never }),
        new RedactingLogRecordProcessor(resolvePolicy({ capture: 'none' })),
      ],
    });
    provider.getLogger(FOREIGN_SCOPE).emit({ body: { content: CARD } as never });

    assert.ok(
      serialized[0]?.includes('4111'),
      'the wrong order leaks — which is why init() fixes the order rather than leaving it to a consumer',
    );
  });

  it('does not leak in the order init() builds', () => {
    const serialized: string[] = [];
    const serializingExporter = {
      export: (records: { body?: unknown }[], done: (result: { code: number }) => void) => {
        serialized.push(...records.map(record => JSON.stringify(record.body)));
        done({ code: 0 });
      },
      shutdown: () => Promise.resolve(),
      forceFlush: () => Promise.resolve(),
    };

    const provider = new LoggerProvider({
      processors: [
        new RedactingLogRecordProcessor(resolvePolicy({ capture: 'none' })),
        new SimpleLogRecordProcessor({ exporter: serializingExporter as never }),
      ],
    });
    provider.getLogger(FOREIGN_SCOPE).emit({ body: { content: CARD } as never });

    assert.ok(!serialized[0]?.includes('4111'));
  });
});

describe('the per-run override', () => {
  it('closes content down for one run through the emit context', () => {
    const { exporter, logger } = buildLogs({ capture: 'full' });
    withContent({ capture: 'none' }, () => {
      logger.emit({ body: { content: CARD } as never });
    });
    assert.deepEqual(exporter.getFinishedLogRecords()[0]!.body, { redacted: true });
  });

  it('opens content up for one run while the process default is none', () => {
    const { exporter, logger } = buildLogs({ capture: 'none' });
    withContent({ capture: 'full' }, () => {
      logger.emit({ body: { content: 'keep me' } as never });
    });
    assert.deepEqual(exporter.getFinishedLogRecords()[0]!.body, { content: 'keep me' });
  });

  /**
   * `onEmit` receives the Context, so the override is read straight from the
   * scope with no attribute round-trip — unlike spans, which need one because
   * the exporter runs long after the context has closed.
   */
  it('is read from the emit context rather than from the record', () => {
    const record = fakeLogRecord({ content: CARD });
    const processor = new RedactingLogRecordProcessor(resolvePolicy({ capture: 'full' }));
    withContent({ capture: 'none' }, () => {
      processor.onEmit(record as never, context.active());
    });
    assert.deepEqual(record.body, { redacted: true });
  });
});

describe('the full-with-no-redactor fast path', () => {
  it('returns without touching the record at all', () => {
    const record = fakeLogRecord({ content: 'keep me' }, { 'gen_ai.input.messages': CARD });
    new RedactingLogRecordProcessor(resolvePolicy({ capture: 'full' })).onEmit(
      record as never,
      context.active(),
    );
    assert.deepEqual(record.body, { content: 'keep me' });
    assert.equal(record.attributes['gen_ai.input.messages'], CARD);
    assert.equal(record.attributes['octic.redacted'], undefined);
  });
});
