# The Octic agent receipt vocabulary

**Vocabulary version 1** · `airlock.agent-receipts.v1`

<!-- GENERATED from contract/receipts.yaml by contract/generate.ts. Do not edit. -->

What an agent may report about its own run, through `record_receipt` /
`recordReceipt`. A receipt is a type and a set of attributes; both are
checked against this vocabulary and anything else is refused. No value is
free text: each is checked against one of the shapes below.

A receipt file is at most 4096 bytes, and a run holds at most
256 receipts. The file format is in [SPOOL.md](SPOOL.md).

## Types

| Type | Required | Optional |
|---|---|---|
| `consent.fetched` | `airlock.destination` (host), `airlock.duration.ms` (count) | — |
| `consent.verified` | `airlock.consent.purpose` (purpose) | `airlock.consent.fi_types` (fi_types) |
| `consent.refused` | `airlock.refusal.reason` (token) | — |
| `fi.authenticated` | `airlock.destination` (host), `airlock.duration.ms` (count) | — |
| `fi.requested` | `airlock.destination` (host) | `airlock.duration.ms` (count) |
| `fi.received` | `airlock.destination` (host), `airlock.bytes` (count), `airlock.ciphertext.digest` (digest), `airlock.duration.ms` (count) | `airlock.poll.attempts` (count) |
| `fi.refused` | `airlock.destination` (host), `airlock.refusal.reason` (token) | — |
| `input.read` | `airlock.bytes` (count) | — |
| `output.released` | `airlock.bytes` (count), `airlock.ciphertext.digest` (digest) | `airlock.destination` (org), `airlock.key.id` (kid) |
| `output.returned` | `airlock.bytes` (count), `airlock.ciphertext.digest` (digest) | — |
| `output.refused` | `airlock.refusal.reason` (token) | — |

## Shapes

Each pattern must match the whole value.

| Shape | Meaning | Pattern |
|---|---|---|
| `host` | A lowercase DNS hostname of two or more labels. No port, scheme, wildcard, trailing dot or IP literal. | `^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$` |
| `count` | A decimal integer from 0 to 9007199254740991 (2^53 - 1), with no leading zero. | `^(?:0\|[1-9][0-9]{0,14}\|[1-8][0-9]{15}\|900[0-6][0-9]{12}\|90070[0-9]{11}\|90071[0-8][0-9]{10}\|900719[0-8][0-9]{9}\|9007199[01][0-9]{8}\|90071992[0-4][0-9]{7}\|900719925[0-3][0-9]{6}\|9007199254[0-6][0-9]{5}\|90071992547[0-3][0-9]{4}\|9007199254740[0-8][0-9]{2}\|90071992547409[0-8][0-9]\|900719925474099[01])$` |
| `digest` | A SHA-256 digest, lowercase hex, prefixed sha256. | `^sha256:[0-9a-f]{64}$` |
| `token` | A short lowercase code, such as a refusal reason. | `^[a-z][a-z0-9_]{0,63}$` |
| `purpose` | A three-digit consent purpose code. | `^[0-9]{3}$` |
| `fi_types` | A comma-separated list of one to sixteen financial information types. | `^[A-Z_]{1,32}(,[A-Z_]{1,32}){0,15}$` |
| `org` | An Airlock org slug. | `^[a-z](?:-?[a-z0-9])+$` |
| `kid` | A key id, as Airlock's signed key list names one. | `^key_[A-Za-z0-9_-]{43}$` |
