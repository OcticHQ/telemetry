# 006 — `attestKey` and `attest_key`, and a sealed input that waits

Status: accepted

Airlock's plan 047 has a data-blind or data-fetch agent make its own X25519
key pair, K_a, at start. The agent attests the public half through the gate,
and the FIU seals the run's parameters to that key. The sealed input therefore
arrives after the workload starts. This plan covers the SDK side, D9. The
decision and its reasoning live in Airlock:

- Spec: `handbook/plans/047-agent-generated-keys.md`, D9
- Brief: `handbook/plans/047-agent-generated-keys-tasks.md`, the "Handoff"
  section ("What the gate answers" and "`telemetry`")
- Both are on Airlock's branch `feat/047-agent-generated-keys`, OcticHQ/airlock
  PR #66, not merged yet.

This builds on [005](005-data-fetch.md) and is stacked on its branch. `contract/`
does not change.

## The gate, as built on that branch

`POST /v0/attest` is registered only when `AIRLOCK_RUN_MODE` is `data_blind` or
`data_fetch`. Its body is at most 4 KiB of JSON, exactly:

```json
{"schema":"airlock.agent-key.request.v1","key":{"kty":"OKP","crv":"X25519","x":"<unpadded base64url of the 32-byte public key>"}}
```

The quote and the api's listing of the key both happen before the gate answers.

| Status | Body |
|---|---|
| 200 | `{"key_id":"key_…","bundle":{…},"attestation":{"mode":"confidential_vm"\|"dev","token":"…"}}`. The api has listed the key |
| 400 | `malformed`. This does not use up the run's attestation |
| 409 | `already_attested`. Another key is on this run, so stop |
| 422 | `attest_failed`. The quote or the listing failed, and the run is halting |
| 404, 405 | not a sealed run, or an orchestrator older than 047 |

`GET /v0/data/sealed` answers 404 until the FIU's parameters arrive, then 200.
`POST /v0/fetch` gains 409 `not_ready` before the parameters arrive. 005 already
passes that token through.

## What changes

1. **`attestKey` / `attest_key`**, in `gate.ts` and `gate.py`, exported beside
   the fetch method.

   ```ts
   attestKey(publicKey: Uint8Array): Promise<AttestResult>
   type AttestResult =
     | { ok: true; keyId: string; bundle: Record<string, unknown>; attestation: { mode: string; token: string } }
     | { ok: false; reason: string };
   ```

   ```python
   attest_key(public_key: bytes) -> AttestResult
   # frozen dataclass: ok, key_id: str | None, bundle: dict[str, Any] (empty when
   # refused), attestation: dict[str, str] (empty when refused), reason: str | None
   ```

   It never throws or raises, and writes no warnings. It waits 60 seconds
   without hearing from the gate, on its own connection. Reasons:

   | Reason | When |
   |---|---|
   | `not_sealed_run` | the mode is neither `data_blind` nor `data_fetch`. The socket is not touched |
   | `no_gate` | `AIRLOCK_GATE_SOCKET` is unset or empty |
   | `malformed` | the key is not 32 bytes (not touched). Also the gate's own token |
   | `gate_unreachable` | the POST fails to connect, errors, or times out |
   | the gate's token | 400, 409, 413, 422, through 005's refusal-body rule |
   | `unsupported` | 404 or 405 |
   | `gate_error` | any other status, or a refusal body that is not a token |
   | `read_failed` | the 200 body is not UTF-8 JSON of the shape above: `key_id` a string, `bundle` an object, `attestation.mode` and `.token` strings |

   The SDK neither makes nor holds the private key. It sends only the public
   half, and no HPKE or X25519 dependency is added.
2. **The sealed input waits.** In `data_blind` or `data_fetch`, it polls
   `GET /v0/data/sealed` every 2 seconds until it gets a 200, with no limit of
   its own. The orchestrator's deadline stops the workload. Every answer that
   is not a 200 is retried: a 404 silently, as the normal answer while
   waiting, and anything else (another status, a connect error, a 30-second
   idle timeout) with a warning once per distinct problem. It still returns
   `null` / `None` straight away outside those modes, or with no
   `AIRLOCK_GATE_SOCKET`. The return type is unchanged. The interval has a
   test seam, so tests do not sleep for 2 seconds.
3. **READMEs.** They give the order: make the key, `attestKey`, then
   `sealedInput` (which now waits), then open the envelope with the HPKE info
   `airlock.agent-params.v1|<AIRLOCK_RUN_ID>|<AIRLOCK_MANIFEST_DIGEST>`. A
   refused attestation should end the run with its reason.
4. **Tests**, in `node/test/gate.test.ts` and `python/tests/test_gate.py`:
   - the exact request body;
   - the 200 parsed, and each malformed 200 rejected;
   - each refusal token passed through;
   - both pre-socket refusals, with no connection made;
   - `gate_unreachable`;
   - the sealed input returning after two 404s, and after the socket appears late.

## Order

1. `docs`: this plan.
2. `feat(node)`.
3. `feat(python)`.
4. A PR stacked on 005's #69. Nothing merges or releases without the user's
   go-ahead.
