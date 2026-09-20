"""Which prompt template produced this model call.

Nothing can infer this. Instrumentation sees the rendered string on the wire and
has no idea which template it came from — only the application that rendered it
knows, and "which prompt version produced this output, and what else did that
version produce" is near the top of the audit questions.

Context-scoped rather than a wrapper span for two reasons: it lands on the LLM
span the instrumentation created, which is where it belongs, and a run making two
model calls from two different templates records both. An attribute on the
workflow span could only record one.
"""

from __future__ import annotations

from dataclasses import dataclass

from .attributes import ATTR_GEN_AI_PROMPT_NAME, ATTR_OCTIC_PROMPT_VERSION
from .context_scope import AttributeMap, ContextScope, ScopeBinding


@dataclass(frozen=True)
class Prompt:
    #: Template identity, e.g. `compliance-report-v3`.
    template: str
    #: Semconv names the prompt but not its version, and the version is the question.
    version: str | None = None


def _to_attributes(prompt: Prompt) -> AttributeMap:
    attributes: AttributeMap = {ATTR_GEN_AI_PROMPT_NAME: prompt.template}
    if prompt.version is not None:
        attributes[ATTR_OCTIC_PROMPT_VERSION] = prompt.version
    return attributes


prompt_scope = ContextScope[Prompt](key="octic.prompt", to_attributes=_to_attributes)


def with_prompt(*, template: str, version: str | None = None) -> ScopeBinding[Prompt]:
    """Wrap the model call, not the whole run — the scope should be as tight as the claim."""
    return prompt_scope.bind(Prompt(template=template, version=version))
