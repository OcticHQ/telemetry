/**
 * Which prompt template produced this model call.
 *
 * Nothing can infer this. Instrumentation sees the rendered string on the wire
 * and has no idea it came from `compliance-report-v3` — only the application
 * that rendered it knows, and "which prompt version produced this output, and
 * what else did that version produce" is near the top of the audit questions.
 *
 * Context-scoped rather than a wrapper span for two reasons: it lands on the
 * LLM span the instrumentation created, where the product mock shows it, and a
 * run making two model calls from two different templates records both. An
 * attribute on the workflow span could only record one.
 */
import { ATTR_GEN_AI_PROMPT_NAME, ATTR_OCTIC_PROMPT_VERSION } from './attributes.ts';
import { createContextScope } from './context-scope.ts';

export interface Prompt {
  /** Template identity, e.g. `compliance-report-v3`. */
  template: string;
  /** Semconv names the prompt but not its version, and the version is the question. */
  version?: string;
}

export const promptScope = createContextScope<Prompt>({
  key: 'octic.prompt',
  toAttributes: ({ template, version }) => ({
    [ATTR_GEN_AI_PROMPT_NAME]: template,
    ...(version === undefined ? {} : { [ATTR_OCTIC_PROMPT_VERSION]: version }),
  }),
});

/** Wrap the model call, not the whole run — the scope should be as tight as the claim. */
export const withPrompt = promptScope.with;
