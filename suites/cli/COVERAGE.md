# Suite A coverage matrix

Every case file under `cases/` appears here, and a test in
`suite_test.go` fails if one does not, so a case cannot be added without
the matrix showing it and a gap cannot be hidden by leaving a row out.

The command list was re-derived from `core/cmd/backupd/main.go` at
the pinned commit rather than trusted from a snapshot. It registers
twelve commands, plus `activity`, which backupd#598 adds.

`medium` and `settings` gained rows with
[#622](https://github.com/spdrman/backupd/issues/622). They were
registered commands with no cases at all before that, which the table
below said by omission rather than out loud, and the gap mattered:
`settings patch` is the one CLI write that can move where a retention
tier's backups live, and nothing black-box had ever driven it.

Fifteen of those seventeen cases are RED against the commit
`build-under-test.json` names, and are supposed to be: they describe
verbs that commit does not have. That is the specs-first half of the
lockstep this repository has used since
[#48](https://github.com/spdrman/backupd-tests/pull/48), whose
cases sat red the same way until
[#42](https://github.com/spdrman/backupd-tests/pull/42)'s pin move
landed on the build that had them. Until the pin moves onto
backupd#629's merge, `scripts/gate-local.sh` is red on exactly
those fifteen, and `RM_MODE=local` against a build of that branch is what
runs them green. The two that pass at both are
`medium/f1-config-missing` and `settings/f1-config-missing`: the
`--config` contract is older than any of this, and those two are the
family's regression guard rather than new coverage.

**Almost every case here is RED against the pin right now**, and for the
same specs-first reason. `build-under-test.json` names 87a9dc7, which
still calls itself `backupd`; the matrix asserts `backupd` throughout,
which is what
[backupd#648](https://github.com/spdrman/backupd/issues/648)
makes it print. The pin moves in backupd's own merge, and these go
green there. Retargeting them was not a rename of one word per file: the
old spelling also survives in three places that are not the command, and
those are named at the end of the Global section below.

**Cases pin one claim each.** `artifacts/happy` checks that the listing
lists, with lifecycle states drawn from FR-10's documented vocabulary; the
case that pins which state a `stable`-strategy artifact stops at is
`fetch/stable-strategy-holds-the-remote-copy`, because that is a claim
about FR-8 and FR-15 rather than about listing. Keeping them apart is
what stops an ordinary listing case going red when a safety rule changes.

**Contract sources.** Every case names its own in a `contract:` list.
Across the matrix they are `docs/EPIC.md`'s FR numbers,
`docs/EPIC-B-multi-nas.md`, `docs/recovery.md`, `container/Dockerfile`'s
healthcheck, and the binary's own usage banner, which is a contract in
its own right because it is where an operator learns what exists.

**Four dimensions, always.** Every case states an expectation for exit
code, stdout, stderr and on-disk state. The loader refuses a case that
leaves any of them unstated: `ignored` is allowed, but it has to be
written down, because the dimension nobody asserted is where a regression
lives. `harness/selftest` proves each of the four can actually fail.

## Global

| Case | Expectation |
|---|---|
| `global/g1-no-arguments` | exit 2, usage on stderr, nothing on stdout |
| `global/g2-unknown-command` | exit 2, the unrecognised name quoted, then the usage banner |
| `global/g3-usage-lists-every-command` | the banner lists all twelve commands, so one added or removed without documenting it fails here |
| `global/g4-config-default-is-the-packaged-directory` | the banner's `--config` default is `/etc/backupd/config/config.yaml`, and a directory there resolves to `config.yaml` inside it (#196) |
| `global/g5-usage-explains-the-mode-line` | the banner says which commands announce a `mode:` line and what `engine-attached`, `direct` and `unconfirmed` each mean ([#536](https://github.com/spdrman/backupd/issues/536), [#544](https://github.com/spdrman/backupd/issues/544)); doubles as the positive control for every `absent: "mode: engine-attached"` in the matrix |
| `global/f6-unknown-flag` | exit 2 on a flag the command does not define |
| `global/g6-the-old-name-reaches-the-same-binary` | the build under test, reached through a file called `backupd`, still answers `version` with `backupd` on the first line |
| `global/g7-the-old-name-still-says-backupd` | reached through the old name, an unknown command still prefixes its diagnostic `backupd: ` and still prints `usage: backupd`, so one host cannot tell two operators two different things |

**The two names.** The command is `backupd` from 0.3.3
([backupd#648](https://github.com/spdrman/backupd/issues/648)),
`backupd` until then, and the old spelling still runs: the image
links it beside the new one so nothing an operator already automated has
to change. Every case in this matrix asserts the printed name is `backupd`,
including the two above, which reach the binary through the old filename.
That pairing is the whole claim: the name a build prints is a fact about
the build, so both files have to print the same one.

What the pair does not cover is whether the shipped image actually
contains both names. `invoke_as` makes the link in the harness, and the
`go` builder the pin uses does not produce an image at all, so the case
is about the binary and `container/Dockerfile` owns the packaging half.
The three spellings that are *not* the command stay where they are and
are asserted that way: the config directory at `/etc/backupd`
(`global/g4-config-default-is-the-packaged-directory`), the image
reference `ghcr.io/spdrman/backupd`, and the Go package path
`core/cmd/backupd` that this document derives its command list
from.

## The shared failure family

Applied in full to `check`, whose whole job is these, and as F1 to every
other command that opens a config, so a command that stops honouring
`--config` cannot hide.

| Case | Fixture | Expectation |
|---|---|---|
| `check/f1-config-missing` | none | exit 1, `backupd: ` naming the path |
| `check/f2-malformed-yaml` | `malformed-yaml` | exit 1, stderr naming a parse problem |
| `check/f3-duplicate-backup-set-id` | `invalid-duplicate-set` | exit 1, stderr naming the offending field path (FR-7) |
| `check/f3-unsupported-remote-type` | `invalid-remote-type` | exit 1, stderr naming the type and the field (FR-4) |
| `check/f3-missing-local-path` | `invalid-missing-local-path` | exit 1, stderr naming `local_path` |
| `check/f3-zero-sources` | `zero-sources` | exit 1: a config that configures nothing to back up is a mistake to report, not an empty deployment to accept |
| `check/f4-state-database-absent` | `absent-state` | derived: FR-9 makes migrations version-controlled, which only makes sense if opening a missing database creates it, and nothing documents a missing file as an error. So exit 0, and the database exists afterwards |
| `check/f5-state-database-corrupt` | `corrupt-state` | exit 1, stderr naming the state database |
| `global/f6-unknown-flag` | any | exit 2 |

F1 is repeated for every other command that opens a config, as
`<command>/f1-config-missing`: `sources`, `status`, `artifacts`,
`activity`, `fetch`, `retention`, `reconcile`, `validate`, `catalog`,
`run`, `daemon`, `medium` and `settings`. That is fourteen near-identical cases on purpose. A command that quietly stops
honouring `--config`, or that starts reporting a missing file as a usage
error instead of an operational one, has to fail somewhere, and the only
place that catches it per command is a case per command.

## Per command

| Command | Happy path | Failure paths |
|---|---|---|
| `run` | `run/happy`: exit 0, FR-23 startup and rclone-version events, both sets committed per FR-14, the artifact FR-8 has not proven complete left on the remote | `run/f1-config-missing` |
| `daemon` | `daemon/sigterm-stops-cleanly`: bounded by a real SIGTERM after the first cycle, asserting exit 0, the cycle's commit, the committed file, and the shutdown event that used to be a race | `daemon/f1-config-missing` |
| `check` | `check/happy`: exit 0, the source and set counts, the state database path | the whole F1 to F6 family |
| `status` | `status/healthy`: exit 0, HEALTHY per set, FR-24's exposed fields | `status/stale-exits-one` (exit 1 and STALE), `status/never-run-is-degraded` (exit 1 and DEGRADED), `status/f1-config-missing` |
| `sources` | `sources/happy`: exactly the configured ids, their remote type, paths and stale threshold | `sources/f1-config-missing`, and `check/f3-zero-sources` covers the empty-config question |
| `artifacts` | `artifacts/happy`: both seeded artifacts, each with a state from FR-10's vocabulary and nothing else, and the count line; `artifacts/filters-narrow` asserts both the included and the excluded id; `artifacts/detail-shows-the-recorded-reason` ([#284](https://github.com/spdrman/backupd/issues/284)): the new `<source/backup-set/name>` operand's full field-by-field detail view for a QUARANTINED_LOST artifact, every field api/v1/openapi.json's `Artifact` schema names asserted present or contractually absent, plus the `reason`/`reason_at` fields that schema does not have at all, read from the journal's transition log directly | `artifacts/nonexistent-backup-set` (exit 1, with `fetch/nonexistent-backup-set` as the control that both commands refuse the same name the same way), `artifacts/f1-config-missing`, `artifacts/detail-malformed-artifact-id` and `artifacts/detail-unresolvable-artifact` (the detail operand's own id-shape and not-found refusals, mirroring `validate`'s), `artifacts/detail-rejects-filters-and-extra-operands` and `artifacts/detail-rejects-two-operands` (exit 2 arity errors) |
| `activity` | `activity/happy`: the durable lifecycle transitions a real cycle recorded, newest first, with the state, the backup set and the artifact on each row, plus the `mode:` line every read announces; `activity/json-emits-the-wire-shape` pins `ListActivityResponse`'s own field names, so the table above is free to change and the wire is not ([#598](https://github.com/spdrman/backupd/issues/598)) | `activity/severity-refuses-a-word-nobody-defined` (exit 2, and refused rather than silently unfiltered, which would print a whole pipeline log under a flag that says it is narrowed), `activity/f1-config-missing`, `activity/follow-refuses-with-no-engine` (the live feed is the serving process's own, so with nothing serving there is nothing to follow and it refuses rather than falling back to the durable log) |
| `backup-set edit-hold` | none: reporting a hold needs an engine holding one, and standing a serving process up beside a fixture is Suite C's job rather than this one's | `backup-set/edit-hold-refuses-with-no-engine`: a hold lives in the serving process's memory and does not survive it, so with nothing serving the command refuses instead of answering "not held" from a world where the question has no meaning ([#600](https://github.com/spdrman/backupd/issues/600)) |
| `fetch` | `fetch/happy`: FR-23 events, FR-10 transitions, the durable commit, and the incomplete artifact untouched; `fetch/stable-strategy-holds-the-remote-copy`: FR-8 plus FR-15, with the rename-strategy set as its positive control | `fetch/dry-run-changes-nothing`, `fetch/missing-required-flags` (exit 2), `fetch/nonexistent-backup-set` (exit 1), `fetch/unreachable-remote`, `fetch/f1-config-missing` |
| `retention` | `retention/preview-keeps-the-only-restore-point` (FR-18 tiers and FR-19 protection, hand-derived), `retention/every-artifact-is-kept-or-deleted` (FR-18's KEEP/DELETE partition over six artifacts), `retention/gfs-tiers-from-one-ingest` (the daily, weekly and monthly windows against each other over a 500-day backlog ingested in one cycle, with typed tier lists per artifact and FR-19's resolved date and provenance), `retention/override-flags-do-not-touch-config` and `retention/override-flags-narrow-the-itemisation`, which are each other's other half: accepted and inert against config, and actually deciding the preview | `retention/invalid-timezone`, `retention/invalid-negative-tier`, `retention/plain-retention-is-a-preview` (no --dry-run is not an apply: the note says so and `state: unchanged` proves it), `retention/f1-config-missing` |
| `reconcile` | `reconcile/clean`: exit 0, FR-23 startup, no unresolved findings | `reconcile/f1-config-missing` |
| `validate` | `validate/happy`: exit 0, checked and passed; `validate/operand-after-flags` and `validate/double-dash-ends-flags` cover the other two orders the banner permits | `validate/corrupted-local-copy` (exit 1 and FR-10 QUARANTINED), `validate/wrong-argument-count` (exit 2), `validate/malformed-artifact-id`, `validate/unresolvable-artifact`, `validate/unknown-flag-after-operand` (exit 2), `validate/f1-config-missing` |
| `catalog rebuild` | `catalog/rebuild-after-database-loss`, `catalog/rebuild-dry-run-writes-nothing` | `catalog/no-subcommand` (exit 2), `catalog/unknown-subcommand` (exit 2), `catalog/f1-config-missing` |
| `medium` | `medium/list-leads-with-the-local-hard-drive`: the drive this deployment's backups land on is the FIRST entry, names the drive, and says it is not declared, with the S3 medium after it as the control that the local entry was added to the list rather than replacing it ([#622](https://github.com/spdrman/backupd/issues/622)); `medium/test-connection-local-passes`: all nine steps of the local report in the engine's own order, including `space`, which no bucket has, and the two that are SKIPPED rather than passed; `medium/preflight-is-still-the-same-check-under-the-old-name`: the alias, driven against the id the new verb made checkable, which is where two implementations would part; `medium/default-moves-the-mark-and-nothing-else` and `medium/default-writes-the-mark-and-local-clears-it`: the mark moves, no tier is rewritten, and moving it back to the drive REMOVES the key rather than writing `local` into it, which is FR-35's round trip | the three local failures, told apart by which step failed: `medium/test-connection-local-reports-a-missing-path` (`reach`, `not_found`, everything after it skipped), `medium/test-connection-local-reports-a-permission-problem` (`reach` and `space` pass, `write` fails `permission_denied`, from a real probe write into a directory the mutation made read-only), `medium/test-connection-local-reports-no-room` (everything an S3-shaped check looks at passes and `space` still fails, weighed against the operator's own FR-21 margin); plus the two removal refusals, `medium/remove-refuses-the-destination-that-carries-the-mark` and `medium/remove-refuses-the-local-hard-drive`, `medium/default-refuses-a-destination-nothing-declares`, and `medium/f1-config-missing` |
| `settings` | `settings/patch-tier-medium-moves-one-tier`: one tier moves and the other two are asserted unchanged, because the write REPLACES the whole chain and a flag that built it from the wrong chain would move somebody's other tiers by the act of editing this one; `settings/patch-tier-medium-local-brings-a-tier-back`: `local` is a legal name here and what it writes is absence, so the round trip leaves the file it started with | `settings/patch-tier-medium-refuses-without-the-disclosure` (FR-27's gate, and the refusal IS the disclosure, naming the mapping and no price), `settings/patch-tier-medium-refuses-a-tier-nobody-declared` (exit 2, the tiers there are listed, nothing written), `settings/f1-config-missing` |
| `version` | `version/happy`: all four fields, shapes asserted, and this case doubles as the identity handshake | `version/no-config-flag` (exit 2 from the flag package), `version/rejects-an-operand` (exit 2 through usageError) |

## Multi-command sequences

Real operator flows are sequences, and some bugs only live in the state
carried between commands.

| Case | Sequence |
|---|---|
| `sequences/fetch-then-validate-then-status` | fetch both sets, re-validate one, preview retention, then ask `status` for a verdict |
| `sequences/loss-and-recovery` | fetch, delete the state database, `catalog rebuild`, then read the catalog back through `artifacts` |
| `sequences/failed-fetch-records-no-success` | a fetch against an absent remote, then `artifacts` proving the catalog recorded nothing |

## Known gaps

Stated rather than implied.

- **No SFTP remote is exercised.** Every fixture uses `remote.type: local`
  (FR-4), which covers the whole command surface without a container. The
  cases that need a real SSH endpoint, host-key trust decisions and
  unreachable-host behaviour distinct from unreachable-path behaviour, are
  not written. The pattern to port is `core/tests/sftpfixture` plus
  `core/tests/dockerlease`, ported and not imported, including the
  stale-container sweep. Standing one up needs a throwaway SSH key, and
  the rule against writing any credential to disk means that needs to be
  designed rather than improvised.
- **`daemon` is exercised for one cycle and one signal.** Its
  single-instance journal lock, its behaviour when a second daemon
  attaches to the same state database, and multi-cycle scheduling are not
  covered.
- **`retention` is covered in both its modes; the apply path is not
  reachable from the CLI at all.** FR-20 deletion exists
  ([#21](https://github.com/spdrman/backupd/issues/21) landed it,
  and [#239](https://github.com/spdrman/backupd/issues/239)
  extended it to a storage medium), but the only surface that runs it is
  the API's retention preview/apply pair, behind a reviewed `plan_id`.
  That is deliberate rather than unfinished
  ([#431](https://github.com/spdrman/backupd/issues/431)), so
  there is no CLI apply for this suite to cover, and covering the real
  one belongs to a suite that speaks HTTP. What this suite pins instead
  is that the CLI does not delete: `retention/plain-retention-is-a-preview`
  runs the mode that looks destructive and asserts `state: unchanged`.
- **GFS tier boundaries are covered for the default chain only.** The
  daily, weekly and monthly windows are now exercised against each other
  over one ingested backlog, in `retention/gfs-tiers-from-one-ingest` and
  `retention/override-flags-narrow-the-itemisation`, which #215 made
  possible: before it, every artifact a single-cycle fixture ingested
  landed in one bucket and there was no tier arithmetic to observe. What
  is still uncovered is the rest of
  [spdrman/backupd-tests#3](https://github.com/spdrman/backupd-tests/issues/3):
  the `quarter`, `half_year`, `year` and custom `days` granularities, a
  file dated exactly on a window edge, `week_starts_on`, timezone
  handling, and the cross-midnight case where an artifact produced late
  on one day and discovered early the next survives in both days'
  buckets. Those need a fixture that can put a file on a *named* calendar
  date rather than an offset from now, because whether two dates share a
  week or a month bucket depends on which weekday and which day of the
  month the suite happens to run on. The two cases above avoid that by
  keeping every pair of dates at least 31 days apart, which is
  bucket-distinct at every granularity whatever today is; that trick does
  not extend to a case whose whole point is a boundary.
- **The disk-pressure and quarantine surfaces** FR-21 and FR-10 describe
  are visible in `status` output but have no fixture that drives a set
  into them.
- **`backupd-web`** (`backupd-web` before 0.3.3, and still linked
  under that name) and its `serve`, `serve-ui` and `healthcheck`
  commands are Suites B and C's territory and are not covered here.
