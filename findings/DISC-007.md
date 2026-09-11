# DISC-007: the Web UI's API client calls fourteen operations neither the contract nor the engine has

- **Filed as**: [spdrman/backupd#211](https://github.com/spdrman/backupd/issues/211)
- **Pinned by**: `suites/equivalence/specs/contract-gaps.spec.ts`
- **Build**: originally observed on `backupd` at
  `137f64699203a5ec6d2a6e399a654b99814a5a74`
- **Kind**: divergence between two of the product's own artefacts, found by
  running them against each other for the first time.
- **Status**: **mostly resolved upstream.** Of the pairs enumerated under
  "Observed" below, all but three were closed by
  [#214](https://github.com/spdrman/backupd/pull/214) (`aba87b7`),
  which this repository observed when the pin moved from `612b48c` to
  `6a93b96`. The three that remain are a different shape from the rest.
  See "What has since changed" below.

## Contract

`api/v1/openapi.json` is authoritative (issue #166, PR #194). It declares
19 paths. `apps/common/webhost/router.go` registers exactly those
operations and nothing else.

## Observed

`ui/shared/src/api/client.ts` requests fourteen `(method, path)` pairs that
are in neither. Against a live engine, authenticated, on `main`:

```
GET /api/v1/version    -> 404   (the contract has /system/version)      still absent
GET /api/v1/health     -> 404   (health lives outside /api/v1)          still absent
GET /api/v1/backups    -> 404                                           closed by #214
GET /api/v1/activity   -> 404                                           closed by #214
GET /api/v1/quarantine -> 404                                           closed by #214
GET /api/v1/operations -> 405   (POST /operations exists; GET does not) closed by #214
POST /api/v1/catalog/scan, /catalog/rebuild -> 404                      closed by #214
POST /api/v1/backup-sets/{id}/run -> 404                                still absent
POST /api/v1/backup-sets/{id}/enabled, /test-connection -> 404          closed by #214
```

The right-hand column is the re-derivation at `6a93b96`, read from
`apps/common/webhost/router.go` and `api/v1/openapi.json` rather than
from the failure message.

The consequence is not subtle. On a real backend the Dashboard, Backups,
Activity and Quarantine pages all render "The backup service returned an
unexpected response.", Backup sets renders with a degraded banner, and
Settings is the one page that works end to end.

## Why nothing caught it

Three suites could have, and each is blind to it for a different reason:

- the browser suite (Suite B here) runs against `createMockApi` under the
  dev server, and the mock implements whatever the client asks for, so it
  is green by construction;
- `apps/common/webhost`'s Go tests exercise the routes that exist, never
  the ones the client calls;
- `scripts/api/check-contract-drift.sh` compares the GENERATED bindings to
  the contract byte for byte, and `client.ts` is hand-written on top of
  them, importing only `API_ERROR_CODES`. Its paths are string literals
  nothing checks.

That third one is the interesting failure. #166's framing was "the
TypeScript client generated from it or mechanically validated against it",
and this is what it looks like when only half of that landed.

## What the suite does about it

`suites/equivalence/specs/contract-gaps.spec.ts` carries the table above as
data and asserts it against a live engine, in both directions: a path
recorded as absent that starts answering fails the case, exactly the way
Suite A's `known_discrepancy` marker fails when a discrepancy is fixed. So
`suites/equivalence/MATRIX.md` cannot quietly rot into a list of gaps that
were closed years ago.

It also separates this from the other reason a UI action cannot reach the
backend, which is easy to confuse with it when you are reading a 403 next
to a 404: `POST /operations` and the retention apply route exist and are
declared, and they refuse because `serve.NewEngine` never sets a
destructive gate. That one is deliberate and tracked at #92.

## What has since changed

[#214](https://github.com/spdrman/backupd/pull/214) (`aba87b7`,
"Make every /api/v1 path the Web UI calls a real operation") closed all
but three of the pairs above, registering them in
`apps/common/webhost/router.go` and declaring them in
`api/v1/openapi.json`. This repository saw it when
`build-under-test.json` moved from `612b48c` to `6a93b96`: that range
contains `aba87b7`, `contract-gaps.spec.ts` went red on six pairs it
recorded as absent, and the marker did what it was written to do, which
is refuse to let a closed gap sit here looking open.

`suites/equivalence/MATRIX.md` was re-derived over the same move. Four
rows went from **blocked** to **unproved**: the route is there, nothing
proves the equivalence yet, and each row names the spec that would.

### The three that remain, and why they are not the same finding

`GET /version` and `GET /health` are the client calling the wrong path,
not the engine missing a feature. The contract spells the first
`/system/version`, which the client also calls and which works; health
is served outside `/api/v1` entirely. Closing these is a change to
`client.ts`, not to the router or the contract, which makes them the one
part of this finding that never belonged in the same sentence as the
rest.

`POST /backup-sets/{id}/run` is absent from both the router and the
contract at this pin. The per-set manual run reaches the backend through
`POST /operations` instead, and that route exists, is declared, and is
refused by `requireDestructiveGate` while `serve` sets no gate and
`NewRouter` defaults to `NotYetImplementedGate`. So the manual-run row in
the matrix stays blocked, but on [#92](https://github.com/spdrman/backupd/issues/92)
rather than on this finding.

### One distinction worth keeping

`POST /catalog/scan` and `/catalog/rebuild` answer 403 to
`contract-gaps.spec.ts`, and that is not the destructive gate. Both carry
`requireCSRF` and, unlike `POST /operations`, not
`requireDestructiveGate`; the probe uses `page.request.post` and sends no
CSRF token, so it gets `CSRF_TOKEN_MISSING`. The route is served. A
browser driving the real page carries the token.

That is why the spec now pins the exact status per pair rather than a
served-or-absent boolean: 403-because-CSRF, 403-because-gated and 404 are
three different claims, and the first version of this table could only
express the third.
