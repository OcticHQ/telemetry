/**
 * Many runs at once, which is the only way a server ever runs this.
 *
 * Every scope in this package is one `AsyncLocalStorage` away from being
 * process-global, and the difference is invisible in a sequential test: set the
 * conversation id, start a span, read it back, green. The failure mode that
 * matters is one request's identity landing on another request's span, and it
 * only appears when the runs interleave.
 *
 * The jitter is deliberate. Uniform delays let runs finish in the order they
 * started, which is the one ordering that would still pass with a single shared
 * variable instead of a context.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { withTool, withWorkflow } from '../src/annotations.ts';
import { withContent } from '../src/content.ts';
import { withIdentity } from '../src/identity.ts';
import { withPrompt } from '../src/prompt.ts';
import {
  buildProvider,
  CONTENT,
  installContextManager,
  withGlobalTracerProvider,
  withPolicy,
} from './support/harness.ts';

installContextManager();

const RUNS = 50;

/** Enough to reorder completion without making the suite slow. */
const jitter = () => new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 12)));

describe('fifty runs at once', () => {
  it('keeps identity, prompt and run id on the spans of the run that set them', async () => {
    const { collector, provider, foreignTracer } = buildProvider({ content: { capture: 'none' } });

    await withPolicy({ capture: 'none' }, () =>
      withGlobalTracerProvider(provider, async () => {
        await Promise.all(
          Array.from({ length: RUNS }, (_, index) =>
            withIdentity({ conversationId: `conv-${index}`, userId: `user-${index}` }, () =>
              withWorkflow({ name: 'chat-turn', runId: `run-${index}` }, async () => {
                await jitter();
                await withPrompt(
                  { template: `template-${index}`, version: String(index) },
                  async () => {
                    await jitter();
                    foreignTracer.startSpan(`chat-${index}`).end();
                  },
                );
                await withTool({ name: `tool-${index}` }, async () => {
                  await jitter();
                });
              }),
            ),
          ),
        );
      }),
    );

    assert.equal(collector.spans.length, RUNS * 3, 'three spans per run, none lost');

    for (let index = 0; index < RUNS; index += 1) {
      const model = collector.named(`chat-${index}`);
      assert.equal(model.attributes['gen_ai.conversation.id'], `conv-${index}`);
      assert.equal(model.attributes['user.id'], `user-${index}`);
      assert.equal(model.attributes['octic.run.id'], `run-${index}`);
      assert.equal(model.attributes['gen_ai.prompt.name'], `template-${index}`);

      const tool = collector.named(`execute_tool tool-${index}`);
      assert.equal(tool.attributes['octic.run.id'], `run-${index}`);
      assert.equal(
        tool.attributes['gen_ai.prompt.name'],
        undefined,
        'the prompt scope closed before the tool ran, so it must not be stamped',
      );
    }
  });

  it('gives every run a distinct minted id when none is supplied', async () => {
    const { collector, provider } = buildProvider({ content: { capture: 'none' } });

    await withPolicy({ capture: 'none' }, () =>
      withGlobalTracerProvider(provider, async () => {
        await Promise.all(
          Array.from({ length: RUNS }, () =>
            withWorkflow({ name: 'chat-turn' }, async () => {
              await jitter();
            }),
          ),
        );
      }),
    );

    const ids = new Set(collector.spans.map(span => span.attributes['octic.run.id']));
    assert.equal(ids.size, RUNS);
  });

  it('keeps each run in its own trace', async () => {
    const { collector, provider, foreignTracer } = buildProvider({ content: { capture: 'none' } });

    await withPolicy({ capture: 'none' }, () =>
      withGlobalTracerProvider(provider, async () => {
        await Promise.all(
          Array.from({ length: 10 }, (_, index) =>
            withWorkflow({ name: 'chat-turn', runId: `run-${index}` }, async () => {
              await jitter();
              foreignTracer.startSpan(`chat-${index}`).end();
            }),
          ),
        );
      }),
    );

    for (let index = 0; index < 10; index += 1) {
      const workflow = collector.spans.find(
        span =>
          span.name === 'invoke_workflow chat-turn' &&
          span.attributes['octic.run.id'] === `run-${index}`,
      );
      assert.ok(workflow, `run-${index} produced a workflow span`);
      assert.equal(
        collector.named(`chat-${index}`).spanContext().traceId,
        workflow.spanContext().traceId,
        `run-${index} must share one trace`,
      );
    }

    const traceIds = new Set(collector.spans.map(span => span.spanContext().traceId));
    assert.equal(traceIds.size, 10, 'and ten runs must not collapse into fewer traces');
  });
});

/**
 * The content override is the riskiest of the scopes to get wrong under load:
 * it decides whether customer data leaves the process, so a bleed is a leak
 * rather than a mislabelling.
 */
describe('concurrent content overrides', () => {
  it('do not cross-contaminate at export', async () => {
    const { collector, provider, foreignTracer } = buildProvider({ content: { capture: 'none' } });

    const emit = (name: string, capture: 'none' | 'full') =>
      withContent({ capture }, async () => {
        await jitter();
        foreignTracer.startSpan(name, { attributes: { ...CONTENT } }).end();
      });

    await withPolicy({ capture: 'none' }, () =>
      withGlobalTracerProvider(provider, async () => {
        await Promise.all(
          Array.from({ length: 20 }, (_, index) =>
            emit(`span-${index}`, index % 2 === 0 ? 'full' : 'none'),
          ),
        );
      }),
    );

    for (let index = 0; index < 20; index += 1) {
      const span = collector.named(`span-${index}`);
      if (index % 2 === 0) {
        assert.equal(
          span.attributes['gen_ai.input.messages'],
          CONTENT['gen_ai.input.messages'],
          `span-${index} opted in and must carry content`,
        );
      } else {
        assert.equal(
          span.attributes['gen_ai.input.messages'],
          undefined,
          `span-${index} did not opt in and must not`,
        );
      }
    }
  });
});

describe('work that outlives the scope that started it', () => {
  /**
   * A tool call kicked off inside a workflow and awaited after it returns still
   * belongs to that run. This is `AsyncLocalStorage` semantics rather than a
   * decision of ours, but the product depends on it, so it is pinned.
   */
  it('still carries the run it was started in', async () => {
    const { collector, provider, foreignTracer } = buildProvider({ content: { capture: 'none' } });
    let detached: Promise<void> | undefined;

    await withPolicy({ capture: 'none' }, () =>
      withGlobalTracerProvider(provider, async () => {
        await withWorkflow({ name: 'chat-turn', runId: 'run-detached' }, async () => {
          detached = (async () => {
            await jitter();
            foreignTracer.startSpan('late-span').end();
          })();
        });
        await detached;
      }),
    );

    assert.equal(collector.named('late-span').attributes['octic.run.id'], 'run-detached');
  });
});
