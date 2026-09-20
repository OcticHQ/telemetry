/**
 * What `init()` does when it cannot do its job.
 *
 * The old code threw — twice over. It threw `already initialized` on a second
 * call, which is a library taking an application down over telemetry, and it
 * set that flag *before* doing any work, so a single failure inside setup left
 * every later call throwing a message describing something that had not
 * happened. A process that mistyped its endpoint could never initialize
 * telemetry again, and the error said the opposite of the reason.
 *
 * The replacement never throws and never retries. Not retrying is the part
 * worth pinning: `setup()` registers an ESM loader hook, registers the global
 * LoggerProvider, sets the module-global content policy and takes custody of a
 * spool directory. `setGlobalLoggerProvider` *silently ignores* a second
 * registration and keeps the first, so a re-run would hand back a handle that
 * flushes a provider no log record reaches — a failure with no symptom.
 *
 * Its own file because the latch is process state, and this file needs the
 * process to start out having failed.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ROOT_CONTEXT } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/sdk-trace-base';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';

import { init, initWithExternalProvider } from '../src/index.ts';
import { fakeReadableSpan, installContextManager } from './support/harness.ts';

installContextManager();

/**
 * Reaches `endpoint.replace()` inside `setup()`. A `.js` consumer with no
 * checker produces exactly this, and it is the most ordinary way for setup to
 * fail — which is the point: the interesting failures here are boring ones.
 */
const broken = { endpoint: undefined, serviceName: 'broken' } as unknown as Parameters<
  typeof init
>[0];

describe('an init() that fails inside setup', () => {
  it('returns a handle instead of throwing', async () => {
    const telemetry = init(broken);

    await telemetry.forceFlush();
    await telemetry.shutdown();
    assert.equal(telemetry.spool, undefined, 'nothing took custody of a directory');
  });

  /**
   * The consequence of not retrying, stated as a test so it is a decision
   * rather than an accident. A consumer who fixes their endpoint and calls
   * again does not get a working pipeline until the process restarts.
   */
  it('does not retry when called again with good options', async () => {
    const second = init({ endpoint: 'http://127.0.0.1:1/', serviceName: 'retry' });

    await second.forceFlush();
    await second.shutdown();
    assert.equal(second.spool, undefined, 'still inert; setup did not run a second time');
  });

  it('serves the external-provider shape inertly rather than half-wired', async () => {
    const external = initWithExternalProvider({
      endpoint: 'http://127.0.0.1:1/',
      serviceName: 'external',
    });

    assert.equal(external.captureContent, false, 'nothing is captured by a pipeline that is off');
    assert.equal(external.spool, undefined);

    /** A host SDK will call both of these, so neither may throw. */
    assert.doesNotThrow(() => {
      external.spanProcessor.onStart({} as Span, ROOT_CONTEXT);
    });

    const result = await new Promise<ExportResult>(resolve => {
      external.spanExporter.export([fakeReadableSpan()], resolve);
    });
    assert.equal(result.code, ExportResultCode.FAILED, 'and it says so rather than pretending');

    await external.forceFlush();
    await external.shutdown();
  });
});
