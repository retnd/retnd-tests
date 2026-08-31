# DISC-007: the Web UI's API client calls fourteen operations neither the contract nor the engine has

- **Filed as**: [spdrman/rclone-manager#211](https://github.com/spdrman/rclone-manager/issues/211)
- **Pinned by**: `suites/equivalence/specs/contract-gaps.spec.ts`
- **Build**: `rclone-manager` at `137f64699203a5ec6d2a6e399a654b99814a5a74`
- **Kind**: divergence between two of the product's own artefacts, found by
  running them against each other for the first time.

## Contract

`api/v1/openapi.json` is authoritative (issue #166, PR #194). It declares
19 paths. `apps/common/webhost/router.go` registers exactly those
operations and nothing else.

## Observed

`ui/shared/src/api/client.ts` requests fourteen `(method, path)` pairs that
are in neither. Against a live engine, authenticated, on `main`:

```
GET /api/v1/version    -> 404   (the contract has /system/version)
GET /api/v1/health     -> 404   (health lives outside /api/v1)
GET /api/v1/backups    -> 404
GET /api/v1/activity   -> 404
GET /api/v1/quarantine -> 404
GET /api/v1/operations -> 405   (POST /operations exists; GET does not)
POST /api/v1/catalog/scan, /catalog/rebuild -> 404
POST /api/v1/backup-sets/{id}/run, /enabled, /test-connection -> 404
```

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
