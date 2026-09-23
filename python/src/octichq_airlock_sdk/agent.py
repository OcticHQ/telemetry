"""Which agent produced this span.

Under a governance framing this is the primary key, not a label: the product
groups traces by agent, and a policy hit reads "this agent is unsanctioned",
which only means something if the agent in the trace resolves to the same node an
integration discovered in the asset graph. That is what ``asset_ref`` is for.

Usually one deployment is one agent, so it is declared once at startup and lands
on every span as a resource attribute for free. This scope exists for the other
case — an orchestrator process hosting several — where it overrides the resource
value per run.
"""

from __future__ import annotations

from dataclasses import dataclass

from .attributes import (
    ATTR_GEN_AI_AGENT_ID,
    ATTR_GEN_AI_AGENT_NAME,
    ATTR_OCTIC_AGENT_ASSET_REF,
)
from .context_scope import AttributeMap, ContextScope, ScopeBinding


@dataclass(frozen=True)
class Agent:
    agent_id: str
    name: str | None = None
    #: This agent as a discovered asset. The graph join key.
    asset_ref: str | None = None


def agent_attributes(agent: Agent) -> AttributeMap:
    """Shared with startup, so the resource and the context agree on names."""
    attributes: AttributeMap = {ATTR_GEN_AI_AGENT_ID: agent.agent_id}
    if agent.name is not None:
        attributes[ATTR_GEN_AI_AGENT_NAME] = agent.name
    if agent.asset_ref is not None:
        attributes[ATTR_OCTIC_AGENT_ASSET_REF] = agent.asset_ref
    return attributes


agent_scope = ContextScope[Agent](key="octic.agent", to_attributes=agent_attributes)


def with_agent(
    *,
    agent_id: str,
    name: str | None = None,
    asset_ref: str | None = None,
) -> ScopeBinding[Agent]:
    """Declare the agent for everything started inside the returned scope.

    Only needed when one process runs more than one agent — otherwise declare it
    once at startup. An inner declaration replaces an outer one rather than
    merging with it: two agents are two agents.
    """
    return agent_scope.bind(Agent(agent_id=agent_id, name=name, asset_ref=asset_ref))
