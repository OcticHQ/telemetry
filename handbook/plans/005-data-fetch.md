# 005 — `fetchData` and `fetch_data`: the SDK side of a data-fetch run

Status: accepted

Airlock's plan 046 adds a third run mode, `data_fetch`. In that mode the agent
opens its sealed parameters, hands the FIU's credentials to the gate, and reads
back the data the orchestrator fetched. Its D10 is what changes here. The
decision and its reasoning live in Airlock, not in this repository:

- Plan: `handbook/plans/046-data-fetch-runs.md` (D3, D4, D10)
- Decision: `handbook/adr/0021-data-fetch-runs.md`
- Both are on Airlock's branch `docs/047-data-fetch-runs`, not merged yet.

`contract/` does not change. `receipts.yaml` is the agent receipt vocabulary,
and a data-fetch run has no agent chain.

## The gate, as built on that branch

The socket is `$AIRLOCK_GATE_SOCKET`. The mode is `$AIRLOCK_RUN_MODE=data_fetch`.

`POST /v0/fetch` is registered only in a data-fetch run. It takes at most
64 KiB of JSON, parsed strictly: every field present, no unknown ones, no
duplicates, no trailing document.

```json
{"schema":"airlock.fetch.request.v1",
 "credentials":{"schema":"airlock.rebit.credentials.v1","entity_id":"…","secret":"…","signing_key":"<PEM>","signing_kid":"…"},
 "consent_id":"…",
 "fi_data_range":{"from":"<RFC3339>","to":"<RFC3339>"}}
```

`credentials` is the object the agent finds inside its sealed parameters, passed
through unchanged. The request blocks until the AA exchange ends, bounded by the
orchestrator's `-rebit-fetch-timeout`, 5 minutes by default.

| Status | Body |
|---|---|
| 200 | `{"names":[…]}`: the vault entries now readable, `sealed` excluded |
| 400, 413 | `malformed` |
| 409 | `already_fetched`, for any second request |
| 422 | the exchange's refusal token, or `fetch_failed` |
| 500 | `fetch failed`, an internal error |
| 404, 405 | not a data-fetch run, or an orchestrator older than 046 |

A refusal body is Go's `http.Error`: the text plus a newline.

## What changes

1. **The gate calls get their own file.** `node/src/gate.ts` and
   `python/src/octichq_airlock_sdk/gate.py`. The receipts files keep the
   spool writer. The public exports keep their names. The sealed-input tests
   move to `node/test/gate.test.ts` and `python/tests/test_gate.py`.
2. **The sealed input serves both modes.** It returns the parameters when
   `AIRLOCK_RUN_MODE` is `data_blind` or `data_fetch`.
3. **The fetch method**, exported beside the sealed input.

   ```ts
   fetchData({ credentials, consentId, fiDataRange: { from, to } }): Promise<FetchResult>
   type FetchResult =
     | { ok: true; entries: Map<string, Uint8Array> }
     | { ok: false; reason: string };
   ```

   ```python
   fetch_data(*, credentials, consent_id, fi_data_range) -> FetchResult
   # frozen dataclass: ok: bool, entries: dict[str, bytes] (empty when refused),
   # reason: str | None (None when ok)
   ```

   It sends `POST /v0/fetch` and then one `GET /v0/data/{name}`, with the name
   URL-encoded, for each name the answer lists. It never throws or raises. The
   result is the report, so it writes no warnings.

   The POST waits 330 seconds, which is the 5-minute fetch timeout plus
   margin. Each GET waits 30 seconds, as the sealed input does.

   **Reasons.** A gate refusal (400, 409, 413, 422) passes the trimmed body
   through if it is a token (`[a-z0-9_]{1,64}`). Anything else from the
   gate becomes `gate_error`. The SDK's own reasons:

   | Reason | When |
   |---|---|
   | `not_data_fetch` | `AIRLOCK_RUN_MODE` is not `data_fetch`. The socket is not touched |
   | `no_gate` | `AIRLOCK_GATE_SOCKET` is unset or empty |
   | `malformed` | the request cannot be serialized as JSON |
   | `unsupported` | 404 or 405 on `/v0/fetch` |
   | `gate_unreachable` | the POST fails to connect, errors, or times out |
   | `gate_error` | 500, any other status, or a refusal body that is not a token |
   | `read_failed` | the 200 body is not `{"names":[string…]}`, or a GET fails |

   **The credentials.** The SDK keeps no reference to them after the request
   body is written. It zeroes the body buffer once the request is sent. No
   warning, error or reason ever includes them.
4. **No new dependency.** The code uses Node's `node:http` and Python's
   `http.client`.
5. **READMEs.** Each one describes `fetchData` / `fetch_data` and says
   `recordReceipt` / `record_receipt` are for data-blind runs. Each README
   is its registry page, so it stands alone.

## Order

Each step is one commit, kept inside one component, so `node` and `python`
release separately.

1. `docs`: this plan.
2. `feat(node)`: the gate file, both modes for the sealed input, `fetchData`,
   tests and README.
3. `feat(python)`: the same for `fetch_data`.
4. The Release PRs, one at a time. Nobody edits a version by hand.
