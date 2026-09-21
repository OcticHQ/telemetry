# 003 — The Python SDK

Status: accepted

The second SDK in this repository: `octic-telemetry` on PyPI, module
`octic_telemetry`, living at `python/` beside `node/` exactly as
[ADR 0001](../adr/0001-one-repo-many-language-sdks.md) says a language should.

Three pull requests. The first release is **spool-only** — it stamps the
attribute contract onto spans a Python application produces and writes export
batches to a [`SPOOL.md`](../../contract/SPOOL.md)-conformant directory, with no
HTTP, no credential and no be-ingest dependency in it at all.

## Why this is smaller than porting the Node SDK

Three facts, each of which deletes a chunk of `node/` rather than translating it.

**The first consumer never talks to be-ingest.** It reads the spool and nothing
else. So `auth.ts`, `token-manager.ts` and `auth-retrying-exporter.ts` — the
whole of Node's token-refresh work, its largest single body — have no Python
counterpart here, and the OTLP/HTTP exporter goes with them. What the consumer
needs instead is the spool, which moves from "the expensive optional half" to the
point of the package.

**A proof of concept already wrote the risky third.** A lending-agent service
carries a 384-line `telemetry.py` derived from this SDK, with 768 lines of tests
against it, running in a real deployment. It proves the architecture in Python:
`SpanProcessor.on_start` stamps a context-scoped value onto every span the
provider creates, including spans from code that has never heard of us. That is
the mechanism the entire package is built out of, demonstrated in production
shape. It shares this repository's generated `attributes_gen.py`, so the
generated-contract path is proven end to end as well.

**Python's threading model deletes most of the spool's complexity.**
`node/src/spool.ts` is 685 lines and a large fraction of that weight is the event
loop: no synchronous I/O on the hot path, async `mkdir`/`open`/`rename`, guards
against unhandled rejections. Python's `BatchSpanProcessor` exports on its own
worker thread, so blocking `os.write` and `os.replace` are simply correct there.
The rule that replaces all of it: **mandate `BatchSpanProcessor` and refuse
`SimpleSpanProcessor`**, because Simple exports on the thread that ended the span
— a customer's request thread — which is where a blocking disk write turns into
their latency.

## Decisions taken here, so nobody reopens them mid-PR

1. **Package `octic-telemetry`, module `octic_telemetry`, PyPI.** Python floor
   3.10. `py.typed` ships.
2. **The wire is OTLP/JSON and we own the encoder.** Upstream's
   `opentelemetry-exporter-otlp-proto-http` hard-codes `application/x-protobuf`
   and there is no JSON HTTP exporter in Python. This is not a preference: the
   spool segment *is* the OTLP/JSON body by `SPOOL.md` v1
   (`contentType: "application/json"`, `{"resourceSpans":[…]}`), so protobuf
   would require a `spoolFormatVersion: 2`.
3. **Runtime dependencies: `opentelemetry-api` and `opentelemetry-sdk`, and
   nothing else.** `urllib.request` from the standard library if and when HTTP
   lands, for the reason Node chose `node:http` over undici — a pooled keep-alive
   connection is a live handle in a package that promises to hold none.
4. **Release-please component `python`, tag `python/vX.Y.Z`,
   `release-type: "python"`.** Versions independent of `node` and `contract`, per
   [ADR 0002](../adr/0002-per-sdk-versioning.md). No root package manager is
   added; `make python-*` targets and `.github/workflows/_python.yml` mirror the
   Node ones, per [ADR 0005](../adr/0005-no-root-package-manager.md).
5. **The first release is spool-only.** HTTP export, enrollment tokens and
   refresh arrive when a Python consumer needs be-ingest, and the spooling
   exporter is shaped as a plain `SpanExporter` so an auth-retrying HTTP exporter
   can be inserted in front of it without touching the spool.
6. **The instrumentation scope name is `octic-python`,** the SDK's own member of
   the contract's closed `octic.sdk.name` enum — the same value the resource
   carries, so a span's scope and its resource cannot disagree about who wrote
   it. The foreign-span test compares against the whole enum, never against one
   literal. This mirrors `node/src/version.ts` and is not a per-SDK choice to
   make again.

## What the PoC does that the SDK must not copy

Each of these is right for an application and wrong for a library. They are
listed because they will be read as prior art and copied otherwise.

- **`atexit.register(...)` for shutdown.** The SDK holds no lifecycle — see
  `node/src/batching.ts` for the argument. Also pass `shutdown_on_exit=False` to
  `TracerProvider`, because Python's SDK registers its own `atexit` hook by
  default and that default is the same bug.
- **A bare `ContextVar` for the run id.** An application can do this. An SDK must
  put the value on the OTel Context, or it will not ride `context.attach` across
  a host SDK's boundary and the scopes will not compose.
- **Stripping internal keys inside the encoder.** That belongs in a redacting
  exporter, so that the spool sits *inside* redaction and never writes raw
  prompts to a customer's disk under `capture: "none"`.
- **`content.capture` hardcoded to `"none"`.** The SDK default is `"full"`,
  opt-out, and the manifest records which level wrote the directory.
- **Dropping on export failure with no retry and no spool.** Correct for a
  lending decision; it is the exact failure this package exists to remove.
- **A tracer name shared with the Node SDK.** The PoC hardcodes
  `"octic-telemetry"` to group both languages' spans together. Decision 6 above
  replaced that: the scopes are per-SDK and the set is what gets compared.

## PR A — the SDK core (`feat(python):`)

Package skeleton, the contract wiring, every context scope, the annotations, the
content policy, redaction, and the encoder. No I/O of any kind except what a test
harness supplies.

`pyproject.toml`, `py.typed`, a `python/README.md` stub, ruff + mypy + pytest
configuration. Then:

- **`attributes.py`** — the SDK's view of the generated contract, mirroring
  `node/src/attributes.ts`: an `ATTR` namespace object over the generated
  constants plus the named constants re-exported. The reader-side tables
  (`CONTENT_KEYS`, `CONTENT_PATTERNS`, `RESOURCE_DENY`, `FIELDS`,
  `EMITTED_ATTRIBUTES`, `INTERNAL_ATTRIBUTES`) stay internal; a consumer writing
  telemetry needs the keys, a consumer reading it needs the tables, and those are
  two different dependencies. Nothing here restates a key the contract owns.
- **`version.py`** — `SDK_NAME` from the contract enum, and `SDK_VERSION` as a
  literal carrying the `x-release-please-version` marker, the same mechanism as
  `node/src/version.ts`. Not `importlib.metadata.version()`, which raises when
  the package is on `sys.path` without being installed — which is how the test
  suite and every editable checkout runs it.
- **`context_scope.py`** — the one pattern, on the OTel Context rather than a
  bare `ContextVar`. Both a `@contextmanager` and an `async with` form; the
  naming is decided once here rather than ten times downstream.
- **`identity.py`, `agent.py`, `prompt.py`, `run.py`** — the four non-span
  scopes. Identity merges, agent and prompt replace. Customer attributes go under
  `octic.custom.`, never bare `octic.`, for the structural reason in AGENTS.md
  rule 7.
- **`processor.py`** — `OcticSpanProcessor`, the generalisation of the PoC's
  one-scope processor to four scopes plus the content policy, and
  provenance-on-spans for the external-provider case.
- **`sanitize.py`** — drop what Python's attribute validation would drop anyway,
  but count it and name the key under the debug flag. Re-derive the rules from
  `opentelemetry.attributes`; do not transliterate Node's `isAttributeValue`
  list.
- **`annotations.py`** — `with_workflow`, `with_tool`, `with_retrieval`. Each is
  one object usable as a `with`, an `async with`, or a decorator over a sync or
  async function; the `with` forms set the output explicitly on the handle, the
  decorator forms take it from the return value. `input` stays an explicit
  parameter for the reason `node/src/annotations.ts` gives — a wrapper that
  serializes the callable's own arguments records nothing for a zero-arg closure.
  `record_exception=False` throughout, which the PoC established: upstream's
  default writes `exception.message` and `exception.stacktrace` into a span
  event, which is content arriving without anyone deciding to send it.
- **`content.py`** — the three capture levels, default `full`.
- **`redacting_exporter.py`** — the content policy applied at export, covering
  span attributes, event attributes and `status.message`, with the foreign-span
  test as set membership over the contract's `octic.sdk.name` values.
- **`otlp_json.py`** — the encoder. Lift the PoC's `AnyValue` mapping (`bool`
  before `int`, int64 as a string), its span-kind table mapped by name rather
  than by arithmetic on the enum, and its lowercase-hex ids, then **close the
  gaps**: the PoC deliberately omits span events, links, `status.message`,
  `droppedAttributesCount`, `flags`, `traceState`, scope attributes and
  `schemaUrl`, and assumes one resource and one scope per batch. A service that
  owns all its own spans can afford that; an SDK cannot, because a segment is
  POSTed verbatim by the reader and whatever the encoder loses is lost for good —
  including from instrumentation we did not write. Events are gated by the
  content policy rather than omitted.
- **The drift list.** `contract/generate.ts` carries `handWritten: []` for Python
  with a comment that the first file added there also requires teaching
  `restatedKeys` about `#` comments and docstrings, because its comment stripper
  is JavaScript-shaped and a drift check that mis-parses reports confidently
  about the wrong thing. The first such file lands in this PR, so the teaching
  lands here too rather than in PR C — otherwise the check is dark across exactly
  the two PRs most likely to restate a key. It touches `contract/`, so it is kept
  to its own commit.

Tests: the PoC's telemetry and span suites port nearly directly and are the
starting corpus, alongside the matching files in `node/test/`.

## PR B — the spool and `init()` (`feat(python):`)

- **`spool.py`** — a writer conformant to [`contract/SPOOL.md`](../../contract/SPOOL.md)
  v1, and conformance to that document is the acceptance criterion, not
  similarity to `spool.ts`:
  - manifest created with `O_EXCL`, an existing one left alone, id hashed over
    every field but `createdAt`, **never a credential**;
  - segments named `traces-<epochMs>-<seq>-<writer>-<id>.otlp.json`, `<writer>`
    an opaque per-instance id and never a pid;
  - write to `.tmp`, fsync, `os.replace` — a file a reader can see is a file that
    is complete;
  - `0700` directory, `0600` files, and a directory we refuse to use unless we
    own it and nobody else can write to it;
  - bounds of 64 MiB, 10,000 segments and 72 hours, with `evict-oldest` or
    `drop-new`;
  - an unwritable directory warns once, self-disables, retries the directory a
    minute later, never throws, and never holds batches in memory.

  `sdkName` is part of the manifest id's hash input, so a Python writer and a
  Node writer never share a manifest even in a shared directory. The hash
  algorithm therefore does not need to match Node's byte for byte — only to be
  stable within Python.
- **`spool_exporter.py`** — with no HTTP there is no "try to send, fall back"
  branch and no spoolable-status check. The spool is the exporter. Keep the
  `SpanExporter` shape anyway, so the HTTP half can be inserted in front later.
- **`init.py`** — `init()` and `init_with_external_provider()`. The resource
  carries service name and version, `octic.schema.version`, `octic.sdk.name` and
  `octic.sdk.version` read from `version.py` rather than hardcoded — Node shipped
  `0.0.0` on the wire for exactly that mistake. Setup runs at most once per
  process, `init()` never raises, three outcomes: normal, degraded, failed. No
  `atexit`, `shutdown_on_exit=False`, and `SimpleSpanProcessor` refused.
- **`safe_processor.py` / `safe_exporter.py`** — an SDK callback must not take
  out the call the customer was actually making. Python's `SpanExporter.export()`
  is synchronous, so Node's "the result callback fires exactly once" problem does
  not exist; "must not raise and must not block" does.
- **`counters.py`** — what was dropped, failed or swallowed, counted and not
  exposed, readable through `OCTIC_TELEMETRY_DEBUG=1`. Thread-safe, which Node
  got for free from the single loop.
- **A silence warning, reframed.** Node warns when spans are produced and none
  arrives, but with a spool nothing arriving over the network is the designed
  steady state. The Python signal is spans produced and no segment written.

## PR C — packaging, release and docs (`chore(python):` / `docs:`)

- Register `python` in `release-please-config.json` and
  `.release-please-manifest.json`; add `.github/workflows/_python.yml` and a
  publish workflow using a PyPI trusted publisher (OIDC, no long-lived token).
- `make python-install python-lint python-typecheck python-test python-build`,
  wired into `make check`. Add the Python sources to `pre-commit`.
- `python/README.md` finished — it is the registry page, so absolute links and no
  `../docs/` — `docs/` updated where it says "the Node SDK", and an ADR recording
  the decisions above.
- `python/examples/` after the first publish, as Node's examples do.

## Order and what blocks what

`A → B → C`. A and B are one dependency chain with no useful way to overlap them;
C can be started against a half-finished B.

PR A branches from the Node public-surface work rather than from `main`, because
it needs the `octic.sdk.name` enum members that landed there. Rebase onto `main`
once that merges.

## The gate for the first release

1. The package builds, type-checks and installs from a wheel.
2. SDK failures cannot escape into the host, and customer failures are not
   swallowed.
3. Every attribute the SDK stamps comes from the generated contract, and the
   drift check covers the hand-written sources.
4. A spool directory written by this SDK satisfies `SPOOL.md` v1 — verified
   against the document, and against a Node-written directory for shape.
5. No content leaves the process at `capture: "none"`, including span events.

## The reader

`SPOOL.md` describes a separate reader process that delivers the segments. It
exists and is owned outside this repository; its absence from this tree is by
design. Write the spool against `SPOOL.md` v1 and treat
[its rules for the reader](../../contract/SPOOL.md) as the other side of a
settled contract.

## Deliberately out of scope

HTTP export, enrollment tokens and refresh; the logs signal — the spool format
already names `logs` segments, so the seam stays; instrumentation of any kind,
per AGENTS.md rule 8; a `diagnose()` API; Go.

## Amendments

### A1 — what PR A settled that the plan left open (after PR A landed)

**The annotation surface is one object with four call forms.** Each of
`with_workflow`, `with_tool` and `with_retrieval` returns something usable as
`with`, as `async with`, and as a decorator over a sync or an async function.
The block forms set the output explicitly on the handle they yield, because a
block has no return value to read; the decorator forms take it from what the
function returned. The plan said "sync and async" without saying which shape,
and a callback-taking port of the Node signature reads as an un-Pythonic closure
at every call site.

Attributes are built when the annotation is *entered*, not when it is
constructed. A decorator is constructed at import time, and serializing its
input then would record content under whatever capture level happened to be in
force before the application configured one.

**`counters.py` moved from PR B to PR A.** `sanitize.py` counts what it drops,
so the counter had to exist alongside it. Only the three counters PR A can move
are defined; the rest arrive with the pipeline that produces them.

**Context scopes are `ContextScope` plus `ScopeBinding`.** A scope is the typed
value and its mapping to attributes; binding one returns a fresh object that
implements both context-manager protocols. The token stack lives on the binding,
which is what makes nesting a scope inside itself safe.

### A2 — what PR B settled (after PR B landed)

**The run scope stays block-only.** There is no set-and-continue `bind_run`,
here or in Node: an attach with no matching detach leaks the run id onto
whatever runs next on that thread or asyncio task. The run id comes from the
application — `with_run(id)`, or `with_workflow(run_id=...)` — and a framework
that splits the work across before and after hooks calls the binding's
`__enter__` and `__exit__` from them. Carrying a run id across a process
boundary is a separate feature (baggage) and not part of this plan.

**The module is `pipeline.py`, not `init.py`.** The package exports a function
called `init`, and a submodule of the same name is shadowed by it — `import
octic_telemetry.init` then resolves to the function.

**External mode hands over a processor, not only an exporter.**
`init_with_external_provider()` returns `export_processor`, a guarded
`BatchSpanProcessor` over the exporter chain, beside `span_processor` and the
bare `span_exporter`. That is how "batch, never simple" survives a host SDK that
arranges its own processors: the thing we recommend handing over is already
batched.

**`init()` checks for an existing global provider first.** Python ignores a
second `set_tracer_provider` with one log line, so `init()` in a process where
another SDK got there first would otherwise build a pipeline nothing reaches and
report success. It warns, points at `init_with_external_provider()`, and ends
`degraded`.

**The spool holds nothing in memory.** Writes are synchronous on the batch
worker, so there is no pending queue and no drain at exit; what a process loses
without `shutdown()` is the batch processor's queue. The spool re-mints its
writer id in a forked child (`os.register_at_fork`), which Node never needed.

**The silence warning is keyed to segments** and armed only once `init()` has
run, so a process that imports the package and never configures it is not
warned about spans it never asked to send.
