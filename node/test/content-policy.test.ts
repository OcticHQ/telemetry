/**
 * The content policy as pure functions, away from spans and providers.
 *
 * `redaction.test.ts` asks what reaches the wire; this file asks whether the
 * three decisions underneath it are right — is this key content, what does this
 * capture level do to a value, and what does an unconfigured policy mean. They
 * are separated because the classification is shared beyond this SDK: the same
 * list has to reach ingest, which redacts for customers who never install us.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AttributeValue } from '@opentelemetry/api';

import {
  applyCapture,
  applyCaptureToBody,
  isContent,
  resolvePolicy,
  truncate,
} from '../src/content.ts';
import { CONTENT_HEURISTIC_MIN_LENGTH } from '../src/attributes.ts';

const policy = resolvePolicy();
const closed = resolvePolicy({ capture: 'none' });

describe('resolvePolicy', () => {
  /**
   * The level itself is pinned in redaction.test.ts, which owns the question of
   * what the default *means*. What matters here is the rest of the shape.
   */
  it('fills in the remaining defaults', () => {
    const resolved = resolvePolicy();
    assert.equal(resolved.maxLength, 4096);
    assert.equal(resolved.allow.size, 0);
    assert.equal(resolved.extra.size, 0);
  });

  /**
   * `exactOptionalPropertyTypes` makes "absent" and "present but undefined"
   * different things, and the redactor is checked with `=== undefined` — so a
   * key present with an undefined value would still take the "no redactor"
   * branch, but only by luck. Absent is what is intended.
   */
  it('omits the redactor rather than setting it undefined', () => {
    assert.equal('redact' in resolvePolicy(), false);
    assert.equal('redact' in resolvePolicy({ redact: value => value }), true);
  });

  it('carries the supplied allow and extra lists into sets', () => {
    const resolved = resolvePolicy({
      allowAttributes: ['gen_ai.tool.call.result'],
      contentAttributes: ['vendor.transcript'],
    });
    assert.equal(resolved.allow.has('gen_ai.tool.call.result'), true);
    assert.equal(resolved.extra.has('vendor.transcript'), true);
  });
});

describe('isContent', () => {
  it('recognises a declared key regardless of scope or value', () => {
    assert.equal(isContent('gen_ai.input.messages', 'x', false, policy), true);
    assert.equal(isContent('gen_ai.input.messages', 'x', true, policy), true);
  });

  it('recognises the shape patterns', () => {
    assert.equal(isContent('gen_ai.prompt.0.content', 'x', false, policy), true);
    assert.equal(isContent('vendor.thing.messages', 'x', false, policy), true);
    assert.equal(isContent('vendor.thing.arguments', 'x', false, policy), true);
  });

  it('does not fire on a key that merely contains a pattern word', () => {
    assert.equal(isContent('gen_ai.response.content_filter', 'stop', false, policy), false);
  });

  /**
   * The length bound applies only to scopes we do not control. Our own
   * annotation spans put deliberate values under known keys, so measuring them
   * by length would drop a long tool name for being long.
   */
  it('treats a long string from a foreign scope as content', () => {
    const long = 'x'.repeat(CONTENT_HEURISTIC_MIN_LENGTH + 1);
    assert.equal(isContent('vendor.unknown', long, true, policy), true);
    assert.equal(isContent('vendor.unknown', long, false, policy), false);
  });

  it('leaves a short string from a foreign scope alone', () => {
    assert.equal(isContent('vendor.unknown', 'stop', true, policy), false);
  });

  it('measures arrays for the same bound', () => {
    const half = 'x'.repeat(CONTENT_HEURISTIC_MIN_LENGTH / 2 + 1);
    assert.equal(isContent('vendor.turns', [half, half], true, policy), true);
    assert.equal(isContent('vendor.reasons', ['stop', 'length'], true, policy), false);
  });

  it('ignores non-text values for the bound', () => {
    assert.equal(isContent('gen_ai.usage.input_tokens', 5200, true, policy), false);
    assert.equal(isContent('vendor.flag', true, true, policy), false);
  });

  it('lets allowAttributes override a declared content key', () => {
    const relaxed = resolvePolicy({ allowAttributes: ['gen_ai.tool.call.result'] });
    assert.equal(isContent('gen_ai.tool.call.result', '{}', false, relaxed), false);
  });

  it('lets contentAttributes add a key we have not measured', () => {
    const strict = resolvePolicy({ contentAttributes: ['vendor.transcript'] });
    assert.equal(isContent('vendor.transcript', 'hi', false, strict), true);
  });

  /**
   * The specific hole the contract wiring closed. `gen_ai.tool.call.arguments`
   * is short — `{"location":"Paris"}` is 21 characters — so the length bound
   * never catches it, and a hand-written list once omitted it entirely.
   */
  it('covers a short declared key the heuristic cannot reach', () => {
    assert.equal(isContent('gen_ai.tool.call.arguments', '{"location":"Paris"}', true, policy), true);
  });
});

describe('applyCapture', () => {
  it('drops everything under none', () => {
    assert.equal(applyCapture('secret', 'k', 'none', closed), undefined);
    assert.equal(applyCapture(42, 'k', 'none', closed), undefined);
    assert.equal(applyCapture(['a'], 'k', 'none', closed), undefined);
  });

  /** An unknown level is not a level; it fails closed rather than passing through. */
  it('drops everything under a level it does not recognise', () => {
    assert.equal(applyCapture('secret', 'k', 'unknown' as never, closed), undefined);
  });

  it('summarizes any type under metadata', () => {
    for (const value of ['secret', 42, true, ['a', 'b']] as AttributeValue[]) {
      const summary = JSON.parse(String(applyCapture(value, 'k', 'metadata', policy)));
      assert.equal(summary.redacted, true);
      assert.equal(typeof summary.chars, 'number');
      assert.match(summary.sha256, /^[0-9a-f]{16}$/);
    }
  });

  it('passes a string through under full when no redactor is configured', () => {
    assert.equal(applyCapture('secret', 'k', 'full', resolvePolicy({ capture: 'full' })), 'secret');
  });

  it('passes numbers and booleans through under full', () => {
    const open = resolvePolicy({ capture: 'full' });
    assert.equal(applyCapture(5200, 'k', 'full', open), 5200);
    assert.equal(applyCapture(true, 'k', 'full', open), true);
  });

  it('hands the key to the redactor so it can branch on origin', () => {
    const seen: string[] = [];
    applyCapture('v', 'gen_ai.input.messages', 'full', {
      ...resolvePolicy({ capture: 'full' }),
      redact: (value, key) => {
        seen.push(key);
        return value;
      },
    });
    assert.deepEqual(seen, ['gen_ai.input.messages']);
  });

  it('fails closed when the redactor throws', () => {
    const thrower = {
      ...resolvePolicy({ capture: 'full' }),
      redact: () => {
        throw new Error('boom');
      },
    };
    assert.equal(applyCapture('secret', 'k', 'full', thrower), '[redaction-failed]');
  });
});

describe('the length cap', () => {
  it('truncates and marks', () => {
    const capped = resolvePolicy({ capture: 'full', maxLength: 8 });
    assert.equal(applyCapture('y'.repeat(50), 'k', 'full', capped), 'yyyyyyyy…[truncated]');
  });

  it('leaves a value exactly at the cap alone', () => {
    const capped = resolvePolicy({ capture: 'full', maxLength: 8 });
    assert.equal(applyCapture('yyyyyyyy', 'k', 'full', capped), 'yyyyyyyy');
  });

  it('handles a cap of zero, which means keep nothing', () => {
    const capped = resolvePolicy({ capture: 'full', maxLength: 0 });
    assert.equal(applyCapture('anything', 'k', 'full', capped), '…[truncated]');
  });

  /**
   * `slice` counts UTF-16 units, so cutting mid-pair used to leave a lone high
   * surrogate — not valid UTF-8, and attributes are JSON-encoded on the way out.
   * One emoji at the wrong offset was enough to put an unencodable character on
   * the wire.
   */
  it('does not split a surrogate pair', () => {
    const emoji = '😀'.repeat(10);
    for (const maxLength of [1, 2, 3, 4, 5, 7, 9]) {
      const capped = String(
        applyCapture(emoji, 'k', 'full', resolvePolicy({ capture: 'full', maxLength })),
      );
      const body = capped.replace('…[truncated]', '');
      assert.equal(
        /[\uD800-\uDBFF]$/.test(body),
        false,
        `maxLength ${maxLength} left a lone high surrogate`,
      );
      assert.equal(JSON.parse(JSON.stringify(body)), body, 'and the result round-trips as JSON');
    }
  });

  it('is exposed as a helper both truncating call sites share', () => {
    assert.equal(truncate('abcdef', 3, '…'), 'abc…');
    assert.equal(truncate('ab', 3, '…'), 'ab');
  });
});

/** Log bodies are arbitrary AnyValue, so this mirrors applyCapture for them. */
describe('applyCaptureToBody', () => {
  it('replaces the whole body under none', () => {
    assert.deepEqual(applyCaptureToBody({ content: 'secret' }, 'none', closed), { redacted: true });
  });

  it('summarizes under metadata without revealing the body', () => {
    const summarized = applyCaptureToBody({ content: 'secret' }, 'metadata', policy) as {
      redacted: boolean;
    };
    assert.equal(summarized.redacted, true);
    assert.ok(!JSON.stringify(summarized).includes('secret'));
  });

  it('leaves a structured body alone under full', () => {
    const body = { content: 'keep me' };
    assert.deepEqual(applyCaptureToBody(body, 'full', resolvePolicy({ capture: 'full' })), body);
  });

  it('redacts a string body under full', () => {
    const open = {
      ...resolvePolicy({ capture: 'full' }),
      redact: (value: string) => value.replace('secret', '[gone]'),
    };
    assert.equal(applyCaptureToBody('a secret', 'full', open), 'a [gone]');
  });

  it('falls back to a redacted marker when the redactor drops a string body', () => {
    const dropping = { ...resolvePolicy({ capture: 'full' }), redact: () => undefined };
    assert.deepEqual(applyCaptureToBody('a secret', 'full', dropping), { redacted: true });
  });
});

describe('summaries', () => {
  it('are stable, so "same prompt as last run" is answerable', () => {
    const a = applyCapture('the same prompt', 'k', 'metadata', policy);
    const b = applyCapture('the same prompt', 'k', 'metadata', policy);
    assert.equal(a, b);
  });

  it('differ for different content', () => {
    const a = applyCapture('prompt one', 'k', 'metadata', policy);
    const b = applyCapture('prompt two', 'k', 'metadata', policy);
    assert.notEqual(a, b);
  });

  it('report the length of the original', () => {
    const summary = JSON.parse(String(applyCapture('12345', 'k', 'metadata', policy)));
    assert.equal(summary.chars, 5);
  });
});
