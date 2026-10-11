# Suite C coverage matrix

Every backend-mutating or materially state-revealing Web UI function that
ships across Phases 2 through 4, mapped to its CLI equivalent, with the
gaps stated rather than omitted.

Re-derived at implementation time from the shipped pages
(`ui/shared/src/App.tsx`'s twelve routes, `ui/shared/src/api/client.ts`'s
request surface) and from the CLI's twelve registered commands
(`core/cmd/retnd/main.go`), against `retnd` at
`137f64699203a5ec6d2a6e399a654b99814a5a74`.

**The pin has since moved to `6a93b96`, and the rows below have been
re-derived over that move.** What forced it: the move crossed
[#214](https://github.com/backupdproject/backupd/pull/214) (`aba87b7`),
which registered and declared six of the pairs `findings/DISC-007.md`
recorded as absent, so `specs/contract-gaps.spec.ts` went red demanding
this document catch up. That is the mechanism working, not a failure.

Each affected row below was re-derived from the source rather than from
the failure message: `apps/common/webhost/router.go` for what the engine
registers, `api/v1/openapi.json` for what the contract declares, and
`core/cmd/retnd/main.go` for whether a CLI counterpart exists at
all. Rows that did not change were re-checked the same way rather than
assumed, and the ones still blocked are still blocked for the reason
already written against them.

**The CLI's registered command list has grown since, and the create rows
below have been re-derived over that.**
[#356](https://github.com/backupdproject/backupd/issues/356) added
`backup-set`, so `main.go` now registers fifteen commands rather than
twelve, and one of them does something this document recorded as having
no CLI counterpart at all.

One row this document still owes, unchanged by the move and predating it:
[#195](https://github.com/backupdproject/backupd/pull/195) gave
`client.ts` `GET /system/first-run` and `POST /system/first-run`, and the
second is backend-mutating (it writes a backup set and configures the
instance). It has no row here yet.

**EPIC L (workflow hooks) added a whole section, derived at
[#816](https://github.com/backupdproject/backupd/issues/816).** It is the
first feature in this document that arrived on both surfaces at once, so
every one of its mutating actions has a named CLI counterpart and none of
its rows is blocked by an absent route. Two actions have no control on
either surface and are recorded anyway, under a status word this document
did not have before: see `## Workflow hooks (EPIC L)` below.

Two corrections fell out of deriving it, and both are the same mistake
this document has now made three times: pinning a verb string somebody
guessed rather than reading what the binary offers. `backup-set enabled`
and `backup-set test-connection` both exist, and both were recorded here
as having no CLI counterpart. The exhaustiveness case in
`specs/contract-gaps.spec.ts` now covers the `workflow` family as well as
`backup-set`, and every subverb of both is pinned, so the next one cannot
ship unnoticed.

**Status vocabulary**, and the word that matters is the fourth:

| | |
|---|---|
| **proved** | a spec drives the action through the browser and through the CLI against two bit-identical fixture work directories, and compares the resulting backend state |
| **gap (UI only)** | the UI does this and no CLI command does. Listed, not invented |
| **gap (CLI only)** | the CLI does this and no UI surface does |
| **blocked** | both surfaces exist and the equivalence is not provable today, with the reason and the issue. Every blocked row is pinned by an assertion in `specs/contract-gaps.spec.ts`, so it goes red when the block is lifted and this document has to be updated |
| **unproved** | the block is gone and nothing proves the equivalence yet. The route is served and the CLI counterpart exists, but no spec drives both sides and compares, so this document does not claim they agree. Every unproved row names what would prove it. This is deliberately not **proved**: a row that says "the block lifted" is a different and much weaker statement than "I drove both surfaces and the resulting state matched", and writing the second when only the first was done is the exact rot this vocabulary exists to prevent |
| **gap (neither surface)** | the engine can do this and neither the shipped Web UI nor the CLI offers a way to ask for it. A row exists anyway, because the UI RENDERS the resulting state and an operator who can read a state they cannot cause will go looking for the control. EPIC L's bypass and cancel rows are the two, and both are pinned: bypass by `fetch --skip-workflow-scripts` being refused rather than ignored, and cancel by there being no verb under `workflow` at all, which the exhaustiveness case in `specs/contract-gaps.spec.ts` would notice the day one appears |

## Reads

| UI function | CLI equivalent | Equivalent state means | Status |
|---|---|---|---|
| Backup sets list (`/sets`) | `sources` | the same set identifiers, and the same count | **proved** (`specs/reads.spec.ts`) |
| Build provenance (Settings) | `version` | the same version and commit | **blocked**: the UI calls `GET /api/v1/version`, which does not exist ([#211](https://github.com/backupdproject/backupd/issues/211)). The engine half is proved instead: the engine the browser talks to and the binary the CLI side runs report one commit |
| Dashboard health (`/`) | `status` | the same per-set verdicts, and the same overall health the exit code implies | **blocked**: the page cannot load, `GET /api/v1/health` and `GET /api/v1/version` are 404 ([#211](https://github.com/backupdproject/backupd/issues/211)) |
| Backups list (`/backups`) | `artifacts [--source S] [--backup-set B]` | the same artifact ids and lifecycle states | **unproved**: `GET /api/v1/backups` answers 200 since [#214](https://github.com/backupdproject/backupd/pull/214), registered and declared, so the block is gone. No spec drives it yet. Proving it means listing artifacts in the browser and through `artifacts` over one fixture and comparing ids and lifecycle states, which is a spec this repository does not have |
| Backup detail (`/backups/:id`) | `artifacts` filtered | the same artifact record | **unproved**: rides the same now-served route ([#214](https://github.com/backupdproject/backupd/pull/214)). Proving it means the row above plus a per-artifact comparison, and it should not be attempted before the list row is proved, since a detail view that agrees while the list does not is the less useful half |
| Activity feed (`/activity`) | none | | **gap (UI only)**: no CLI command exposes an event log, checked against `main.go`'s registered commands at this pin and still true. `GET /api/v1/activity` answers 200 since [#214](https://github.com/backupdproject/backupd/pull/214), so the page loads now, but a UI-only surface has nothing to be equivalent to and this stays a gap rather than becoming unproved |
| Live operation status | none | | **gap (UI only)**: `GET /api/v1/operations` answers 200 since [#214](https://github.com/backupdproject/backupd/pull/214), which also declared the GET the contract previously had only as POST. The CLI still has no equivalent read, so this stays a gap for the same reason as the row above |

## Writes

| UI function | CLI equivalent | Equivalent state means | Status |
|---|---|---|---|
| Settings: retention policy | edit `config.yaml` per FR-5, then `check` | the resulting retention decisions, the filesystem, and the catalog, compared through `sources`, `artifacts`, `status`, `check` and `retention --dry-run` | **proved** (`specs/settings-write.spec.ts`, driving FR-19 last-known-good protection, which is the retention setting whose effect the read surface actually shows) |
| Run backup manually | `fetch --source S --backup-set B` | catalog rows, local tree digests, sidecar manifests | **blocked**: `POST /api/v1/operations` returns 403 `DESTRUCTIVE_OPERATIONS_DISABLED`. `serve.NewEngine` never sets a destructive gate and `NotYetImplementedGate.Passed()` is a hardcoded false, pending [#92](https://github.com/backupdproject/backupd/issues/92). The CLI has no such gate, which is the asymmetry |
| Retention apply | `retention` | the same artifacts deleted | **blocked twice over**: the API route is behind the same destructive gate, and FR-20 local deletion is not implemented on the CLI side either ([#21](https://github.com/backupdproject/backupd/issues/21), and Suite A's `retention/apply-is-not-implemented`) |
| Add a backup set | `backup-set create <source/backup-set>` | the persisted configuration, a `sources` read-back, and the rest of the work directory | **proved** (`specs/backup-set-create.spec.ts`) |
| Edit a backup set | `backup-set patch <source/backup-set>` | the persisted configuration and a `sources` read-back, the same comparison the create row above makes | **unproved**: both surfaces exist now. [#350](https://github.com/backupdproject/backupd/issues/350) landed `backup-set patch` and `PATCH /api/v1/backup-sets/{source}/{set}`, so this stopped being a gap, and no spec drives both over one fixture and compares. It is cheap to prove, because both write to `config.yaml` and both have a `sources` read-back, which is exactly what `specs/backup-set-create.spec.ts` already does |
| A backup set's own retention policy | `backup-set retention <source/backup-set>` `[--inherit] [--policy-file F] [--timezone T] [--week-starts-on D] [--daily-days N] [--weekly-months N] [--monthly-months N] [--protect-last-known-good=BOOL]` | the resolved policy for that set and where it came from, read back through `backup-set retention` with no flags and through `GET .../retention` | **unproved**: [#333](https://github.com/backupdproject/backupd/issues/333) gives this three operations on all three surfaces. The CLI is one flag-driven verb rather than the `show|set|clear` trio the issue text describes, and the API is `GET`, `PUT` and `DELETE` on `/api/v1/backup-sets/{source}/{set}/retention`, not two POSTs. An override replaces the deployment's whole chain and is never merged into it, so a spec proving these equivalent has to compare a whole resolved chain rather than one field |
| Remove a backup set | `backup-set remove <source/backup-set>` | the persisted configuration and a `sources` read-back, plus the artifacts the removal promises to leave alone | **unproved**: both surfaces exist since [#391](https://github.com/backupdproject/backupd/issues/391) landed `backup-set remove` and `DELETE /api/v1/backup-sets/{source}/{set}`. Proving it means driving both over one fixture and comparing the resulting configuration AND the surviving backups, because the dialog's promise is that retained backups stay on storage and stay listed, which is a claim about what did NOT change |
| Enable or disable a backup set | `backup-set enabled <source/backup-set> <on\|off>` | the persisted `enabled` flag and a `sources` read-back, plus whether a run visits the set at all | **unproved**: this row used to read **gap (UI only)** and was wrong, in the same way the remove row was wrong before [#391](https://github.com/backupdproject/backupd/issues/391) was noticed: the verb had shipped as `backup-set enabled` and `contract-gaps.spec.ts` pinned the string `backup-set enable`, so nothing went red. Both surfaces exist — `POST /api/v1/backup-sets/{source}/{set}/enabled` and the verb — and no spec drives both and compares |
| Quarantine: revalidate, retry ingestion | `validate <source/set/artifact>` for the revalidate half | the same resulting lifecycle state | **unproved**: `GET /api/v1/quarantine` answers 200 and the revalidate, retry and reinstate routes are registered and declared, all since [#214](https://github.com/backupdproject/backupd/pull/214). Proving the revalidate half means driving it in the browser and `validate` on the CLI over one fixture holding a quarantined artifact and comparing the resulting lifecycle state. Retry and reinstate have no CLI counterpart, so those stay UI-only whatever happens to the revalidate row |
| Catalog rebuild (`/catalog-recovery`) | `catalog rebuild [--dry-run]` | a rebuilt catalog equal through the read surface | **unproved**: `POST /api/v1/catalog/rebuild` and `/catalog/scan` are registered and declared since [#214](https://github.com/backupdproject/backupd/pull/214). They answer 403 to `contract-gaps.spec.ts`, and that 403 is `requireCSRF` refusing a probe that sends no token, not a gate: both routes carry `requireCSRF` and, unlike `POST /operations`, not `requireDestructiveGate`. A browser driving the real page carries the token, so the route is reachable in the shape that matters. Proving it means rebuilding through the page and through `catalog rebuild` over one fixture and comparing the catalog through the read surface |
| Local-auth enrolment | none | | **gap (UI only)**: there is no `retnd` command that enrols an administrator. This suite enrols over HTTP as setup, and names it as setup rather than comparing it |
| Password rotation | none | | **gap (UI only)**: `POST /api/v1/auth/password` has no CLI counterpart |
| SSH key import, host-key trust, connection test | `backup-set create --ssh-key-file` and `--trust-host-key` for the first two, `backup-set test-connection <source/backup-set>` for the third | | **gap (UI only), narrowed twice**: the CLI imports a key and settles a host key only as inputs to a create ([#356](https://github.com/backupdproject/backupd/issues/356)), never as standalone verbs, so `POST /api/v1/ssh-keys` and `/ssh/host-key-probe` still have no CLI counterpart a caller can invoke on its own. The connection test is no longer in that list: `backup-set test-connection` exists, which this document recorded as having "none at all". Not proved here either: an import mints a fresh uuid by design, so two independent imports of one key are correctly unequal and the create row places the key under one id instead |

## Workflow hooks (EPIC L)

EPIC L added a whole feature to both surfaces at once, which is unusual
here and worth saying: every mutating action the Web UI offers has a CLI
counterpart, and the two actions that have no UI control at all are the
interesting rows rather than the missing ones.

Two asymmetries shape this section and neither is a defect:

- **The CLI's configuration verbs are refused beside a serving engine.**
  `settings workflow patch` and `backup-set workflow patch` write
  `config.yaml`, and a second process writing it under a running engine
  is the thing `mode.go` exists to prevent. So the API is the only route
  to those writes on a live deployment, and a spec proving equivalence
  has to stop the engine to run the CLI half. That is a real cost and it
  is why every configuration row below is **unproved** rather than
  cheap.
- **`workflow recovery resume-cleanup` and `acknowledge` are NOT behind
  the destructive gate**, unlike `POST /operations`. Deliberately: a run
  that abandoned its cleanup may have left a source quiesced, and a
  deployment that has not turned destructive operations on must still be
  able to unwind it. So these two are the only mutating workflow rows
  that a browser can drive today end to end, and `specs/contract-gaps.spec.ts`
  pins their 403-on-CSRF so a gate appearing in front of them goes red
  here.
- **Both configuration writes are verified BEFORE they persist, by both
  surfaces.** A write that points a stage directory at a script which
  does not parse, or which carries an error-severity finding, is refused
  and nothing is saved — `backup-set workflow patch` prints the refusal
  and exits non-zero, and the API answers `WORKFLOW_SCRIPT_REJECTED`
  with the blocking scripts, which the cards draw in full. So "a backup
  set configured with a rejecting hook" is not a state any route can
  reach, and a spec that wanted one would be asking for something the
  product is right to refuse. Suite B drives the refusal instead
  (`e2e/workflow-config.spec.ts`), and checks the deployment's
  configuration is unchanged afterwards.

| UI function | CLI equivalent | Equivalent state means | Status |
|---|---|---|---|
| Configure one set's hooks (Workflow card: before/after directory, script timeout, execution connection) | `backup-set workflow patch <source/backup-set> [--before-dir D] [--after-dir D] [--script-timeout D] [--exec-connection REF]` | the persisted `workflows` block for that set, read back through `backup-set workflow <source/backup-set>` and `GET /api/v1/backup-sets/{source}/{set}/workflow` | **unproved**: both surfaces exist. `PATCH .../workflow` carries `requireCSRF` and no destructive gate, and the CLI verb is refused only beside a serving engine. Proving it means writing the same block through the browser and, with the engine stopped, through the CLI over one fixture, and comparing `config.yaml` plus the read-back |
| Configure the deployment's hooks (Settings › Workflow: root, before/after directory, script timeout) | `settings workflow patch [--root P] [--before-dir D] [--after-dir D] [--script-timeout D]` | the persisted deployment-wide `workflows` block, read back through `settings workflow` and `GET /api/v1/settings/workflow` | **unproved**: same shape as the row above, and the same engine-stopped cost on the CLI half. The Web UI half is asserted in Suite B (`e2e/workflow-run.spec.ts` borrows a global stage and hands it back), which proves the route writes — not that the two surfaces agree |
| Set a hook environment variable, by value or by secret reference | `settings workflow env set NAME (--value V \| --secret-file P \| --secret-env VAR \| --secret-command W ...)`, and `backup-set workflow env <source/backup-set> set NAME ...` | the persisted variable and WHERE its value comes from. Never the value: the API has no field a resolved secret could arrive in, and neither surface can read one back | **unproved**: both surfaces exist (`PUT .../workflow/environment/{name}`). Proving it means writing the same reference through both and comparing the persisted location, which is the whole of what either surface stores |
| Unset a hook environment variable | `settings workflow env unset NAME`, `backup-set workflow env <source/backup-set> unset NAME` | the variable gone from the persisted block, and the inheritance preview falling back to the scope below it | **unproved**: `DELETE .../workflow/environment/{name}` is served and CSRF-gated |
| Check this set's hooks (the validation report, its findings and its two verdicts) | `validate workflow <source/backup-set> [--json]` | the same script list in plan order, the same BSH findings with the same positions, and the same `valid for backup` / `workflow valid` pair | **unproved**: a read rather than a write, and materially state-revealing: it is where an operator learns that an SFTP-only source cannot run a hook. Not probed by `contract-gaps.spec.ts`, deliberately — the route opens a connection to the source host AND to the Host Workflow Runner, so a bare liveness probe of it would be dialling machines to find out whether a route exists. Suite B asserts the browser half (`e2e/workflow-config.spec.ts`) |
| Workflow run history and one run's page (three verdicts, five stages, every step) | `workflow run list [--backup-set S] [--limit N]`, `workflow run show <run-id>`, `workflow run steps <run-id>` | the same run ids and, per run, the same three verdicts and the same steps in plan order | **unproved**: both surfaces read the same journal rows. Proving it means running one hooked set and comparing the run page against `workflow run show` |
| One step's captured output (the step log terminal) | `workflow run log <run-id> --step <step-id> [--cursor N] [--follow]` | the same captured bytes from the same cursor | **unproved**, and the one row where the two surfaces must deliberately DIFFER in rendering: the CLI writes to a terminal that interprets control sequences, and the browser renders them inert. The equivalent state is the durable record, not the pixels. Suite B proves the browser half cannot be made to act on what it draws (`e2e/workflow-terminal.spec.ts`) |
| Recovery holds (the banner, and the Run control it disables) | `workflow recovery show` | the same held runs, each with the same run id and spool reference | **unproved**: `GET /api/v1/workflow-recovery` is served and the verb exists |
| Resume cleanup (banner button) | `workflow recovery resume-cleanup <run-id>` | the hold gone, the owed "after" hooks executed from that run's own retained spool, and the backup set runnable again | **unproved**: both surfaces exist, and this is the most valuable row in the section to prove, because the two halves race by design — `workflowrun`'s obligation state machine moves a scope to `in_progress` durably before executing a hook, so a resume typed at a terminal and one clicked in a browser serialise on a row rather than both unwinding. Suite B drives the browser half against a genuinely crashed engine (`e2e/workflow-recovery.spec.ts`) |
| Acknowledge a held run (banner dialog, reason required) | `workflow recovery acknowledge <run-id> --reason "..."` | the hold gone, the reason recorded durably against the run with the account that wrote it, and nothing changed on the source machine | **unproved**: both surfaces exist and both REQUIRE the reason — the CLI refuses a blank one as "the same as none", and the dialog's submit stays disabled until the textarea has words in it. Suite B pins the browser half of that refusal |
| Bypass a set's hooks for one run | none — `fetch --skip-workflow-scripts` is refused rather than ignored | | **gap (neither surface)**: the only way to ask for this is `POST /api/v1/operations` with `skip_workflow_scripts`, which sits behind the destructive gate, and no control in the shipped bundle submits it. The UI renders the result — a "Scripts bypassed" badge beside the run state, and a workflow verdict that says so rather than reporting the hooks skipped — so an operator can read a state neither surface lets them cause. `fetch`'s own refusal names the reason: bypassing is an administrator action performed by the process that serves the deployment, recorded on the run row and in a warn-level event |
| Cancel a workflow run | none | | **gap (neither surface)**: there is no cancel verb under `workflow` and no cancel control in the bundle. `canceled` is a real run state the journal records and the run page draws, and what matters about a canceled run is what happened to the cleanup it still owed, which is the Cleanup verdict. The exhaustiveness case in `specs/contract-gaps.spec.ts` now covers the `workflow` family, so a cancel verb appearing goes red here |

## Recovery and assurance (EPIC Q)

EPIC Q (retnd#953) put recovery, scrubbing and the three assurance claims on both
surfaces. The rows below were derived from the shipped pages
(`ui/shared/src/assurance/`, `SettingsPage.tsx`, the Backup detail page), from
`api/v1/openapi.json`, and from the binary's own usage text (`settings assurance`,
`backup-set assurance`, `scrub`, `recover`), not from the epic's description of them.

Two things the epic describes are **not** on both surfaces, and the rows say so rather
than imply a pair:

- There is **no route that starts a scrub or a recovery test**, and no CLI verb that
  starts a recovery test (it runs from the daemon's schedule). The Web UI's production
  client reports `offers: { operations: false }`, so a real deployment shows the
  equivalent `retnd scrub` command and no button. The mock API offers both, which is why
  the documentation pictures show them and no spec here can drive them.
- **Recovery is outside the destructive gate**, by design (Q1.1). That is the one
  direction this suite cannot compare, because the CLI has no gate: the browser half is
  asserted (the same engine that completed a browser recovery still answers `403
  DESTRUCTIVE_OPERATIONS_DISABLED` to `POST /api/v1/operations`) and the CLI half is
  simply absent.

| UI function | CLI equivalent | Equivalent state means | Status |
|---|---|---|---|
| Settings > Assurance: scrub cadence | `settings assurance patch --scrub-cadence D` | the resolved policy (`settings assurance --json`), and the same value on a set that inherits | **proved** (`specs/assurance-recovery.986.spec.ts`) |
| Settings > Assurance: a cadence under the one-hour floor | the same verb | refused on both, nothing written | **proved** (same spec). The browser refuses before it asks and the CLI refuses with exit status 1, so the exit codes are the CLI's alone |
| Backup set > Assurance: Custom with a cadence | `backup-set assurance <set> --scrub-cadence D` | the set's own policy (`backup-set assurance --json`, `is_override`), and a sibling set still inheriting | **proved** (same spec) |
| Backup set > Assurance: Off, Required, Inherit | `backup-set assurance <set> --recovery-test-mode off\|required`, `--reset` | the set's resolved policy | **unproved**: both exist and Suite A pins the CLI half (`assurance/off-and-reset-round-trip`, `assurance/required-needs-a-validator`); no spec drives the browser half. Required needs a registered validator, which no fixture here has |
| Recover artifact > Download in this browser | `recover <id> --to -` | the delivered bytes, byte for byte, and equal to the digest the fixture's seeded bytes hash to | **proved** (same spec) |
| Recover artifact > Staging path | `recover <id> --to NAME` | the staged bytes, equal to that digest, and an identical `artifacts` read-back afterwards | **proved** (same spec) |
| Recover artifact, a corrupted local copy | the same, exit status 14 | the same refusal sentence, the engine's code `RECOVERY_LOCAL_COPY_CORRUPT` against the CLI's 14 (named in the usage text), and no staged file on either side | **proved** (same spec) |
| Recover artifact > Configured destination | `recover <id> --to medium:ID[/KEY]` | the object at the destination | **unproved**: needs an S3-compatible medium this suite cannot stand up |
| Recover artifact, an archived copy (the cost decision) | `recover <id> --acknowledge-cost` | no provider job started without the acknowledgement, exactly one with it | **unproved**: needs an archive-class medium and a provider that records its jobs |
| Scrub now | `scrub [<set> \| <artifact>]` | the per-copy record | **gap (CLI only)**: no route starts a scrub, so the production client offers no button |
| Run recovery test | none | | **gap (neither surface)**: it runs only from the daemon's schedule, and the browser's button exists in the mock only |
| Validator output and log | none | | **gap (UI only, mock only)**: no route reports it |
| The three claims on Backups and Backup detail | `artifacts`, `settings assurance due` | | **unproved**: the Stored and Content claims are built from the placements and the schedule; the Recovery claim has no route and renders Unknown |
| Dashboard assurance summary | `settings assurance due [--due\|--overdue]` | | **unproved**: counts derived client-side from the same schedule |

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

Three rows now, out of thirty-two. That is the finding, not the scope, and it
is worth being exact about what changed and what did not.

The denominator moved by ten with EPIC L and the numerator did not move at
all, which is the honest shape of a feature landing on both surfaces at
once: ten new workflow rows, every one of them **unproved**, plus two that
are **gap (neither surface)**. None of them is blocked by a missing route
or a missing verb — both halves exist for all ten — so nothing in that
section is waiting on the product. They are waiting on specs that drive
both surfaces and compare, and two of them are waiting on a spec that can
stop the engine first, because the CLI's configuration verbs are refused
beside a running one.

What Suite B proves about EPIC L is a different and weaker claim, and the
workflow rows are careful not to borrow it: `suites/web-ui`'s
`workflow-*.spec.ts` drive the browser half against a real deployment with
a real Host Workflow Runner and a real exec-capable source, which proves
the UI surface does what it says. It compares nothing to the CLI.

The suite that proves them is real: it boots the shipped engine over a
materialised fixture, serves the production `vite build` bundle in front of
it, signs in through the real login form, drives the real page, and
compares resulting backend state through the same Go oracle Suite A uses.
Nothing about the harness limits it to three rows.

What limited it used to be two things: four of the six pages could not
load, and two of the three mutating actions were refused before reaching
anything. The first is gone. [#214](https://github.com/backupdproject/backupd/pull/214)
closed the routes, so the Dashboard aside, those pages load and four rows
moved from **blocked** to **unproved**. The second is unchanged:
`serve` never sets a destructive gate and `NewRouter` defaults to
`NotYetImplementedGate`, so `POST /operations` and retention apply are
still refused, still pending [#92](https://github.com/backupdproject/backupd/issues/92).

The proved count has moved by one, and only one, which is worth being
precise about because the row it moved on is the one this document was
most wrong about. Four rows stopped being blocked by a missing route and
started being limited by a missing spec, and none of them has become
proved: that is real progress and a smaller claim than equivalence, and
each of those rows names the spec that would close it. Backup-set
creation is the row that actually moved, and it moved because a CLI verb
appeared and because the reason recorded against it did not survive being
re-read (below).

What remains blocked, re-derived at this pin rather than carried over:
the Dashboard and build-provenance rows, because `GET /api/v1/version`
and `GET /api/v1/health` are still in neither the router nor the contract
(the client is calling the wrong paths: `/system/version`, and health
lives outside `/api/v1`); and the two destructive-gate rows above.

Backup-set creation used to be on that list and is not any more, and it
is worth saying exactly what moved. Two things did. The CLI grew a verb
([#356](https://github.com/backupdproject/backupd/issues/356)), so the
row's CLI column stopped being "edit `config.yaml`", which was the
absence of an equivalent written as though it were one. And the reason
this suite recorded for the block turned out to be answerable rather than
structural: it said `CreateBackupSetRequest` requires `host`, `user`,
`ssh_key_id` and `known_hosts_line`, so the row needed a fixture with a
real SSH endpoint. It does not. Creating a set never opens a connection
to it, so the SSH-shaped fields can name a host nothing dials, and the
comparison is about what the two surfaces persist. What genuinely needs
an endpoint is the wizard's own path, whose Verify-server step probes the
host, and that is a different row.
