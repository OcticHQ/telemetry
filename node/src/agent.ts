/**
 * Which agent produced this span.
 *
 * Under a governance framing this is the primary key, not a label: the product
 * groups traces by agent, and a policy hit reads "this agent is unsanctioned",
 * which only means something if the agent in the trace resolves to the same node
 * an integration discovered in the asset graph. That is what `assetRef` is for.
 *
 * Usually one deployment is one agent, so it is declared once in `init()` and
 * lands on every span as a resource attribute for free. This scope exists for
 * the other case — an orchestrator process hosting several — where it overrides
 * the resource value per run.
 */
import {
  ATTR_GEN_AI_AGENT_ID,
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_OCTIC_AGENT_ASSET_REF,
} from './attributes.ts';
import { createContextScope } from './context-scope.ts';

export interface Agent {
  id: string;
  name?: string;
  /** This agent as a discovered asset. The graph join key. */
  assetRef?: string;
}

/** Shared with init(), so the resource and the context agree on names. */
export const agentAttributes = ({ id, name, assetRef }: Agent) => ({
  [ATTR_GEN_AI_AGENT_ID]: id,
  ...(name === undefined ? {} : { [ATTR_GEN_AI_AGENT_NAME]: name }),
  ...(assetRef === undefined ? {} : { [ATTR_OCTIC_AGENT_ASSET_REF]: assetRef }),
});

export const agentScope = createContextScope<Agent>({
  key: 'octic.agent',
  toAttributes: agentAttributes,
});

/**
 * Declares the agent for everything started inside `fn`. Only needed when one
 * process runs more than one agent — otherwise set it in `init()`.
 */
export const withAgent = agentScope.with;
