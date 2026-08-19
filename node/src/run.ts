/**
 * The run id — one agent run, named by something a person can quote.
 *
 * A trace id would technically identify a run, but it is opaque, chosen by the
 * SDK rather than the application, and unusable as the thing a ticket refers to
 * or a later write (an evaluation score, a thumbs-up arriving an hour after the
 * trace closed) keys off. The product mocks show `run-mkt-0412`, so the id has
 * to be ours to mint.
 *
 * It lives in its own scope, separate from the annotation that sets it, because
 * `withWorkflow` writes it and the processor reads it — putting it in
 * annotations.ts would make the two import each other.
 *
 * Scoping it rather than only stamping the workflow span is what lets ingest
 * attribute any span to its run without walking the parent chain, which also
 * happens to be what the mock's flat, offset-positioned waterfall needs.
 */
import { randomBytes } from 'node:crypto';
import { context } from '@opentelemetry/api';
import { ATTR_OCTIC_RUN_ID } from './attributes.ts';
import { createContextScope } from './context-scope.ts';

export interface Run {
  id: string;
}

export const runScope = createContextScope<Run>({
  key: 'octic.run',
  toAttributes: ({ id }) => ({ [ATTR_OCTIC_RUN_ID]: id }),
});

/**
 * The run id in effect right now. Read it inside a `withWorkflow` callback to
 * log it or return it in the response.
 *
 * `withWorkflow` deliberately does not return the id — it returns whatever the
 * wrapped work returns, and distorting that to hand back metadata would make
 * every call site unwrap a tuple for the benefit of the few that care.
 */
export const currentRunId = (): string | undefined => runScope.from(context.active())?.id;

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24) || 'run';

/** `run-chat-turn-a3f9c1`. Readable prefix, enough entropy to not collide. */
export const mintRunId = (name: string): string =>
  `run-${slug(name)}-${randomBytes(8).toString('hex')}`;
