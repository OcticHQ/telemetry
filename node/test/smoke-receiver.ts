/**
 * End-to-end redaction proof that needs no API key.
 *
 * Drives the real `init()` — real exporters, real OTLP over HTTP, the real
 * receiver — and emits a span through a tracer whose scope name is a vendor's,
 * carrying the exact content keys the four measured stacks send. What lands in
 * receiver/captured/ is what a customer's ingest would receive.
 *
 *   cd receiver && node server.ts          # terminal 1
 *   OCTIC_CONTENT=none node test/smoke-receiver.ts
 *   OCTIC_CONTENT=full node test/smoke-receiver.ts
 */
import { trace } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { init } from '../src/index.ts';
import { withIdentity } from '../src/identity.ts';
import { withPrompt } from '../src/prompt.ts';
import { withTool, withWorkflow } from '../src/annotations.ts';

const capture = process.env.OCTIC_CONTENT as 'none' | 'metadata' | 'full' | undefined;

const telemetry = init({
  endpoint: process.env.OCTIC_ENDPOINT ?? 'http://127.0.0.1:8400',
  auth: { kind: 'apiKey', apiKey: process.env.OCTIC_API_KEY ?? 'poc-token' },
  spool: { mode: 'fallback' },
  serviceName: 'smoke-redaction',
  agent: {
    id: 'weather-assistant',
    name: 'Weather Assistant',
    assetRef: 'poc/agent/weather-assistant',
  },
  environment: 'production',
  /**
   * Omitted rather than passed as undefined when the variable is unset, because
   * `exactOptionalPropertyTypes` makes those two different things — and the
   * difference is load-bearing here: absent means "whatever the SDK defaults
   * to", which is the case this smoke is meant to exercise unmodified.
   */
  ...(capture === undefined ? {} : { content: { capture } }),
});

/** Stands in for instrumentation that has never heard of us. */
const vendor = trace.getTracer('@vendor/instrumentation-openai', '0.19.0');

await withIdentity({ conversationId: 'conv-smoke', userId: 'user-42' }, () =>
  withWorkflow(
    { name: 'chat-turn', input: { message: 'my card is 4111 1111 1111 1111' } },
    async () => {
      await withPrompt({ template: 'weather-assistant', version: '3' }, async () => {
        const span = vendor.startSpan('chat gpt-5', {
          attributes: {
            'gen_ai.operation.name': 'chat',
            'gen_ai.request.model': 'gpt-5',
            'gen_ai.usage.input_tokens': 5200,
            'gen_ai.usage.output_tokens': 2100,
            'gen_ai.input.messages':
              '[{"role":"user","parts":[{"type":"text","content":"my card is 4111 1111 1111 1111"}]}]',
            'gen_ai.output.messages':
              '[{"role":"assistant","parts":[{"type":"text","content":"It is 14C in Paris."}]}]',
          },
        });
        span.end();

        /** The other half: instrumentation-openai puts all content here instead. */
        logs.getLogger('@vendor/instrumentation-openai').emit({
          attributes: { 'event.name': 'gen_ai.user.message' },
          body: { content: 'my card is 4111 1111 1111 1111' },
        });
      });

      /**
       * A failure whose message quotes the customer's data, which is the ordinary
       * case rather than a contrived one — an error string is written by code that
       * was holding the prompt a moment earlier.
       *
       * It reaches the wire by two routes at once: `exception.message` and
       * `exception.stacktrace` as span *event* attributes, and the same text again
       * on the span status. Both used to bypass redaction entirely, so this is the
       * span to inspect in receiver/captured/ when checking the fix end to end.
       */
      await withTool({ name: 'charge_card', input: { last4: '1111' } }, async () => {
        throw new Error('declined: card 4111 1111 1111 1111 has insufficient funds');
      }).catch(() => undefined);

      return { reply: 'It is 14C in Paris.' };
    },
  ),
);

await telemetry.forceFlush();
await telemetry.shutdown();
console.log(`smoke sent with OCTIC_CONTENT=${capture}`);
