# Suite C coverage matrix

Every backend-mutating or materially state-revealing Web UI function that
ships across Phases 2 through 4, mapped to its CLI equivalent, with the
gaps stated rather than omitted.

Re-derived at implementation time from the shipped pages
(`ui/shared/src/App.tsx`'s twelve routes, `ui/shared/src/api/client.ts`'s
request surface) and from the CLI's twelve registered commands
(`core/cmd/backup-manager/main.go`), against `rclone-manager` at
`137f64699203a5ec6d2a6e399a654b99814a5a74`.

**The pin has since moved to `defa0a6`, and this matrix has not been
re-derived over the difference.** Saying so beats letting the header's
commit quietly become decorative. Exactly one thing entered the surface
in that range, from
[#195](https://github.com/spdrman/rclone-manager/pull/195): `client.ts`
gained `GET /system/first-run` and `POST /system/first-run`, and the
second of those is backend-mutating (it writes a backup set and
configures the instance), so it is a row this document owes. Every row
below is unaffected, since none of them touch that route. Re-derive
before adding anything else here, rather than appending to a matrix whose
basis is a commit behind.

**Status vocabulary**, and the word that matters is the fourth:

| | |
|---|---|
| **proved** | a spec drives the action through the browser and through the CLI against two bit-identical fixture work directories, and compares the resulting backend state |
| **gap (UI only)** | the UI does this and no CLI command does. Listed, not invented |
| **gap (CLI only)** | the CLI does this and no UI surface does |
| **blocked** | both surfaces exist and the equivalence is not provable today, with the reason and the issue. Every blocked row is pinned by an assertion in `specs/contract-gaps.spec.ts`, so it goes red when the block is lifted and this document has to be updated |

## Reads

| UI function | CLI equivalent | Equivalent state means | Status |
|---|---|---|---|
| Backup sets list (`/sets`) | `sources` | the same set identifiers, and the same count | **proved** (`specs/reads.spec.ts`) |
| Build provenance (Settings) | `version` | the same version and commit | **blocked**: the UI calls `GET /api/v1/version`, which does not exist ([#211](https://github.com/spdrman/rclone-manager/issues/211)). The engine half is proved instead: the engine the browser talks to and the binary the CLI side runs report one commit |
| Dashboard health (`/`) | `status` | the same per-set verdicts, and the same overall health the exit code implies | **blocked**: the page cannot load, `GET /api/v1/health` and `GET /api/v1/version` are 404 ([#211](https://github.com/spdrman/rclone-manager/issues/211)) |
| Backups list (`/backups`) | `artifacts [--source S] [--backup-set B]` | the same artifact ids and lifecycle states | **blocked**: `GET /api/v1/backups` is 404 ([#211](https://github.com/spdrman/rclone-manager/issues/211)) |
| Backup detail (`/backups/:id`) | `artifacts` filtered | the same artifact record | **blocked**: same route ([#211](https://github.com/spdrman/rclone-manager/issues/211)) |
| Activity feed (`/activity`) | none | | **gap (UI only)**: no CLI command exposes an event log. Also unreachable today, `GET /api/v1/activity` is 404 ([#211](https://github.com/spdrman/rclone-manager/issues/211)) |
| Live operation status | none | | **gap (UI only)**: `GET /api/v1/operations` is 405, and the CLI has no equivalent read either ([#211](https://github.com/spdrman/rclone-manager/issues/211)) |

## Writes

| UI function | CLI equivalent | Equivalent state means | Status |
|---|---|---|---|
| Settings: retention policy | edit `config.yaml` per FR-5, then `check` | the resulting retention decisions, the filesystem, and the catalog, compared through `sources`, `artifacts`, `status`, `check` and `retention --dry-run` | **proved** (`specs/settings-write.spec.ts`, driving FR-19 last-known-good protection, which is the retention setting whose effect the read surface actually shows) |
| Run backup manually | `fetch --source S --backup-set B` | catalog rows, local tree digests, sidecar manifests | **blocked**: `POST /api/v1/operations` returns 403 `DESTRUCTIVE_OPERATIONS_DISABLED`. `serve.NewEngine` never sets a destructive gate and `NotYetImplementedGate.Passed()` is a hardcoded false, pending [#92](https://github.com/spdrman/rclone-manager/issues/92). The CLI has no such gate, which is the asymmetry |
| Retention apply | `retention` | the same artifacts deleted | **blocked twice over**: the API route is behind the same destructive gate, and FR-20 local deletion is not implemented on the CLI side either ([#21](https://github.com/spdrman/rclone-manager/issues/21), and Suite A's `retention/apply-is-not-implemented`) |
| Add, edit or remove a backup set | edit `config.yaml` per FR-5, then `check` | the effective config plus a `sources` read-back | **blocked**: `POST /api/v1/backup-sets` requires `host`, `user`, `ssh_key_id` and `known_hosts_line`, so it cannot express a `remote.type: local` set at all, and every local-remote fixture in this repository is one. A fixture with a real SSH endpoint would be needed to prove this row, which is [#87](https://github.com/spdrman/rclone-manager/issues/87)-shaped work rather than this issue's |
| Enable or disable a backup set | none | | **gap (UI only)**: `POST /api/v1/backup-sets/{id}/enabled`, and the CLI has no enable/disable command. Also 404 today ([#211](https://github.com/spdrman/rclone-manager/issues/211)) |
| Quarantine: revalidate, retry ingestion | `validate <source/set/artifact>` for the revalidate half | the same resulting lifecycle state | **blocked**: `GET /api/v1/quarantine` and both action routes are 404 ([#211](https://github.com/spdrman/rclone-manager/issues/211)) |
| Catalog rebuild (`/catalog-recovery`) | `catalog rebuild [--dry-run]` | a rebuilt catalog equal through the read surface | **blocked**: `POST /api/v1/catalog/rebuild` and `POST /api/v1/catalog/scan` are both 404 ([#211](https://github.com/spdrman/rclone-manager/issues/211)) |
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

Two rows out of twenty. That is the finding, not the scope.

The suite that proves them is real: it boots the shipped engine over a
materialised fixture, serves the production `vite build` bundle in front of
it, signs in through the real login form, drives the real page, and
compares resulting backend state through the same Go oracle Suite A uses.
Nothing about the harness limits it to two rows. What limits it is that
against a real backend, four of the six pages cannot load and two of the
three mutating actions are refused before they reach anything.

Both of those are written up: [#211](https://github.com/spdrman/rclone-manager/issues/211)
for the routes, [#92](https://github.com/spdrman/rclone-manager/issues/92)
for the destructive gate. When either is fixed, the blocked rows here go
red on purpose and get promoted, which is the mechanism that stops this
document turning into a list of things that used to be true.
