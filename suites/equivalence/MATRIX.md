# Suite C coverage matrix

Every backend-mutating or materially state-revealing Web UI function that
ships across Phases 2 through 4, mapped to its CLI equivalent, with the
gaps stated rather than omitted.

Re-derived at implementation time from the shipped pages
(`ui/shared/src/App.tsx`'s twelve routes, `ui/shared/src/api/client.ts`'s
request surface) and from the CLI's twelve registered commands
(`core/cmd/backup-manager/main.go`), against `rclone-manager` at
`137f64699203a5ec6d2a6e399a654b99814a5a74`.

**The pin has since moved to `6a93b96`, and the rows below have been
re-derived over that move.** What forced it: the move crossed
[#214](https://github.com/spdrman/rclone-manager/pull/214) (`aba87b7`),
which registered and declared six of the pairs `findings/DISC-007.md`
recorded as absent, so `specs/contract-gaps.spec.ts` went red demanding
this document catch up. That is the mechanism working, not a failure.

Each affected row below was re-derived from the source rather than from
the failure message: `apps/common/webhost/router.go` for what the engine
registers, `api/v1/openapi.json` for what the contract declares, and
`core/cmd/backup-manager/main.go` for whether a CLI counterpart exists at
all. Rows that did not change were re-checked the same way rather than
assumed, and the ones still blocked are still blocked for the reason
already written against them.

One row this document still owes, unchanged by the move and predating it:
[#195](https://github.com/spdrman/rclone-manager/pull/195) gave
`client.ts` `GET /system/first-run` and `POST /system/first-run`, and the
second is backend-mutating (it writes a backup set and configures the
instance). It has no row here yet.

**Status vocabulary**, and the word that matters is the fourth:

| | |
|---|---|
| **proved** | a spec drives the action through the browser and through the CLI against two bit-identical fixture work directories, and compares the resulting backend state |
| **gap (UI only)** | the UI does this and no CLI command does. Listed, not invented |
| **gap (CLI only)** | the CLI does this and no UI surface does |
| **blocked** | both surfaces exist and the equivalence is not provable today, with the reason and the issue. Every blocked row is pinned by an assertion in `specs/contract-gaps.spec.ts`, so it goes red when the block is lifted and this document has to be updated |
| **unproved** | the block is gone and nothing proves the equivalence yet. The route is served and the CLI counterpart exists, but no spec drives both sides and compares, so this document does not claim they agree. Every unproved row names what would prove it. This is deliberately not **proved**: a row that says "the block lifted" is a different and much weaker statement than "I drove both surfaces and the resulting state matched", and writing the second when only the first was done is the exact rot this vocabulary exists to prevent |

## Reads

| UI function | CLI equivalent | Equivalent state means | Status |
|---|---|---|---|
| Backup sets list (`/sets`) | `sources` | the same set identifiers, and the same count | **proved** (`specs/reads.spec.ts`) |
| Build provenance (Settings) | `version` | the same version and commit | **blocked**: the UI calls `GET /api/v1/version`, which does not exist ([#211](https://github.com/spdrman/rclone-manager/issues/211)). The engine half is proved instead: the engine the browser talks to and the binary the CLI side runs report one commit |
| Dashboard health (`/`) | `status` | the same per-set verdicts, and the same overall health the exit code implies | **blocked**: the page cannot load, `GET /api/v1/health` and `GET /api/v1/version` are 404 ([#211](https://github.com/spdrman/rclone-manager/issues/211)) |
| Backups list (`/backups`) | `artifacts [--source S] [--backup-set B]` | the same artifact ids and lifecycle states | **unproved**: `GET /api/v1/backups` answers 200 since [#214](https://github.com/spdrman/rclone-manager/pull/214), registered and declared, so the block is gone. No spec drives it yet. Proving it means listing artifacts in the browser and through `artifacts` over one fixture and comparing ids and lifecycle states, which is a spec this repository does not have |
| Backup detail (`/backups/:id`) | `artifacts` filtered | the same artifact record | **unproved**: rides the same now-served route ([#214](https://github.com/spdrman/rclone-manager/pull/214)). Proving it means the row above plus a per-artifact comparison, and it should not be attempted before the list row is proved, since a detail view that agrees while the list does not is the less useful half |
| Activity feed (`/activity`) | none | | **gap (UI only)**: no CLI command exposes an event log, checked against `main.go`'s registered commands at this pin and still true. `GET /api/v1/activity` answers 200 since [#214](https://github.com/spdrman/rclone-manager/pull/214), so the page loads now, but a UI-only surface has nothing to be equivalent to and this stays a gap rather than becoming unproved |
| Live operation status | none | | **gap (UI only)**: `GET /api/v1/operations` answers 200 since [#214](https://github.com/spdrman/rclone-manager/pull/214), which also declared the GET the contract previously had only as POST. The CLI still has no equivalent read, so this stays a gap for the same reason as the row above |

## Writes

| UI function | CLI equivalent | Equivalent state means | Status |
|---|---|---|---|
| Settings: retention policy | edit `config.yaml` per FR-5, then `check` | the resulting retention decisions, the filesystem, and the catalog, compared through `sources`, `artifacts`, `status`, `check` and `retention --dry-run` | **proved** (`specs/settings-write.spec.ts`, driving FR-19 last-known-good protection, which is the retention setting whose effect the read surface actually shows) |
| Run backup manually | `fetch --source S --backup-set B` | catalog rows, local tree digests, sidecar manifests | **blocked**: `POST /api/v1/operations` returns 403 `DESTRUCTIVE_OPERATIONS_DISABLED`. `serve.NewEngine` never sets a destructive gate and `NotYetImplementedGate.Passed()` is a hardcoded false, pending [#92](https://github.com/spdrman/rclone-manager/issues/92). The CLI has no such gate, which is the asymmetry |
| Retention apply | `retention` | the same artifacts deleted | **blocked twice over**: the API route is behind the same destructive gate, and FR-20 local deletion is not implemented on the CLI side either ([#21](https://github.com/spdrman/rclone-manager/issues/21), and Suite A's `retention/apply-is-not-implemented`) |
| Add, edit or remove a backup set | edit `config.yaml` per FR-5, then `check` | the effective config plus a `sources` read-back | **blocked**: `POST /api/v1/backup-sets` requires `host`, `user`, `ssh_key_id` and `known_hosts_line`, so it cannot express a `remote.type: local` set at all, and every local-remote fixture in this repository is one. A fixture with a real SSH endpoint would be needed to prove this row, which is [#87](https://github.com/spdrman/rclone-manager/issues/87)-shaped work rather than this issue's |
| Enable or disable a backup set | none | | **gap (UI only)**: `POST /api/v1/backup-sets/{source}/{set}/enabled` is registered and declared now, so the route half is no longer a block, but the CLI still has no enable/disable command (checked against `main.go` at this pin), which is what keeps this a gap |
| Quarantine: revalidate, retry ingestion | `validate <source/set/artifact>` for the revalidate half | the same resulting lifecycle state | **unproved**: `GET /api/v1/quarantine` answers 200 and the revalidate, retry and reinstate routes are registered and declared, all since [#214](https://github.com/spdrman/rclone-manager/pull/214). Proving the revalidate half means driving it in the browser and `validate` on the CLI over one fixture holding a quarantined artifact and comparing the resulting lifecycle state. Retry and reinstate have no CLI counterpart, so those stay UI-only whatever happens to the revalidate row |
| Catalog rebuild (`/catalog-recovery`) | `catalog rebuild [--dry-run]` | a rebuilt catalog equal through the read surface | **unproved**: `POST /api/v1/catalog/rebuild` and `/catalog/scan` are registered and declared since [#214](https://github.com/spdrman/rclone-manager/pull/214). They answer 403 to `contract-gaps.spec.ts`, and that 403 is `requireCSRF` refusing a probe that sends no token, not a gate: both routes carry `requireCSRF` and, unlike `POST /operations`, not `requireDestructiveGate`. A browser driving the real page carries the token, so the route is reachable in the shape that matters. Proving it means rebuilding through the page and through `catalog rebuild` over one fixture and comparing the catalog through the read surface |
| Local-auth enrolment | none | | **gap (UI only)**: there is no `backup-manager` command that enrols an administrator. This suite enrols over HTTP as setup, and names it as setup rather than comparing it |
| Password rotation | none | | **gap (UI only)**: `POST /api/v1/auth/password` has no CLI counterpart |
| SSH key import, host-key trust, connection test | none | | **gap (UI only)**: `POST /api/v1/ssh-keys`, `/ssh/host-key-probe`, `/backup-sets/test-connection`. The CLI has no key or trust management at all |

## CLI functions with no UI equivalent

| CLI command | Why there is no UI row |
|---|---|
| `run` | the UI's nearest equivalent is a per-set manual run, and there is no whole-cycle button |
| `daemon` | process lifecycle, which the UI never manages: the engine IS the daemon |
| `check` | config and state validation is not surfaced as an action anywhere in the UI |
| `reconcile` | FR-17 reconciliation has no UI surface |
| `validate <artifact>` | the UI's revalidate is quarantine-scoped, and that route does not exist yet, so there is no non-quarantine equivalent even in principle |
| `artifacts --source/--backup-set` filters | the Backups page has a set filter, but the page cannot load, so the filter has nothing to be equivalent to yet |

## What this matrix currently proves, honestly

Still two rows out of twenty. That is the finding, not the scope, and it
is worth being exact about what changed and what did not.

The suite that proves them is real: it boots the shipped engine over a
materialised fixture, serves the production `vite build` bundle in front of
it, signs in through the real login form, drives the real page, and
compares resulting backend state through the same Go oracle Suite A uses.
Nothing about the harness limits it to two rows.

What limited it used to be two things: four of the six pages could not
load, and two of the three mutating actions were refused before reaching
anything. The first is gone. [#214](https://github.com/spdrman/rclone-manager/pull/214)
closed the routes, so the Dashboard aside, those pages load and four rows
moved from **blocked** to **unproved**. The second is unchanged:
`serve` never sets a destructive gate and `NewRouter` defaults to
`NotYetImplementedGate`, so `POST /operations` and retention apply are
still refused, still pending [#92](https://github.com/spdrman/rclone-manager/issues/92).

So the proved count did not move, and saying otherwise would be the rot
this document is built to resist. Four rows stopped being blocked by a
missing route and started being limited by a missing spec, which is real
progress and a smaller claim than equivalence. Each of those rows names
the spec that would close it.

What remains blocked, re-derived at this pin rather than carried over:
the Dashboard and build-provenance rows, because `GET /api/v1/version`
and `GET /api/v1/health` are still in neither the router nor the contract
(the client is calling the wrong paths: `/system/version`, and health
lives outside `/api/v1`); the two destructive-gate rows above; and
backup-set creation, because `CreateBackupSetRequest` still requires
`host`, `port`, `user`, `ssh_key_id` and `known_hosts_line`, so it cannot
express the `remote.type: local` sets every fixture here uses.
