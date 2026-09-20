/**
 * The first tests in this package, and they are about the thing that cannot be
 * checked by looking at a capture file: what does NOT leave.
 *
 * Everything here runs offline against a provider built in-process — no key, no
 * receiver, no network. Spans are created through a tracer whose scope name is a
 * vendor's, which is what makes this a test of the foreign-span path rather than
 * of our own annotations.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SpanStatusCode, context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import type { ExportResult } from '@opentelemetry/core';

import { OcticSpanProcessor } from '../src/processor.ts';
import { RedactingSpanExporter } from '../src/redacting-exporter.ts';
import { RedactingLogRecordProcessor } from '../src/redacting-log-processor.ts';
import { resolvePolicy, withContent, type ContentOptions } from '../src/content.ts';
import { withIdentity } from '../src/identity.ts';
import { runScope } from '../src/run.ts';
import { summaryOf } from './support/harness.ts';

/**
 * Without this every `context.with` is a no-op: the API's default context
 * manager stores nothing, so `context.active()` is always ROOT and every scope
 * in this package silently stamps nothing. `init()` gets one for free from
 * `tracerProvider.register()`; a test building a provider by hand does not, and
 * neither does a host SDK that registers a provider without a context manager.
 */
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

const FOREIGN_SCOPE = '@vendor/instrumentation-openai';

/** Copied from receiver/captured/ — the keys three real stacks actually send. */
const CONTENT = {
  'gen_ai.input.messages':
    '[{"role":"user","parts":[{"type":"text","content":"my card is 4111 1111 1111 1111"}]}]',
  'gen_ai.output.messages':
    '[{"role":"assistant","parts":[{"type":"text","content":"It is 14C in Paris."}]}]',
  'gen_ai.system_instructions': 'You are a concise weather assistant.',
  'gen_ai.tool.call.result': '{"tempC":14}',
};

/** Not content, and must survive every setting — this is the product. */
const GOVERNANCE = {
  'gen_ai.conversation.id': 'conv-1',
  'user.id': 'user-42',
  'octic.run.id': 'run-chat-turn-a3f9c1',
  'gen_ai.prompt.name': 'weather-assistant',
  'gen_ai.usage.input_tokens': 5200,
  'gen_ai.response.model': 'gpt-5',
  'octic.target.asset_ref': 'poc/datastore/city-guide',
};

class Collector implements SpanExporter {
  readonly spans: ReadableSpan[] = [];
  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    this.spans.push(...spans);
    done({ code: 0 });
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * A provider that is never registered globally, so each case gets a clean one
 * and `init()`'s once-per-process guard stays out of the way.
 */
const harness = (content: ContentOptions, extraResource: Record<string, string> = {}) => {
  const collector = new Collector();
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': 'test', ...extraResource }),
    spanProcessors: [
      new OcticSpanProcessor(),
      new SimpleSpanProcessor(new RedactingSpanExporter(collector, resolvePolicy(content))),
    ],
  });
  return { collector, tracer: provider.getTracer(FOREIGN_SCOPE) };
};

/** One foreign span carrying content and governance attributes, exported. */
const emit = (content: ContentOptions, wrap: (fn: () => void) => void = fn => fn(), extra = {}) => {
  const { collector, tracer } = harness(content, extra);
  wrap(() => {
    const span = tracer.startSpan('chat gpt-5', { attributes: { ...CONTENT, ...GOVERNANCE } });
    span.end();
  });
  assert.equal(collector.spans.length, 1, 'exactly one span exported');
  return collector.spans[0]!;
};

/**
 * The default is `full` while this is early — content is opt-out, so a first
 * consumer sees everything the pipeline can carry. Pinned by a test rather than
 * left to the doc comment: a default this consequential should not be able to
 * change without a test changing with it.
 */
describe('the default', () => {
  it('is full — content ships unless the consumer says otherwise', () => {
    assert.equal(resolvePolicy().capture, 'full');
    assert.equal(resolvePolicy({}).capture, 'full');
    const span = emit({});
    assert.equal(span.attributes['gen_ai.output.messages'], CONTENT['gen_ai.output.messages']);
    assert.equal(span.attributes['octic.redacted'], undefined);
  });

  it('still ships every governance attribute, same as the closed setting', () => {
    const span = emit({});
    for (const [key, value] of Object.entries(GOVERNANCE)) {
      assert.equal(span.attributes[key], value);
    }
  });
});

describe('capture: none', () => {
  it('drops every measured content key', () => {
    const span = emit({ capture: 'none' });
    for (const key of Object.keys(CONTENT)) {
      assert.equal(span.attributes[key], undefined, `${key} should not be exported`);
    }
  });

  it('keeps every governance attribute untouched', () => {
    const span = emit({ capture: 'none' });
    for (const [key, value] of Object.entries(GOVERNANCE)) {
      assert.equal(span.attributes[key], value, `${key} must survive redaction`);
    }
  });

  it('marks the span so the UI can say "withheld" rather than "empty"', () => {
    assert.equal(emit({ capture: 'none' }).attributes['octic.redacted'], true);
  });

  it('drops a long value under a key we have never seen', () => {
    const { collector, tracer } = harness({ capture: 'none' });
    const span = tracer.startSpan('chat gpt-5');
    span.setAttribute('vendor.brand.new.transcript', 'x'.repeat(400));
    span.setAttribute('vendor.brand.new.short_enum', 'stop');
    span.end();
    const exported = collector.spans[0]!;
    assert.equal(exported.attributes['vendor.brand.new.transcript'], undefined);
    assert.equal(exported.attributes['vendor.brand.new.short_enum'], 'stop');
  });

  it('never ships the capture level itself', () => {
    const span = emit({ capture: 'none' }, fn => withContent({ capture: 'none' }, fn));
    assert.equal(span.attributes['octic.content.capture'], undefined);
  });
});

describe('capture: metadata', () => {
  it('replaces content with length and hash', () => {
    const span = emit({ capture: 'metadata' });
    const summary = summaryOf(span.attributes['gen_ai.input.messages']);
    assert.equal(summary.redacted, true);
    assert.equal(summary.chars, CONTENT['gen_ai.input.messages'].length);
    assert.match(summary.sha256, /^[0-9a-f]{16}$/);
    assert.ok(!String(span.attributes['gen_ai.input.messages']).includes('4111'));
  });

  it('hashes equal content equally, so "same prompt as last run" is answerable', () => {
    const a = summaryOf(emit({ capture: 'metadata' }).attributes['gen_ai.system_instructions']);
    const b = summaryOf(emit({ capture: 'metadata' }).attributes['gen_ai.system_instructions']);
    assert.equal(a.sha256, b.sha256);
  });
});

describe('capture: full', () => {
  it('sends content as-is when no redactor is configured', () => {
    const span = emit({ capture: 'full' });
    assert.equal(span.attributes['gen_ai.output.messages'], CONTENT['gen_ai.output.messages']);
  });

  it('applies the customer redactor', () => {
    const span = emit({
      capture: 'full',
      redact: value => value.replace(/\b(?:\d[ -]*?){13,16}\b/g, '[card]'),
    });
    const messages = String(span.attributes['gen_ai.input.messages']);
    assert.ok(!messages.includes('4111'), 'card number must not survive');
    assert.ok(messages.includes('[card]'));
  });

  it('truncates at maxLength', () => {
    const { collector, tracer } = harness({ capture: 'full', maxLength: 32 });
    const span = tracer.startSpan('chat gpt-5');
    span.setAttribute('gen_ai.input.messages', 'y'.repeat(500));
    span.end();
    assert.ok(
      String(collector.spans[0]!.attributes['gen_ai.input.messages']).endsWith('…[truncated]'),
    );
  });

  it('fails closed when the redactor throws', () => {
    const span = emit({
      capture: 'full',
      redact: () => {
        throw new Error('boom');
      },
    });
    assert.equal(span.attributes['gen_ai.input.messages'], '[redaction-failed]');
  });

  it('fails closed when the redactor returns undefined', () => {
    const span = emit({ capture: 'full', redact: () => undefined });
    assert.equal(span.attributes['gen_ai.input.messages'], undefined);
  });
});

describe('withContent(), on a span we did not create', () => {
  it('opens content up for one run while the process default stays none', () => {
    const span = emit({ capture: 'none' }, fn => withContent({ capture: 'full' }, fn));
    assert.equal(span.attributes['gen_ai.output.messages'], CONTENT['gen_ai.output.messages']);
  });

  it('closes content down for one run while the process default is full', () => {
    const span = emit({ capture: 'full' }, fn => withContent({ capture: 'none' }, fn));
    assert.equal(span.attributes['gen_ai.output.messages'], undefined);
  });
});

describe('identity and run scope still reach the foreign span', () => {
  it('stamps context values while redacting content in the same pass', () => {
    const { collector, tracer } = harness({ capture: 'none' });
    withIdentity({ conversationId: 'conv-9', userId: 'user-7' }, () => {
      runScope.with({ id: 'run-x-1' }, () => {
        const span = tracer.startSpan('chat gpt-5', { attributes: CONTENT });
        span.end();
      });
    });
    const span = collector.spans[0]!;
    assert.equal(span.attributes['gen_ai.conversation.id'], 'conv-9');
    assert.equal(span.attributes['session.id'], 'conv-9');
    assert.equal(span.attributes['user.id'], 'user-7');
    assert.equal(span.attributes['octic.run.id'], 'run-x-1');
    assert.equal(span.attributes['gen_ai.input.messages'], undefined);
  });
});

describe('resource attributes nobody asked for', () => {
  it('drops argv, process owner and host id', () => {
    const span = emit({}, fn => fn(), {
      'process.command_args': '/usr/bin/node server.js --token=hunter2',
      'process.owner': 'kav',
      'host.id': '84c4f47c43d4497da39ce761dcc11c55',
      'service.version': '1.4.0',
    });
    assert.equal(span.resource.attributes['process.command_args'], undefined);
    assert.equal(span.resource.attributes['process.owner'], undefined);
    assert.equal(span.resource.attributes['host.id'], undefined);
    assert.equal(span.resource.attributes['service.version'], '1.4.0');
    assert.equal(span.resource.attributes['service.name'], 'test');
  });
});

describe('the logs signal', () => {
  /** Minimal stand-in for SdkLogRecord: the three members the processor touches. */
  const fakeRecord = (body: unknown, attributes: Record<string, unknown> = {}) => ({
    body,
    attributes,
    setBody(next: unknown) {
      this.body = next;
      return this;
    },
    setAttribute(key: string, value: unknown) {
      this.attributes[key] = value;
      return this;
    },
  });

  it('replaces the body, which is where instrumentation-openai puts everything', () => {
    const record = fakeRecord({ content: 'my card is 4111 1111 1111 1111' });
    new RedactingLogRecordProcessor(resolvePolicy({ capture: 'none' })).onEmit(
      record as never,
      context.active(),
    );
    assert.deepEqual(record.body, { redacted: true });
    assert.equal(record.attributes['octic.redacted'], true);
  });

  it('summarizes under metadata without revealing the body', () => {
    const record = fakeRecord({ content: 'secret' });
    new RedactingLogRecordProcessor(resolvePolicy({ capture: 'metadata' })).onEmit(
      record as never,
      context.active(),
    );
    assert.equal((record.body as { redacted: boolean }).redacted, true);
    assert.ok(!JSON.stringify(record.body).includes('secret'));
  });

  it('leaves the body alone under full with no redactor', () => {
    const record = fakeRecord({ content: 'keep me' });
    new RedactingLogRecordProcessor(resolvePolicy({ capture: 'full' })).onEmit(
      record as never,
      context.active(),
    );
    assert.deepEqual(record.body, { content: 'keep me' });
  });

  it('honours a withContent() override through the emit context', () => {
    const record = fakeRecord({ content: 'keep me' });
    const policy = resolvePolicy({ capture: 'full' });
    withContent({ capture: 'none' }, () => {
      new RedactingLogRecordProcessor(policy).onEmit(record as never, context.active());
    });
    assert.deepEqual(record.body, { redacted: true });
  });
});

/** The span the annotations produce, rather than one we stamped. */
describe('our own entity input and output', () => {
  it('is never serialized at all under none', async () => {
    const { withWorkflow } = await import('../src/annotations.ts');
    const { setActivePolicy } = await import('../src/content.ts');
    setActivePolicy(resolvePolicy({ capture: 'none' }));

    const collector = new Collector();
    const provider = new NodeTracerProvider({
      spanProcessors: [
        new SimpleSpanProcessor(
          new RedactingSpanExporter(collector, resolvePolicy({ capture: 'none' })),
        ),
      ],
    });
    const restore = trace.getTracerProvider();
    trace.setGlobalTracerProvider(provider);
    try {
      await withWorkflow(
        { name: 'chat-turn', input: { message: 'secret question' } },
        async () => ({
          reply: 'secret answer',
        }),
      );
    } finally {
      trace.disable();
      trace.setGlobalTracerProvider(restore);
    }

    const workflow = collector.spans.find(span => span.name === 'invoke_workflow chat-turn')!;
    assert.ok(workflow, 'workflow span exported');
    assert.equal(workflow.attributes['octic.entity.input'], undefined);
    assert.equal(workflow.attributes['octic.entity.output'], undefined);
    assert.equal(workflow.attributes['gen_ai.workflow.name'], 'chat-turn');
    assert.equal(workflow.attributes['gen_ai.operation.name'], 'invoke_workflow');
  });
});

/**
 * Span events, which a span-attribute redactor misses entirely.
 *
 * `recordException` writes `exception.message` and `exception.stacktrace` as
 * *events*, and the exporter used to rebuild only `attributes` — so events rode
 * through on the prototype and an error message quoting the prompt left the
 * process at every level, `none` included. The two keys are listed in the
 * contract rather than left to the length heuristic, because our own annotation
 * spans are not foreign and the heuristic never fires on them.
 */
describe('span events', () => {
  const withException = (content: ContentOptions, message = 'failed on 4111 1111 1111 1111') => {
    const { collector, tracer } = harness(content);
    const span = tracer.startSpan('chat gpt-5');
    span.recordException(Object.assign(new Error(message), { name: 'ProviderError' }));
    span.end();
    return collector.spans[0]!.events.find(event => event.name === 'exception')!;
  };

  it('drops the exception message under none', () => {
    const event = withException({ capture: 'none' });
    assert.equal(event.attributes?.['exception.message'], undefined);
  });

  it('drops the stack trace under none, where the frames are', () => {
    const event = withException({ capture: 'none' });
    assert.equal(event.attributes?.['exception.stacktrace'], undefined);
  });

  /** The one part of a failure that stays legible when content is off. */
  it('keeps the exception type at every level', () => {
    for (const capture of ['none', 'metadata', 'full'] as const) {
      assert.equal(
        withException({ capture }).attributes?.['exception.type'],
        'ProviderError',
        `exception.type must survive ${capture}`,
      );
    }
  });

  it('summarizes the message under metadata', () => {
    const summary = summaryOf(
      withException({ capture: 'metadata' }).attributes?.['exception.message'],
    );
    assert.equal(summary.redacted, true);
    assert.match(summary.sha256, /^[0-9a-f]{16}$/);
  });

  it('applies the customer redactor under full', () => {
    const event = withException({
      capture: 'full',
      redact: value => value.replace(/\b(?:\d[ -]*?){13,16}\b/g, '[card]'),
    });
    const message = String(event.attributes?.['exception.message']);
    assert.ok(!message.includes('4111'), 'the card number must not survive');
    assert.ok(message.includes('[card]'));
  });

  it('marks the span redacted when only an event was withheld', () => {
    const { collector, tracer } = harness({ capture: 'none' });
    const span = tracer.startSpan('chat gpt-5');
    span.recordException(new Error('secret'));
    span.end();
    assert.equal(collector.spans[0]!.attributes['octic.redacted'], true);
  });

  it('leaves a non-content event attribute alone', () => {
    const { collector, tracer } = harness({ capture: 'none' });
    const span = tracer.startSpan('chat gpt-5');
    span.addEvent('gen_ai.choice', { 'gen_ai.response.finish_reason': 'stop' });
    span.end();
    const event = collector.spans[0]!.events.find(entry => entry.name === 'gen_ai.choice')!;
    assert.equal(event.attributes?.['gen_ai.response.finish_reason'], 'stop');
  });

  it('redacts content on a foreign event too, not just exceptions', () => {
    const { collector, tracer } = harness({ capture: 'none' });
    const span = tracer.startSpan('chat gpt-5');
    span.addEvent('gen_ai.user.message', {
      'gen_ai.input.messages': CONTENT['gen_ai.input.messages'],
    });
    span.end();
    const event = collector.spans[0]!.events.find(entry => entry.name === 'gen_ai.user.message')!;
    assert.equal(event.attributes?.['gen_ai.input.messages'], undefined);
  });
});

/**
 * The status message, which is the same string as the exception event reached
 * by a different field — `withTool()` sets both from one error.
 *
 * The status *code* is never touched: "this run failed" has to survive at every
 * level, even when what failed does not.
 */
describe('the status message', () => {
  const withStatus = (content: ContentOptions) => {
    const { collector, tracer } = harness(content);
    const span = tracer.startSpan('chat gpt-5');
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'card 4111 1111 1111 1111 declined' });
    span.end();
    return collector.spans[0]!;
  };

  it('is dropped under none while the error code survives', () => {
    const span = withStatus({ capture: 'none' });
    assert.equal(span.status.code, SpanStatusCode.ERROR);
    assert.equal(span.status.message, undefined);
    assert.equal(span.attributes['octic.redacted'], true);
  });

  it('is summarized under metadata', () => {
    const summary = summaryOf(withStatus({ capture: 'metadata' }).status.message);
    assert.equal(summary.redacted, true);
    assert.ok(!JSON.stringify(summary).includes('4111'));
  });

  it('passes through under full with no redactor', () => {
    assert.equal(
      withStatus({ capture: 'full' }).status.message,
      'card 4111 1111 1111 1111 declined',
    );
  });

  it('is left alone when there is no message at all', () => {
    const { collector, tracer } = harness({ capture: 'none' });
    const span = tracer.startSpan('chat gpt-5');
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    assert.equal(collector.spans[0]!.status.code, SpanStatusCode.OK);
    assert.equal(collector.spans[0]!.attributes['octic.redacted'], undefined);
  });
});

/**
 * Array-valued attributes.
 *
 * OTel attributes are primitives *or arrays of them*, and several stacks write
 * `gen_ai.input.messages` as `string[]`. `full` used to hand those straight to
 * the wire — no redactor, no length cap — which is the one setting a customer
 * picks *because* they are relying on the redactor.
 */
describe('array attributes', () => {
  const messages = ['my card is 4111 1111 1111 1111', 'and my pin is 0000'];

  const emitArray = (content: ContentOptions, value: unknown = messages) => {
    const { collector, tracer } = harness(content);
    const span = tracer.startSpan('chat gpt-5');
    span.setAttribute('gen_ai.input.messages', value as string[]);
    span.end();
    return collector.spans[0]!;
  };

  it('drops the whole array under none', () => {
    assert.equal(emitArray({ capture: 'none' }).attributes['gen_ai.input.messages'], undefined);
  });

  it('summarizes it under metadata without revealing an element', () => {
    const summary = String(emitArray({ capture: 'metadata' }).attributes['gen_ai.input.messages']);
    assert.equal(summaryOf(summary).redacted, true);
    assert.ok(!summary.includes('4111'));
  });

  it('redacts element by element under full', () => {
    const kept = emitArray({
      capture: 'full',
      redact: value => value.replace(/\b(?:\d[ -]*?){13,16}\b/g, '[card]'),
    }).attributes['gen_ai.input.messages'] as string[];

    assert.equal(kept.length, 2, 'both elements survive');
    assert.ok(!kept[0]!.includes('4111'));
    assert.ok(kept[0]!.includes('[card]'));
    assert.equal(
      kept[1],
      'and my pin is 0000',
      'an element the redactor did not match is unchanged',
    );
  });

  it('applies maxLength to each element', () => {
    const kept = emitArray({ capture: 'full', maxLength: 8 }, ['y'.repeat(50)]).attributes[
      'gen_ai.input.messages'
    ] as string[];
    assert.ok(kept[0]!.endsWith('…[truncated]'));
  });

  /**
   * Fails closed rather than shipping a sparse array: a hole a consumer cannot
   * interpret is worse than an absent attribute, and everything else here drops
   * the whole value when the redactor declines.
   */
  it('drops the whole attribute when the redactor rejects any element', () => {
    const kept = emitArray({
      capture: 'full',
      redact: value => (value.includes('pin') ? undefined : value),
    }).attributes['gen_ai.input.messages'];
    assert.equal(kept, undefined);
  });

  it('leaves a non-string array untouched under full', () => {
    const { collector, tracer } = harness({ capture: 'full' });
    const span = tracer.startSpan('chat gpt-5');
    span.setAttribute('gen_ai.usage.details', [1, 2, 3]);
    span.end();
    assert.deepEqual(collector.spans[0]!.attributes['gen_ai.usage.details'], [1, 2, 3]);
  });

  /**
   * The heuristic has to measure arrays too, or a foreign span can carry the
   * whole conversation in one under a key we have never seen.
   */
  it('catches a long array under an unknown key on a foreign span', () => {
    const { collector, tracer } = harness({ capture: 'none' });
    const span = tracer.startSpan('chat gpt-5');
    span.setAttribute('vendor.brand.new.turns', ['x'.repeat(150), 'y'.repeat(150)]);
    span.setAttribute('vendor.brand.new.reasons', ['stop', 'length']);
    span.end();
    const exported = collector.spans[0]!;
    assert.equal(exported.attributes['vendor.brand.new.turns'], undefined);
    assert.deepEqual(exported.attributes['vendor.brand.new.reasons'], ['stop', 'length']);
  });
});

/**
 * The capture level cannot be raised from application code.
 *
 * The exporter reads the level the processor resolved, and the processor keeps
 * it against the span object rather than trusting the attribute — anything that
 * can write a span attribute could otherwise write that one, and a caller who
 * had never heard of the key could reopen a process configured `none`.
 */
describe('the capture level is not a span attribute', () => {
  it('ignores a capture level supplied in span options', () => {
    const { collector, tracer } = harness({ capture: 'none' });
    const span = tracer.startSpan('chat gpt-5', {
      attributes: { ...CONTENT, 'octic.content.capture': 'full' },
    });
    span.end();
    assert.equal(collector.spans[0]!.attributes['gen_ai.input.messages'], undefined);
  });

  it('ignores one written after the span has started', () => {
    const { collector, tracer } = harness({ capture: 'none' });
    const span = tracer.startSpan('chat gpt-5', { attributes: CONTENT });
    span.setAttribute('octic.content.capture', 'full');
    span.end();
    assert.equal(collector.spans[0]!.attributes['gen_ai.input.messages'], undefined);
  });

  it('still honours a real withContent() override', () => {
    const span = emit({ capture: 'none' }, fn => withContent({ capture: 'full' }, fn));
    assert.equal(span.attributes['gen_ai.output.messages'], CONTENT['gen_ai.output.messages']);
  });

  it('never ships the key itself, whoever wrote it', () => {
    const { collector, tracer } = harness({ capture: 'none' });
    const span = tracer.startSpan('chat gpt-5', {
      attributes: { 'octic.content.capture': 'full' },
    });
    span.end();
    assert.equal(collector.spans[0]!.attributes['octic.content.capture'], undefined);
  });
});

describe('octic.redacted', () => {
  it('is absent when there was no content to withhold', () => {
    const { collector, tracer } = harness({ capture: 'none' });
    tracer.startSpan('chat gpt-5', { attributes: GOVERNANCE }).end();
    assert.equal(collector.spans[0]!.attributes['octic.redacted'], undefined);
  });

  it('is absent under full with no redactor, where nothing changed', () => {
    assert.equal(emit({ capture: 'full' }).attributes['octic.redacted'], undefined);
  });
});
