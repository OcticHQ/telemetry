/**
 * Generates every artifact derived from contract/attributes.yaml.
 *
 *   node contract/generate.ts            write the artifacts
 *   node contract/generate.ts --check    fail if they are stale, or if the
 *                                        hand-written SDK lists have drifted
 *
 * The YAML is never read at runtime. It is a build-time source, because the SDK
 * is going to be ported to other languages and a TypeScript file cannot be the
 * spec for a Python port. Adding a language means adding an emitter here, not
 * translating a file by hand.
 *
 * The `--check` mode is what CI runs, and it is the half that matters. It
 * catches two different failures: an artifact regenerated from a newer YAML and
 * not committed, and an SDK's hand-maintained lists diverging from the
 * contract. The second is the leak-shaped one — content.ts deciding a key is not
 * content when the contract says it is.
 *
 * The language targets are the `LANGUAGES` table near the bottom.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SOURCE = join(HERE, 'attributes.yaml');

/**
 * The published spec. Language-neutral, and the only artifact an external
 * reader — or be-ingest, which cannot import a public SDK — is expected to
 * consume.
 */
const OUT_MD = join(HERE, 'ATTRIBUTES.md');

// ── the shape of the contract ───────────────────────────────────────────────

type Requirement = 'required' | 'conditionally_required' | 'recommended' | 'opt_in';
type AttributeClass = 'identity' | 'metadata' | 'content' | 'environment';

interface EnumMember {
  value: string;
  semconv?: string;
  brief?: string;
}

interface AttributeSpec {
  id: string;
  type: string;
  requirement: Requirement;
  class: AttributeClass;
  owner: 'octic' | 'semconv';
  semconv?: string;
  enum?: EnumMember[];
  propagated?: boolean;
  internal?: boolean;
  condition?: string;
  emitted_on?: string[];
  examples?: (string | number | boolean)[];
  brief: string;
  note?: string;
}

interface FieldSpec {
  id: string;
  type: string;
  aliases: string[];
  normalize?: Record<string, string>;
  emitted_by?: Record<string, string>;
  class?: AttributeClass;
  brief: string;
}

interface Group {
  id: string;
  stability: 'emitted' | 'consumed' | 'denied';
  brief: string;
  level?: 'resource' | 'span';
  fallback_level?: 'resource' | 'span';
  propagated?: boolean;
  policy?: 'deny';
  class?: AttributeClass;
  attributes?: AttributeSpec[];
  fields?: FieldSpec[];
  keys?: string[];
}

interface OpenDecision {
  id: string;
  affects: string[];
  question: string;
}

interface Contract {
  schema_version: number;
  namespaces: { reserved: string; customer: string };
  content: { patterns: string[]; heuristic_min_length: number };
  open_decisions?: OpenDecision[];
  groups: Group[];
}

// ── small helpers ───────────────────────────────────────────────────────────

const REQUIREMENTS: Requirement[] = [
  'required',
  'conditionally_required',
  'recommended',
  'opt_in',
];
const CLASSES: AttributeClass[] = ['identity', 'metadata', 'content', 'environment'];

/** YAML folded scalars keep their newlines; tables and doc comments want one line. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

const constantName = (key: string): string => `ATTR_${key.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;

const enumConstantName = (key: string): string =>
  `${key.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_VALUES`;

/**
 * Semconv publishes value constants for some enums and not others — it has
 * `GEN_AI_OPERATION_NAME_VALUE_RETRIEVAL` but nothing for `gen_ai.tool.type`.
 * Where it does, reuse its name so importers are unsurprised; where it does
 * not, mint the same shape. Either way callers get a symbol rather than writing
 * `'function'` by hand, which is how value drift starts.
 */
const enumMemberName = (key: string, member: EnumMember): string =>
  member.semconv ??
  `${key.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_VALUE_${member.value.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;

const quote = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** The same for Python, which prefers double quotes and knows nothing of TypeScript's escapes. */
const pyQuote = (value: string): string =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * A raw literal, so a regex reaches Python exactly as the contract wrote it.
 * Raw literals cannot carry an escaped quote or end on a backslash; those fall
 * back to an ordinary string, where the doubled backslash is the escape rather
 * than part of the pattern.
 */
const pyRaw = (value: string): string =>
  value.includes('"') || value.endsWith('\\') ? pyQuote(value) : `r"${value}"`;

const attributesOf = (contract: Contract): AttributeSpec[] =>
  contract.groups.flatMap(group => group.attributes ?? []);

const fieldsOf = (contract: Contract): FieldSpec[] =>
  contract.groups.flatMap(group => group.fields ?? []);

/** A brief and its note as one sentence, which is how every doc emitter wants them. */
const prose = (brief: string, note: string | undefined): string =>
  note === undefined ? brief : `${brief} ${note}`;

/**
 * Greedy wrap, shared by every doc emitter. One wrapper rather than one per
 * language, so the same brief cannot come out differently in two SDKs.
 */
const wrap = (text: string, width = 76): string[] => {
  const lines: string[] = [];
  let current = '';
  for (const word of oneLine(text).split(' ')) {
    if (current.length + word.length + 1 > width) {
      lines.push(current);
      current = word;
    } else {
      current = current === '' ? word : `${current} ${word}`;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
};

/** Wraps a brief into a JSDoc block, so the generated constants read like the hand-written ones. */
const docComment = (brief: string, note: string | undefined, indent = ''): string => {
  const lines = wrap(prose(brief, note));
  if (lines.length === 1) return `${indent}/** ${lines[0]} */`;
  return [`${indent}/**`, ...lines.map(line => `${indent} * ${line}`), `${indent} */`].join('\n');
};

/**
 * The Python equivalent: a string literal directly under the assignment. PEP 224
 * never made those load-bearing at runtime, but editors and doc tools read them,
 * which is what the JSDoc above buys the Node constants.
 *
 * Raw when the text carries a backslash, and padded when it ends in a quote —
 * either would otherwise produce a docstring that does not parse.
 */
const TRIPLE = '"'.repeat(3);

const pyDoc = (brief: string, note: string | undefined, indent = ''): string => {
  const text = oneLine(prose(brief, note)).split(TRIPLE).join("'''");
  const prefix = text.includes('\\') ? 'r' : '';
  const lines = wrap(text, 76 - indent.length);
  const last = lines.length - 1;
  if (lines[last]?.endsWith('"') === true) lines[last] = `${lines[last]} `;
  if (lines.length === 1) return `${indent}${prefix}${TRIPLE}${lines[0]}${TRIPLE}`;
  return [
    `${indent}${prefix}${TRIPLE}`,
    ...lines.map(line => `${indent}${line}`),
    `${indent}${TRIPLE}`,
  ].join('\n');
};

/** The same wrap as a Python comment block, for the places a docstring cannot go. */
const pyComment = (text: string, indent = ''): string =>
  wrap(text, 74 - indent.length)
    .map(line => `${indent}# ${line}`)
    .join('\n');

// ── derived views over the contract ─────────────────────────────────────────

/**
 * Every key that carries customer content, from all three populations at once:
 * our own annotation output, the aliases of consumed fields marked content, and
 * vendor keys with no canonical field. Derived rather than listed, so the SDK's
 * redaction list cannot disagree with the published document.
 *
 * Internal keys are excluded — they never reach the wire, so classifying them
 * would only widen the list.
 */
const contentKeys = (contract: Contract): string[] => {
  const keys = new Set<string>();
  for (const attribute of attributesOf(contract)) {
    if (attribute.class === 'content' && attribute.internal !== true) keys.add(attribute.id);
  }
  for (const field of fieldsOf(contract)) {
    if (field.class === 'content') for (const alias of field.aliases) keys.add(alias);
  }
  for (const group of contract.groups) {
    if (group.class === 'content') for (const key of group.keys ?? []) keys.add(key);
  }
  return [...keys].sort();
};

const deniedKeys = (contract: Contract): string[] =>
  contract.groups
    .filter(group => group.policy === 'deny')
    .flatMap(group => group.keys ?? [])
    .sort();

const emittedKeys = (contract: Contract): string[] =>
  attributesOf(contract)
    .filter(attribute => attribute.internal !== true)
    .map(attribute => attribute.id)
    .sort();

const internalKeys = (contract: Contract): string[] =>
  attributesOf(contract)
    .filter(attribute => attribute.internal === true)
    .map(attribute => attribute.id)
    .sort();

// ── validation ──────────────────────────────────────────────────────────────

/**
 * Runs before anything is written. A contract that generates cleanly but is
 * internally inconsistent is worse than one that fails loudly — the whole point
 * of a single source is that it cannot quietly disagree with itself.
 */
const validate = (contract: Contract): string[] => {
  const problems: string[] = [];
  const { reserved, customer } = contract.namespaces;

  if (!customer.startsWith(reserved) || customer === reserved) {
    problems.push(
      `namespaces: customer prefix ${quote(customer)} must sit strictly inside reserved ${quote(reserved)}`,
    );
  }

  const seen = new Map<string, string>();
  const claim = (key: string, where: string): void => {
    const previous = seen.get(key);
    if (previous !== undefined) problems.push(`${key}: declared twice (${previous}, ${where})`);
    else seen.set(key, where);
  };

  for (const group of contract.groups) {
    for (const attribute of group.attributes ?? []) {
      claim(attribute.id, group.id);

      if (!REQUIREMENTS.includes(attribute.requirement)) {
        problems.push(`${attribute.id}: unknown requirement ${quote(attribute.requirement)}`);
      }
      if (!CLASSES.includes(attribute.class)) {
        problems.push(`${attribute.id}: unknown class ${quote(attribute.class)}`);
      }
      if (attribute.owner === 'semconv' && attribute.semconv === undefined) {
        problems.push(`${attribute.id}: owner is semconv but no constant name given`);
      }
      if (attribute.owner === 'octic' && !attribute.id.startsWith(reserved)) {
        problems.push(`${attribute.id}: owned by us but outside the reserved ${quote(reserved)} namespace`);
      }
      if (attribute.id.startsWith(customer)) {
        problems.push(`${attribute.id}: sits in the customer namespace ${quote(customer)}, which we must not write`);
      }
      if (attribute.requirement === 'conditionally_required' && attribute.condition === undefined) {
        problems.push(`${attribute.id}: conditionally_required with no condition`);
      }
    }

    for (const key of group.keys ?? []) claim(key, group.id);
  }

  /**
   * Two fields claiming one alias makes the resolver ambiguous — whichever is
   * consulted first wins, silently, and which that is depends on iteration
   * order. Cheap to check, impossible to debug later.
   */
  const aliasOwners = new Map<string, string>();
  for (const field of fieldsOf(contract)) {
    if (field.aliases.length === 0) problems.push(`${field.id}: no aliases`);
    for (const alias of field.aliases) {
      const previous = aliasOwners.get(alias);
      if (previous !== undefined) problems.push(`${alias}: claimed by both ${previous} and ${field.id}`);
      else aliasOwners.set(alias, field.id);
    }
    for (const [from, to] of Object.entries(field.normalize ?? {})) {
      if (from === to) problems.push(`${field.id}: normalize maps ${quote(from)} to itself`);
    }
  }

  for (const pattern of contract.content.patterns) {
    try {
      new RegExp(pattern);
    } catch (error) {
      problems.push(`content pattern ${quote(pattern)} does not compile: ${String(error)}`);
    }
  }

  problems.push(...validateSemconv(contract));
  return problems;
};

/**
 * Every semconv name we claim must exist in the pinned release. This is the
 * check that caught `gen_ai.conversation.id` living in `/incubating` rather than
 * the stable root the first time round, and it is the one that will notice a
 * semconv upgrade removing something under us.
 *
 * Resolved from the generator's own node_modules, not an SDK's, so the check
 * does not depend on which languages happen to be installed. The version is
 * pinned in contract/package.json and must track the range the Node SDK pins;
 * a mismatch surfaces here as a failed constant, which is the point.
 *
 * Best-effort: a checkout without an install should not fail the whole run.
 */
const validateSemconv = (contract: Contract): string[] => {
  let semconv: Record<string, string>;
  try {
    const require = createRequire(join(HERE, 'package.json'));
    semconv = require('@opentelemetry/semantic-conventions/incubating') as Record<string, string>;
  } catch {
    process.stderr.write('note: semconv not resolvable, skipping constant verification\n');
    return [];
  }

  const problems: string[] = [];
  for (const attribute of attributesOf(contract)) {
    if (attribute.semconv === undefined) continue;
    const actual = semconv[attribute.semconv];
    if (actual === undefined) {
      problems.push(`${attribute.id}: semconv exports no ${attribute.semconv}`);
    } else if (actual !== attribute.id) {
      problems.push(`${attribute.id}: semconv ${attribute.semconv} is ${quote(actual)}`);
    }
    for (const member of attribute.enum ?? []) {
      if (member.semconv === undefined) continue;
      const value = semconv[member.semconv];
      if (value === undefined) problems.push(`${attribute.id}: semconv exports no ${member.semconv}`);
      else if (value !== member.value) {
        problems.push(`${attribute.id}: semconv ${member.semconv} is ${quote(value)}, not ${quote(member.value)}`);
      }
    }
  }
  return problems;
};

// ── the TypeScript emitter ──────────────────────────────────────────────────

/**
 * What varies between TypeScript artifacts. The emitter is shared because two
 * hand-written emitters for one language is the translation this contract
 * exists to forbid — but a file landing in another repo cannot carry this
 * repo's header, and has no use for provenance aimed at this repo's tests.
 */
interface TypeScriptOptions {
  /** Header body, one entry per line. `''` becomes a bare ` *`. */
  header: (contract: Contract) => string[];
  /** Emit SEMCONV_NAMES. Provenance for contract.test.ts; noise anywhere else. */
  semconvNames: boolean;
}

/** The header the in-repo SDK artifact carries. */
const sdkTypeScriptHeader = (contract: Contract): string[] => [
  'GENERATED — do not edit.',
  '',
  `Source:     contract/attributes.yaml (schema_version ${contract.schema_version})`,
  'Regenerate: node contract/generate.ts',
  '',
  'Everything the SDK writes, everything ingest reads, and the redaction',
  'policy shared by both, from one source. The equivalent file for another',
  'language is another emitter in the generator, never a translation of this.',
  '',
  'No imports, deliberately. be-ingest and be-worker both need',
  'these names and none of them should take a semantic-conventions dependency',
  'to read a string. Semconv-owned keys therefore appear here as literals,',
  'under the same constant names the semconv package uses — the generator',
  'verifies every one of those names and values against the pinned release on',
  'each run, and contract.test.ts asserts it again at test time.',
];

const emitTypeScript = (
  contract: Contract,
  options: TypeScriptOptions = { header: sdkTypeScriptHeader, semconvNames: true },
): string => {
  const out: string[] = [];
  const w = (line = ''): void => void out.push(line);

  w('/**');
  for (const line of options.header(contract)) w(line === '' ? ' *' : ` * ${line}`);
  w(' */');
  w();

  w(docComment(
    'Version of the attribute contract this build was generated from. Emitted as octic.schema.version so a consumer can tell a missing attribute from an older SDK.',
    undefined,
  ));
  w(`export const OCTIC_SCHEMA_VERSION = '${contract.schema_version}';`);
  w();

  w(docComment('Ours. Nothing outside the SDK may write into this namespace.', undefined));
  w(`export const RESERVED_ATTRIBUTE_PREFIX = ${quote(contract.namespaces.reserved)};`);
  w();
  w(docComment(
    'Where tenant-supplied business identifiers land. Separate from the reserved prefix so a customer key can never overwrite one of ours.',
    undefined,
  ));
  w(`export const CUSTOMER_ATTRIBUTE_PREFIX = ${quote(contract.namespaces.customer)};`);
  w();

  for (const group of contract.groups) {
    const attributes = group.attributes ?? [];
    if (attributes.length === 0) continue;

    w(`// ── ${group.id} ${'─'.repeat(Math.max(0, 70 - group.id.length))}`);
    w();
    for (const attribute of attributes) {
      /**
       * Semconv-owned names are emitted here too, under the same constant names
       * the semconv package uses, rather than re-exported from it. One source
       * for every key beats one source per owner, and the import would put a
       * semconv dependency in front of every consumer. The link is not lost:
       * the generator checks each name and value against the pinned release on
       * every run, and contract.test.ts checks it again at test time.
       */
      const provenance =
        attribute.owner === 'semconv'
          ? `Semantic convention, verified against the pinned release as \`${attribute.semconv ?? ''}\`.`
          : undefined;
      w(docComment(attribute.brief, [attribute.note, provenance].filter(Boolean).join(' ') || undefined));
      w(`export const ${constantName(attribute.id)} = ${quote(attribute.id)};`);
      w();

      for (const member of attribute.enum ?? []) {
        w(docComment(member.brief ?? `\`${attribute.id}\` value.`, undefined));
        w(`export const ${enumMemberName(attribute.id, member)} = ${quote(member.value)};`);
        w();
      }

      if (attribute.enum === undefined) continue;
      w(docComment(`Permitted values for \`${attribute.id}\`.`, undefined));
      w(`export const ${enumConstantName(attribute.id)} = [`);
      for (const member of attribute.enum) {
        const suffix = member.brief === undefined ? '' : ` // ${oneLine(member.brief)}`;
        w(`  ${quote(member.value)},${suffix}`);
      }
      w('] as const;');
      w();
    }
  }

  w('// ── content policy ─────────────────────────────────────────────────────────');
  w();
  w(docComment(
    'Every key known to carry customer content, across our own output, the vendor keys we read, and vendor keys with no canonical field. Derived from the class column, so this list and the published document cannot disagree.',
    undefined,
  ));
  w('export const CONTENT_KEYS: readonly string[] = [');
  for (const key of contentKeys(contract)) w(`  ${quote(key)},`);
  w('];');
  w();
  w(docComment(
    'The half that catches what the list does not. A denylist alone fails open the day a vendor ships a key we have never seen.',
    undefined,
  ));
  w('export const CONTENT_PATTERNS: readonly RegExp[] = [');
  for (const pattern of contract.content.patterns) w(`  /${pattern}/,`);
  w('];');
  w();
  w(docComment(
    'A string longer than this, authored by a scope we do not control, is treated as content whatever it is called.',
    undefined,
  ));
  w(`export const CONTENT_HEURISTIC_MIN_LENGTH = ${contract.content.heuristic_min_length};`);
  w();
  w(docComment(
    'Resource attributes nobody asked for. Dropped at the SDK exporter for a customer who runs our SDK, and at ingest for one who does not.',
    undefined,
  ));
  w('export const RESOURCE_DENY: readonly string[] = [');
  for (const key of deniedKeys(contract)) w(`  ${quote(key)},`);
  w('];');
  w();

  w('// ── wire surface ───────────────────────────────────────────────────────────');
  w();
  w(docComment('Every attribute our SDK is permitted to put on the wire.', undefined));
  w('export const EMITTED_ATTRIBUTES: readonly string[] = [');
  for (const key of emittedKeys(contract)) w(`  ${quote(key)},`);
  w('];');
  w();
  w(docComment(
    'Plumbing that must never leave the process. A consumer that sees one of these is looking at output from a broken exporter.',
    undefined,
  ));
  w('export const INTERNAL_ATTRIBUTES: readonly string[] = [');
  for (const key of internalKeys(contract)) w(`  ${quote(key)},`);
  w('];');
  w();

  /**
   * Provenance, so the SDK's own test suite can re-check every semconv claim
   * without a hand-maintained list of them. A hand-maintained list is the
   * failure this whole contract exists to remove; one inside the test that
   * guards the contract would be a poor joke.
   */
  if (options.semconvNames) {
    w(docComment(
      'Every constant here that claims to be a semantic convention, mapped to the value semconv must still give it. The generator verifies this against the pinned release on each run; contract.test.ts iterates it to verify again at test time.',
      undefined,
    ));
    w('export const SEMCONV_NAMES: Readonly<Record<string, string>> = {');
    const claims = new Map<string, string>();
    for (const attribute of attributesOf(contract)) {
      if (attribute.semconv !== undefined) claims.set(attribute.semconv, attribute.id);
      for (const member of attribute.enum ?? []) {
        if (member.semconv !== undefined) claims.set(member.semconv, member.value);
      }
    }
    for (const [name, value] of [...claims].sort(([a], [b]) => (a < b ? -1 : 1))) {
      w(`  ${name}: ${quote(value)},`);
    }
    w('};');
    w();
  }

  w('// ── derived fields (attributes we read but do not own) ─────────────────────');
  w();
  w(docComment(
    'Facts foreign instrumentation records. Each entry is a canonical field, the aliases accepted for it in priority order, and any value normalisation. Resolve a field through this table rather than naming a vendor key directly: an upstream rename then costs an added alias, not a code change.',
    undefined,
  ));
  w('export const FIELDS = {');
  for (const field of fieldsOf(contract)) {
    w(docComment(field.brief, undefined, '  '));
    w(`  ${field.id}: {`);
    w(`    type: ${quote(field.type)},`);
    w(`    aliases: [${field.aliases.map(quote).join(', ')}],`);
    if (field.class !== undefined) w(`    class: ${quote(field.class)},`);
    if (field.normalize !== undefined) {
      const entries = Object.entries(field.normalize)
        .map(([from, to]) => `${quote(from)}: ${quote(to)}`)
        .join(', ');
      w(`    values: { ${entries} },`);
    }
    w('  },');
  }
  w('} as const;');
  w();
  w('export type DerivedField = keyof typeof FIELDS;');
  w();

  return out.join('\n');
};

// ── the Python emitter ──────────────────────────────────────────────────────

/**
 * The same contract as module-level constants, standard library only. Frozen
 * sequences are tuples because that is Python's `as const`, and nothing here
 * imports an OpenTelemetry package for the reason the TypeScript file does not:
 * a constants file that ingest can read without dragging a dependency along.
 *
 * One thing this emitter takes on trust. `validate` compiles the content
 * patterns with `new RegExp`, not with Python's `re`. Both patterns in the
 * contract today are portable, but a JavaScript-only construct would reach here
 * as a `re.compile` that raises at import rather than failing the generator.
 */
const emitPython = (contract: Contract): string => {
  const out: string[] = [];
  const w = (line = ''): void => void out.push(line);

  w(TRIPLE);
  w('GENERATED — do not edit.');
  w();
  w(`Source:     contract/attributes.yaml (schema_version ${contract.schema_version})`);
  w('Regenerate: node contract/generate.ts');
  w();
  w('Everything the SDK writes, everything ingest reads, and the redaction');
  w('policy shared by both, from one source. The equivalent file for another');
  w('language is another emitter in the generator, never a translation of this.');
  w();
  w('The standard library only, deliberately: nobody should need an');
  w('OpenTelemetry dependency in front of them to read a string. Semconv-owned');
  w('keys therefore appear here as literals, under the same constant names the');
  w('semconv package uses — the generator verifies every one of those names and');
  w('values against the pinned release on each run.');
  w(TRIPLE);
  w();
  w('import re');
  w('from typing import Literal');
  w();

  const constant = (name: string, value: string, brief: string, note?: string): void => {
    w(`${name} = ${value}`);
    w(pyDoc(brief, note));
    w();
  };

  constant(
    'OCTIC_SCHEMA_VERSION',
    pyQuote(String(contract.schema_version)),
    'Version of the attribute contract this build was generated from. Emitted as octic.schema.version so a consumer can tell a missing attribute from an older SDK.',
  );
  constant(
    'RESERVED_ATTRIBUTE_PREFIX',
    pyQuote(contract.namespaces.reserved),
    'Ours. Nothing outside the SDK may write into this namespace.',
  );
  constant(
    'CUSTOMER_ATTRIBUTE_PREFIX',
    pyQuote(contract.namespaces.customer),
    'Where tenant-supplied business identifiers land. Separate from the reserved prefix so a customer key can never overwrite one of ours.',
  );

  for (const group of contract.groups) {
    const attributes = group.attributes ?? [];
    if (attributes.length === 0) continue;

    w(`# ── ${group.id} ${'─'.repeat(Math.max(0, 68 - group.id.length))}`);
    w();
    for (const attribute of attributes) {
      const provenance =
        attribute.owner === 'semconv'
          ? `Semantic convention, verified against the pinned release as \`${attribute.semconv ?? ''}\`.`
          : undefined;
      constant(
        constantName(attribute.id),
        pyQuote(attribute.id),
        attribute.brief,
        [attribute.note, provenance].filter(Boolean).join(' ') || undefined,
      );

      for (const member of attribute.enum ?? []) {
        constant(
          enumMemberName(attribute.id, member),
          pyQuote(member.value),
          member.brief ?? `\`${attribute.id}\` value.`,
        );
      }

      if (attribute.enum === undefined) continue;
      w(`${enumConstantName(attribute.id)}: tuple[str, ...] = (`);
      for (const member of attribute.enum) {
        const suffix = member.brief === undefined ? '' : `  # ${oneLine(member.brief)}`;
        w(`    ${pyQuote(member.value)},${suffix}`);
      }
      w(')');
      w(pyDoc(`Permitted values for \`${attribute.id}\`.`, undefined));
      w();
    }
  }

  const tuple = (name: string, keys: string[], brief: string): void => {
    w(`${name}: tuple[str, ...] = (`);
    for (const key of keys) w(`    ${pyQuote(key)},`);
    w(')');
    w(pyDoc(brief, undefined));
    w();
  };

  w('# ── content policy ──────────────────────────────────────────────────────');
  w();
  tuple(
    'CONTENT_KEYS',
    contentKeys(contract),
    'Every key known to carry customer content, across our own output, the vendor keys we read, and vendor keys with no canonical field. Derived from the class column, so this list and the published document cannot disagree.',
  );
  w('CONTENT_PATTERNS: tuple[re.Pattern[str], ...] = (');
  for (const pattern of contract.content.patterns) w(`    re.compile(${pyRaw(pattern)}),`);
  w(')');
  w(
    pyDoc(
      'The half that catches what the list does not. A denylist alone fails open the day a vendor ships a key we have never seen.',
      undefined,
    ),
  );
  w();
  constant(
    'CONTENT_HEURISTIC_MIN_LENGTH',
    String(contract.content.heuristic_min_length),
    'A string longer than this, authored by a scope we do not control, is treated as content whatever it is called.',
  );
  tuple(
    'RESOURCE_DENY',
    deniedKeys(contract),
    'Resource attributes nobody asked for. Dropped at the SDK exporter for a customer who runs our SDK, and at ingest for one who does not.',
  );

  w('# ── wire surface ────────────────────────────────────────────────────────');
  w();
  tuple(
    'EMITTED_ATTRIBUTES',
    emittedKeys(contract),
    'Every attribute our SDK is permitted to put on the wire.',
  );
  tuple(
    'INTERNAL_ATTRIBUTES',
    internalKeys(contract),
    'Plumbing that must never leave the process. A consumer that sees one of these is looking at output from a broken exporter.',
  );

  w('SEMCONV_NAMES: dict[str, str] = {');
  const claims = new Map<string, string>();
  for (const attribute of attributesOf(contract)) {
    if (attribute.semconv !== undefined) claims.set(attribute.semconv, attribute.id);
    for (const member of attribute.enum ?? []) {
      if (member.semconv !== undefined) claims.set(member.semconv, member.value);
    }
  }
  for (const [name, value] of [...claims].sort(([a], [b]) => (a < b ? -1 : 1))) {
    w(`    ${pyQuote(name)}: ${pyQuote(value)},`);
  }
  w('}');
  w(
    pyDoc(
      'Every constant here that claims to be a semantic convention, mapped to the value semconv must still give it. The generator verifies this against the pinned release on each run, so a port can assert the same thing without resolving a semconv package.',
      undefined,
    ),
  );
  w();

  w('# ── derived fields (attributes we read but do not own) ───────────────────');
  w();
  w('FIELDS: dict[str, dict[str, object]] = {');
  for (const field of fieldsOf(contract)) {
    w(pyComment(field.brief, '    '));
    w(`    ${pyQuote(field.id)}: {`);
    w(`        ${pyQuote('type')}: ${pyQuote(field.type)},`);
    // A one-element tuple needs its trailing comma, or it is just a string.
    const aliases = field.aliases.map(pyQuote).join(', ');
    w(`        ${pyQuote('aliases')}: (${aliases}${field.aliases.length === 1 ? ',' : ''}),`);
    if (field.class !== undefined) w(`        ${pyQuote('class')}: ${pyQuote(field.class)},`);
    if (field.normalize !== undefined) {
      const entries = Object.entries(field.normalize)
        .map(([from, to]) => `${pyQuote(from)}: ${pyQuote(to)}`)
        .join(', ');
      w(`        ${pyQuote('values')}: {${entries}},`);
    }
    w('    },');
  }
  w('}');
  w(
    pyDoc(
      'Facts foreign instrumentation records. Each entry is a canonical field, the aliases accepted for it in priority order, and any value normalisation. Resolve a field through this table rather than naming a vendor key directly: an upstream rename then costs an added alias, not a code change.',
      undefined,
    ),
  );
  w();

  w('DerivedField = Literal[');
  for (const field of fieldsOf(contract)) w(`    ${pyQuote(field.id)},`);
  w(']');
  w(pyDoc('The canonical field names `FIELDS` resolves.', undefined));
  w();

  return out.join('\n');
};

// ── the Markdown emitter ────────────────────────────────────────────────────

const cell = (text: string): string => oneLine(text).replace(/\|/g, '\\|');

const emitMarkdown = (contract: Contract): string => {
  const out: string[] = [];
  const w = (line = ''): void => void out.push(line);

  w('# The Octic agent-telemetry attribute contract');
  w();
  w(`**Schema version ${contract.schema_version}.**`);
  w();
  w('<!-- GENERATED from contract/attributes.yaml by contract/generate.ts. Do not edit. -->');
  w();
  w('This is the document the SDK is written against, in every language, and the');
  w('document a consumer of our telemetry reads. It is generated, so it cannot');
  w('drift from the constants the code actually uses.');
  w();
  w('## What "frozen" means here');
  w();
  w('Three populations, frozen in three different senses.');
  w();
  w('| Stability | Who writes it | What the freeze commits us to |');
  w('|---|---|---|');
  w('| **emitted** | our SDK | An API promise. A rename is a major version with dual-write, because customer queries and our graph writes key off these. This half is also the port spec. |');
  w('| **consumed** | foreign instrumentation | The *reader*, not the key. We cannot freeze what we do not own, so what is fixed is the canonical field name, the accepted aliases and the value normalisation. An upstream rename is an additive alias. |');
  w('| **denied** | foreign instrumentation | The policy, not the list. The list grows as vendors ship new detectors. |');
  w();
  w('Frozen does not mean immutable, and it does not mean stored. It means');
  w('additive-only and versioned: removing a key or changing its type costs a');
  w('`schema_version` bump, and every payload carries the version it was written');
  w('against in `octic.schema.version`.');
  w();
  w('## Namespaces');
  w();
  w(`- \`${contract.namespaces.reserved}\` — reserved. Only the SDK writes here.`);
  w(`- \`${contract.namespaces.customer}\` — tenant-supplied business identifiers.`);
  w();
  w('Separate prefixes because they were not always: tenant attributes passed to');
  w('`withIdentity()` used to land as `octic.<key>`, in the same namespace as');
  w('`octic.run.id`. Span-option attributes are applied at construction and the');
  w('processor stamps in `onStart`, so a tenant key could overwrite one of ours.');
  w();

  for (const group of contract.groups) {
    w(`## \`${group.id}\``);
    w();
    const badges = [`*${group.stability}*`];
    if (group.level !== undefined) {
      const fallback =
        group.fallback_level === undefined ? '' : `, falling back to ${group.fallback_level}`;
      badges.push(`${group.level}-level${fallback}`);
    }
    if (group.propagated === true) badges.push('propagated onto foreign spans');
    w(badges.join(' · '));
    w();
    w(oneLine(group.brief));
    w();

    if (group.attributes !== undefined) {
      w('| Key | Type | Requirement | Class | Owner |');
      w('|---|---|---|---|---|');
      for (const attribute of group.attributes) {
        const flags: string[] = [];
        if (attribute.propagated === true) flags.push('propagated');
        if (attribute.internal === true) flags.push('**internal, never on the wire**');
        const requirement =
          attribute.condition === undefined
            ? attribute.requirement
            : `${attribute.requirement}<br/>*(${cell(attribute.condition)})*`;
        const key = flags.length === 0 ? `\`${attribute.id}\`` : `\`${attribute.id}\`<br/>${flags.join(', ')}`;
        w(`| ${key} | \`${attribute.type}\` | ${requirement} | ${attribute.class} | ${attribute.owner} |`);
      }
      w();
      for (const attribute of group.attributes) {
        w(`- **\`${attribute.id}\`** — ${cell(attribute.brief)}`);
        if (attribute.enum !== undefined) {
          const values = attribute.enum
            .map(member =>
              member.brief === undefined
                ? `\`${member.value}\``
                : `\`${member.value}\` (${cell(member.brief)})`,
            )
            .join(', ');
          w(`  - Values: ${values}`);
        }
        if (attribute.examples !== undefined) {
          w(`  - Examples: ${attribute.examples.map(value => `\`${String(value)}\``).join(', ')}`);
        }
        if (attribute.emitted_on !== undefined) {
          w(`  - Emitted on: ${attribute.emitted_on.map(value => `\`${value}\``).join(', ')}`);
        }
        if (attribute.note !== undefined) w(`  - ${cell(attribute.note)}`);
      }
      w();
    }

    if (group.fields !== undefined) {
      w('| Field | Type | Aliases, in priority order | Normalises |');
      w('|---|---|---|---|');
      for (const field of group.fields) {
        const aliases = field.aliases.map(alias => `\`${alias}\``).join('<br/>');
        const normalize =
          field.normalize === undefined
            ? '—'
            : Object.entries(field.normalize)
                .map(([from, to]) => `\`${from}\` → \`${to}\``)
                .join('<br/>');
        const name = field.class === 'content' ? `\`${field.id}\` **(content)**` : `\`${field.id}\``;
        w(`| ${name} | \`${field.type}\` | ${aliases} | ${normalize} |`);
      }
      w();
      for (const field of group.fields) {
        w(`- **\`${field.id}\`** — ${cell(field.brief)}`);
        if (field.emitted_by !== undefined) {
          const by = Object.entries(field.emitted_by)
            .map(([stack, key]) => `${stack}: \`${key}\``)
            .join(', ');
          w(`  - Observed: ${by}`);
        }
      }
      w();
    }

    if (group.keys !== undefined) {
      for (const key of group.keys) w(`- \`${key}\``);
      w();
    }
  }

  w('## Content classification');
  w();
  w('The keys above marked `content` are the named half. Two more rules apply, so');
  w('a vendor shipping a key we have never seen fails closed rather than open.');
  w();
  w('Patterns:');
  w();
  for (const pattern of contract.content.patterns) w(`- \`/${pattern}/\``);
  w();
  w(
    `Plus: any string longer than ${contract.content.heuristic_min_length} characters, on a span authored by an instrumentation scope we do not control.`,
  );
  w();

  if (contract.open_decisions !== undefined && contract.open_decisions.length > 0) {
    w('## Open decisions');
    w();
    w('Settle these before calling the contract frozen. Each is cheap now and a');
    w('migration afterwards.');
    w();
    for (const decision of contract.open_decisions) {
      w(`### ${decision.id}`);
      w();
      w(`Affects: ${decision.affects.map(value => `\`${value}\``).join(', ')}`);
      w();
      w(oneLine(decision.question));
      w();
    }
  }

  return out.join('\n');
};

// ── drift check against the hand-written SDK lists ──────────────────────────

/**
 * Once the generated file exists, the interesting failure is no longer "the
 * hand-written copy disagrees" — it is "somebody wrote a second copy". A key
 * inlined as a string literal is how the four copies happened in the first
 * place, and how assertions.ts came to check eight content keys while the
 * exporter redacted fifteen.
 *
 * So: no hand-written source may contain a string literal that exactly equals a
 * key the contract owns. Import the constant instead.
 *
 * Comments are stripped first. content.ts annotates its lists per stack, and an
 * apostrophe in one of those comments ("the AI SDK's second vocabulary")
 * otherwise opens a string literal and swallows whatever follows — a check that
 * mis-parses is worse than none, because it reports confidently.
 */
const restatedKeys = (contract: Contract): string[] => {
  const owned = new Set([
    ...attributesOf(contract).map(attribute => attribute.id),
    ...contentKeys(contract),
    ...deniedKeys(contract),
    ...fieldsOf(contract).flatMap(field => field.aliases),
  ]);

  const problems: string[] = [];
  for (const path of LANGUAGES.flatMap(target => target.handWritten).map(file => join(ROOT, file))) {
    let source: string;
    try {
      source = readFileSync(path, 'utf8');
    } catch {
      problems.push(`${relative(ROOT, path)}: listed as hand-written but not readable`);
      continue;
    }
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const found = new Set(
      [...stripped.matchAll(/'([^'\n]*)'/g)]
        .map(match => match[1] as string)
        .filter(literal => owned.has(literal)),
    );
    for (const literal of [...found].sort()) {
      problems.push(`${relative(ROOT, path)}: restates ${quote(literal)} — import it instead`);
    }
  }
  return problems;
};

// ── language targets ────────────────────────────────────────────────────────

/**
 * One entry per SDK. Adding a language is an entry here plus an emitter — not a
 * new code path, and never a hand-translated copy of the constants.
 *
 * `out` is committed to the SDK's own source tree rather than kept beside the
 * YAML, so building any SDK never requires running another language's
 * toolchain. The generated file carries no dependencies for the same reason: a
 * contract file that imported semconv could not be read by be-ingest without
 * dragging the dependency along. Semconv names are verified at generate time
 * instead — a stronger check than importing them, because it compares the value
 * too, not just that the symbol exists.
 *
 * `handWritten` is the drift list: sources that must not restate a literal the
 * contract owns. That is the leak-shaped failure — `content.ts` deciding a key
 * is not content when the contract says it is.
 */
interface LanguageTarget {
  language: string;
  out: string;
  emit: (contract: Contract) => string;
  handWritten: string[];
}

const LANGUAGES: LanguageTarget[] = [
  {
    language: 'node',
    out: 'node/src/attributes.gen.ts',
    emit: contract => emitTypeScript(contract),
    // A file listed here and not readable is an error, not a skip — a drift
    // list that quietly shrinks is the failure it exists to prevent.
    //
    // Every hand-written source that reasons about an attribute key belongs
    // here. The spool pair earns its place for a non-obvious reason: what it
    // writes to disk is the serialized OTLP body, so a key it named itself
    // would leak into a file format an external reader parses against
    // contract/SPOOL.md.
    handWritten: [
      'node/src/index.ts',
      'node/src/attributes.ts',
      'node/src/content.ts',
      'node/src/annotations.ts',
      'node/src/identity.ts',
      'node/src/processor.ts',
      'node/src/redacting-exporter.ts',
      'node/src/redacting-log-processor.ts',
      'node/src/sanitize.ts',
      'node/src/self-metrics.ts',
      'node/src/spool.ts',
      'node/src/spool-exporter.ts',
    ],
  },
  {
    language: 'python',
    out: 'python/src/octic_telemetry/attributes_gen.py',
    emit: contract => emitPython(contract),
    // Empty until the Python SDK has a hand-written source that reasons about a
    // key. The first file added here also needs `restatedKeys` taught about `#`
    // and docstrings — its comment stripper is JavaScript-shaped, and a drift
    // check that mis-parses reports confidently about the wrong thing.
    handWritten: [],
  },
];

// ── external targets ────────────────────────────────────────────────────────

/**
 * A consumer that lives in a DIFFERENT repository. `@octichq/contracts` needs
 * the reader half of this contract — the aliases, the normalisations, the
 * content and deny lists — and hand-copying it there would be the translation
 * rule 2 forbids. So the generator writes it, and the file is committed on the
 * far side like any other generated artifact.
 *
 * Everything about this is best-effort by design. That checkout is not part of
 * this repo, is not present in this repo's CI, and is not present for an
 * outside contributor at all — so an absent target is a SKIP, never a failure.
 * A target that is present but is not the package we expect is the opposite: a
 * hard error, because "not here" and "misconfigured" must not look alike.
 *
 * The generator never creates directories on the far side. A missing parent
 * directory inside a checkout that does exist means the layout moved, and
 * silently minting a tree that nothing reads is worse than stopping.
 */
interface ExternalTarget {
  id: string;
  defaultRoot: string;
  out: string;
  expectPackage: string;
  emit: (contract: Contract) => string;
}

/** The header for the artifact that lands in contracts. */
const contractsTypeScriptHeader = (contract: Contract): string[] => [
  'GENERATED — do not edit.',
  '',
  `Source:     attributes.yaml (schema_version ${contract.schema_version}), octic telemetry repo`,
  'Regenerate: in that repo, run `make contract-generate`',
  '',
  'The reader half of the agent-telemetry attribute contract: canonical fields,',
  'the vendor aliases accepted for each in priority order, the value',
  'normalisations, and the keys that are content or denied outright.',
  '',
  'No imports, deliberately. This package is config-free and near dependency-',
  'free, and a contract file that pulled in semantic-conventions would drag it',
  'into every consumer. The logic over this data is hand-written beside it in',
  'attributes.ts — only the data is generated.',
];

const EXTERNAL: ExternalTarget[] = [
  {
    id: 'contracts',
    defaultRoot: join(ROOT, '..', 'contracts'),
    out: 'src/telemetry/attributes.gen.ts',
    expectPackage: '@octichq/contracts',
    emit: contract =>
      emitTypeScript(contract, { header: contractsTypeScriptHeader, semconvNames: false }),
  },
];

/**
 * Where the sibling checkout is. `--contracts-dir=…` beats
 * `OCTIC_CONTRACTS_DIR` beats the workspace-relative default. Reading env in a
 * private build script is fine; it is the consuming package that must stay
 * config-free.
 */
const externalRoot = (target: ExternalTarget): string => {
  // Relative overrides resolve against the repo root, not the cwd: `npm
  // --prefix contract run` sets the cwd to contract/, so resolving against it
  // would make the same `../x` mean different things through make and through
  // npm. An absolute path passes through either way.
  const prefix = `--${target.id}-dir=`;
  const flag = process.argv.find(argument => argument.startsWith(prefix));
  if (flag !== undefined) return resolve(ROOT, flag.slice(prefix.length));
  const fromEnv = process.env[`OCTIC_${target.id.toUpperCase()}_DIR`];
  return fromEnv !== undefined && fromEnv !== '' ? resolve(ROOT, fromEnv) : target.defaultRoot;
};

/** Contents, or null when the file is absent or unreadable. */
const readIfPresent = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

type Resolution =
  | { status: 'skip'; note: string }
  | { status: 'error'; note: string }
  | { status: 'ready'; path: string; body: string };

const resolveExternal = (target: ExternalTarget, contract: Contract): Resolution => {
  if (process.argv.includes('--no-external')) {
    return { status: 'skip', note: `${target.id}: --no-external` };
  }

  const root = externalRoot(target);
  const manifest = join(root, 'package.json');
  if (!existsSync(manifest)) {
    return { status: 'skip', note: `${target.id}: no checkout at ${root}` };
  }

  // Present but wrong is a configuration mistake, and a configuration mistake
  // that writes a file into an unrelated directory is one nobody notices.
  let name: unknown;
  try {
    name = (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name;
  } catch (error) {
    return { status: 'error', note: `${target.id}: ${manifest} is unreadable — ${String(error)}` };
  }
  if (name !== target.expectPackage) {
    return {
      status: 'error',
      note: `${target.id}: ${root} is ${JSON.stringify(name)}, expected ${target.expectPackage}`,
    };
  }

  const path = join(root, target.out);
  if (!existsSync(dirname(path))) {
    return { status: 'error', note: `${target.id}: ${dirname(path)} does not exist (not creating it)` };
  }

  return { status: 'ready', path, body: target.emit(contract) };
};

// ── entry point ─────────────────────────────────────────────────────────────

const artifacts = (contract: Contract): { path: string; body: string }[] => [
  ...LANGUAGES.map(target => ({
    path: join(ROOT, target.out),
    body: `${target.emit(contract)}`,
  })),
  { path: OUT_MD, body: `${emitMarkdown(contract)}\n` },
];

const main = (): void => {
  const contract = parse(readFileSync(SOURCE, 'utf8')) as Contract;

  const problems = validate(contract);
  if (problems.length > 0) {
    process.stderr.write(`contract/attributes.yaml is invalid:\n`);
    for (const problem of problems) process.stderr.write(`  ${problem}\n`);
    process.exitCode = 1;
    return;
  }

  const generated = artifacts(contract);
  const external = EXTERNAL.map(target => resolveExternal(target, contract));
  // Reported, and acted on, only after every in-repo artifact — a sibling
  // checkout must never be able to stop ATTRIBUTES.md being written.
  const notes = (write: (line: string) => void): boolean => {
    let failed = false;
    for (const resolution of external) {
      if (resolution.status === 'skip') {
        process.stdout.write(`skipped: ${resolution.note}\n`);
      } else if (resolution.status === 'error') {
        write(`error: ${resolution.note}\n`);
        failed = true;
      }
    }
    return failed;
  };

  if (!process.argv.includes('--check')) {
    for (const { path, body } of generated) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
      process.stdout.write(`wrote ${relative(ROOT, path)}\n`);
    }

    let failed = notes(line => process.stderr.write(line));
    for (const resolution of external) {
      if (resolution.status !== 'ready') continue;
      // Skip-if-unchanged: regenerating must not dirty a working tree in a repo
      // the committer was not working in.
      if (readIfPresent(resolution.path) === resolution.body) {
        process.stdout.write(`unchanged ${resolution.path}\n`);
        continue;
      }
      try {
        writeFileSync(resolution.path, resolution.body);
        process.stdout.write(`wrote ${resolution.path}\n`);
      } catch (error) {
        process.stderr.write(`error: ${resolution.path} — ${String(error)}\n`);
        failed = true;
      }
    }
    if (failed) process.exitCode = 1;

    const drift = restatedKeys(contract);
    for (const line of drift) process.stdout.write(`drift: ${line}\n`);
    return;
  }

  const stale = generated.filter(({ path, body }) => {
    try {
      return readFileSync(path, 'utf8') !== body;
    } catch {
      return true;
    }
  });
  // An absent external target is not stale — it is absent, which is this repo's
  // normal state in its own CI.
  const externalStale = external.filter(
    (resolution): resolution is Extract<Resolution, { status: 'ready' }> =>
      resolution.status === 'ready' && readIfPresent(resolution.path) !== resolution.body,
  );
  const drift = restatedKeys(contract);
  const failed = notes(line => process.stderr.write(line));

  for (const { path } of stale) {
    process.stderr.write(`stale: ${relative(ROOT, path)} — run: node contract/generate.ts\n`);
  }
  for (const { path } of externalStale) {
    process.stderr.write(`stale: ${path} — run: make contract-generate\n`);
  }
  for (const line of drift) process.stderr.write(`drift: ${line}\n`);

  if (stale.length > 0 || externalStale.length > 0 || drift.length > 0 || failed) {
    process.exitCode = 1;
  } else process.stdout.write('contract is current\n');
};

main();
