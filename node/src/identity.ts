/**
 * Durable identity — the level above a single agent run.
 *
 * A conversation spans many HTTP requests, many processes, possibly many days.
 * That cannot be a span: a span has to start and end inside one process, and a
 * conversation may never end. So identity is carried on the OTel Context and
 * stamped onto spans as attributes, with conversation membership resolved by
 * query later.
 *
 * Under the governance framing these are filters rather than the headline — the
 * primary key is the agent (see agent.ts). They stay optional and stay here,
 * because "what did this customer experience and what did it cost" is not
 * answerable after the fact if nobody recorded it at the time.
 *
 * Nothing here emits a span.
 */
import { context } from '@opentelemetry/api';
import {
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_SESSION_ID,
  ATTR_USER_ID,
  CUSTOMER_ATTRIBUTE_PREFIX,
} from './attributes.ts';
import { createContextScope } from './context-scope.ts';

export interface Identity {
  /** Groups many runs, across many requests, into one conversation. */
  conversationId?: string;
  /** The end user, as the tenant identifies them. Consider a pseudonymous id. */
  userId?: string;
  /**
   * Tenant-side business identifiers. Stamped under `octic.custom.`, not
   * `octic.` — see the note on the mapping below.
   */
  attributes?: Record<string, string | number | boolean>
}

export const identityScope = createContextScope<Identity>({
  key: 'octic.identity',
  merge: (existing, incoming) => ({
    ...existing,
    ...incoming,
    attributes: { ...existing.attributes, ...incoming.attributes },
  }),
  toAttributes: ({ conversationId, userId, attributes }) => ({
    ...(conversationId === undefined
      ? {}
      : {
          [ATTR_GEN_AI_CONVERSATION_ID]: conversationId,
          /**
           * Written twice on purpose. `gen_ai.conversation.id` is the
           * GenAI-specific name; `session.id` is the general one that non-GenAI
           * tooling already understands. Both are experimental, and which
           * survives is not ours to decide — writing both costs one attribute
           * and avoids a migration.
           */
          [ATTR_SESSION_ID]: conversationId,
        }),
    ...(userId === undefined ? {} : { [ATTR_USER_ID]: userId }),
    /**
     * Under `octic.custom.`, never bare `octic.`.
     *
     * These are the tenant's strings, and the reserved namespace is ours. With
     * one prefix a tenant passing `{ 'run.id': ... }` produced `octic.run.id` —
     * and it won, because span-option attributes are applied when the span is
     * constructed while this stamps in `onStart`, which runs after. The graph
     * join key was overwritable by a caller who had no idea it existed. Two
     * prefixes make the collision unrepresentable rather than merely unlikely.
     */
    ...Object.fromEntries(
      Object.entries(attributes ?? {}).map(([key, value]) => [
        `${CUSTOMER_ATTRIBUTE_PREFIX}${key}`,
        value,
      ]),
    ),
  }),
});

export const identityFrom = identityScope.from;
export const withIdentityContext = identityScope.contextWith;

/** Runs `fn` with `identity` attached to every span started inside it. */
export const withIdentity = identityScope.with;

/**
 * The form most consumers will actually use: set identity once, at the request
 * boundary, rather than wrapping each agent call.
 *
 * Structurally compatible with a Fastify hook but typed generically, so this
 * package takes no web-framework dependency. Calling `done()` *inside*
 * `context.with` is what makes the context flow to the route handler — the rest
 * of the request chains off that call.
 *
 *   fastify.addHook('preHandler', identityHook(req => ({
 *     conversationId: req.body.conversationId,
 *     userId: req.body.userId,
 *   })));
 */
export const identityHook =
  <Request>(extract: (request: Request) => Identity) =>
  (request: Request, _reply: unknown, done: () => void): void => {
    context.with(withIdentityContext(context.active(), extract(request)), done);
  };
