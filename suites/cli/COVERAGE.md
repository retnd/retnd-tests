# Suite A coverage matrix

Every case file under `cases/` appears here, and a test in
`suite_test.go` fails if one does not, so a case cannot be added without
the matrix showing it and a gap cannot be hidden by leaving a row out.

The command list was re-derived from `core/cmd/backupd/main.go` at
the pinned commit rather than trusted from a snapshot. It registers
twelve commands, plus `activity`, which backupd#598 adds.

`medium` and `settings` gained rows with
[#622](https://github.com/backupdproject/backupd/issues/622). They were
registered commands with no cases at all before that, which the table
below said by omission rather than out loud, and the gap mattered:
`settings patch` is the one CLI write that can move where a retention
tier's backups live, and nothing black-box had ever driven it.

`snapshot`, `repository` and the four new `backup-set` verbs gained rows
with [backupd#789](https://github.com/backupdproject/backupd/issues/789),
EPIC K's release gate, which picked up the black-box coverage
[#788](https://github.com/backupdproject/backupd/issues/788) descoped.
They are the whole of the incremental engine's operator surface, and
before those rows nothing outside a browser had ever driven any of it.

`build-under-test.json` moved to 4ffc25f in the same change, because
every one of those cases asserts a command 87a9dc7 does not have. That
pin move is also what turned the `medium`, `settings` and old-name
families GREEN: they were red against 87a9dc7 for the specs-first reason
this repository has used since
[#48](https://github.com/backupdproject/backupd-tests/pull/48) -- cases
written before the build that implements them -- and 4ffc25f is the build
that has them. The lockstep's other half is still manual:
backupd's own `scripts/e2e/tests-repo.pin` moves in their merge.

Three of the new cases are RED on purpose and stay red: they are
`known_discrepancy` cases, whose expectation is what the documented
contract says and whose observed behaviour disagrees. See
`findings/DISC-010.md`, `DISC-011.md` and `DISC-012.md`. Each is narrowed
to the dimensions that actually disagree, so the rest of the case is
still asserted strictly and a second regression cannot hide behind the
marker.

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
| `global/g5-usage-explains-the-mode-line` | the banner says which commands announce a `mode:` line and what `engine-attached`, `direct` and `unconfirmed` each mean ([#536](https://github.com/backupdproject/backupd/issues/536), [#544](https://github.com/backupdproject/backupd/issues/544)); doubles as the positive control for every `absent: "mode: engine-attached"` in the matrix |
| `global/f6-unknown-flag` | exit 2 on a flag the command does not define |
| `global/g6-the-old-name-reaches-the-same-binary` | the build under test, reached through a file called `backupd`, still answers `version` with `backupd` on the first line |
| `global/g7-the-old-name-still-says-backupd` | reached through the old name, an unknown command still prefixes its diagnostic `backupd: ` and still prints `usage: backupd`, so one host cannot tell two operators two different things |

**The two names.** The command is `backupd` from 0.3.3
([backupd#648](https://github.com/backupdproject/backupd/issues/648)),
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
reference `ghcr.io/backupdproject/backupd`, and the Go package path
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
| `artifacts` | `artifacts/happy`: both seeded artifacts, each with a state from FR-10's vocabulary and nothing else, and the count line; `artifacts/filters-narrow` asserts both the included and the excluded id; `artifacts/detail-shows-the-recorded-reason` ([#284](https://github.com/backupdproject/backupd/issues/284)): the new `<source/backup-set/name>` operand's full field-by-field detail view for a QUARANTINED_LOST artifact, every field api/v1/openapi.json's `Artifact` schema names asserted present or contractually absent, plus the `reason`/`reason_at` fields that schema does not have at all, read from the journal's transition log directly | `artifacts/nonexistent-backup-set` (exit 1, with `fetch/nonexistent-backup-set` as the control that both commands refuse the same name the same way), `artifacts/f1-config-missing`, `artifacts/detail-malformed-artifact-id` and `artifacts/detail-unresolvable-artifact` (the detail operand's own id-shape and not-found refusals, mirroring `validate`'s), `artifacts/detail-rejects-filters-and-extra-operands` and `artifacts/detail-rejects-two-operands` (exit 2 arity errors) |
| `activity` | `activity/happy`: the durable lifecycle transitions a real cycle recorded, newest first, with the state, the backup set and the artifact on each row, plus the `mode:` line every read announces; `activity/json-emits-the-wire-shape` pins `ListActivityResponse`'s own field names, so the table above is free to change and the wire is not ([#598](https://github.com/backupdproject/backupd/issues/598)) | `activity/severity-refuses-a-word-nobody-defined` (exit 2, and refused rather than silently unfiltered, which would print a whole pipeline log under a flag that says it is narrowed), `activity/f1-config-missing`, `activity/follow-refuses-with-no-engine` (the live feed is the serving process's own, so with nothing serving there is nothing to follow and it refuses rather than falling back to the durable log) |
| `backup-set edit-hold` | none: reporting a hold needs an engine holding one, and standing a serving process up beside a fixture is Suite C's job rather than this one's | `backup-set/edit-hold-refuses-with-no-engine`: a hold lives in the serving process's memory and does not survive it, so with nothing serving the command refuses instead of answering "not held" from a world where the question has no meaning ([#600](https://github.com/backupdproject/backupd/issues/600)) |
| `snapshot list` | `snapshot/list-reports-a-set-that-has-taken-none`: a configured incremental set with no runs answers in a sentence and exits 0, which is the state every deployment is in before its first cycle | `snapshot/list-refuses-an-artifact-backup-set` (exit 1: an empty list would read as "this set has no backups", which is the opposite of the truth), `snapshot/list-refuses-a-set-this-configuration-does-not-have` (exit 1, nothing on stdout) |
| `snapshot show` | none: showing a run in full needs a run, which needs a repository and a source tree. Covered against a real one in backupd's `core/tests/e2eproduction` | `snapshot/show-refuses-a-run-id-the-set-does-not-have`: scoped to the SET, because run ids are unique per journal and a show that answered for any run it could find would print another set's snapshot under the id typed beside this one's name |
| `snapshot holds` | `snapshot/holds-reports-a-set-that-holds-nothing`: exit 0 and a sentence, because "nothing is held" is what says retention is free to act on every snapshot in the set | none beyond the shared family |
| `snapshot retention` | `snapshot/retention-previews-a-set-with-no-snapshots`: **red on purpose**, `findings/DISC-010.md`. The documented preview of an empty lineage is an empty answer and exit 0; observed is exit 1 and "an internal error occurred", because the preview opens the repository before it decides anything. Narrowed to exit/stdout/stderr, so "a preview that deletes nothing" stays asserted strictly | (the same case) |
| `snapshot verify` | none: proving a restore point readable needs one | `snapshot/verify-refuses-a-set-with-no-restore-point`: the product's most dangerous possible false positive. A set with nothing to read must be refused, never reported as verified, and `verified` is asserted ABSENT from the output |
| `snapshot restore` | none: see `snapshot verify`, and note this verb is not the `restore` above it, which asks a storage provider to thaw an archived copy | `snapshot/restore-refuses-a-set-with-no-restore-point`: refused, and nothing created at `--to`, so the next attempt does not meet `--conflict refuse` against the wreckage of this one |
| `snapshot hold` | none: a hold needs a snapshot to protect | `snapshot/hold-requires-a-reason` (exit 2, nothing ran): the product's own argument is asserted with it, because a hold nobody explained becomes permanent by accident, which is unbounded storage cost with no owner |
| `snapshot unhold` | none | `snapshot/unhold-refuses-a-hold-id-this-set-does-not-hold` (exit 1). Its on-disk expectation is `changed`, deliberately: a release attempt is a durable operation and is recorded as one with status `failed`, because releasing a restore point's protection is exactly what an audit must see somebody attempt |
| `repository health` | `repository/health-reports-a-domain-whose-repository-was-never-created`: FAILING with all seven checks itemised, the backup set attributed, the repository passphrase asserted ABSENT from the output (#789's no-credentials-anywhere criterion), and the policy sentence that says the storage answered, holds no repository, and nothing has been created there deliberately -- EPIC K's rule against creating a repository because a location looked empty | (the same case; exit 1 is the documented answer for FAILING) |
| `repository maintenance` | `repository/maintenance-answers-while-the-repository-is-unreachable`: exit 0 with every time field `never`, against a repository that cannot be opened at all, which is the verb's whole purpose -- the question "is maintenance overdue" has to be answerable during the incident where the storage is down | `repository/maintenance-refuses-a-domain-nobody-declared` (exit 1, nothing printed: a domain is an encryption-key and credential boundary, so an undeclared id names nothing this deployment may touch) |
| `backup-set enabled` | `backup-set/enabled-turns-a-configured-set-off`: the write, the `mode:` line, and the precise meaning of "off" -- the scheduler stops OFFERING the set, and a pass already inside it finishes, which an operator reading "off" as "stop now" would get wrong ([#788](https://github.com/backupdproject/backupd/issues/788)) | `backup-set/enabled-refuses-a-word-that-is-not-on-or-off` (exit 2, nothing written: "yes" could plausibly mean either value to a reader, and guessing means backups that silently stopped or silently restarted) |
| `backup-set read-only` | `backup-set/read-only-promises-never-to-delete-the-source`: the sentence is asserted and not just the exit code, because "on" is a promise about somebody else's data and a bare boolean leaves an operator guessing whether it describes the source or the backup ([#282](https://github.com/backupdproject/backupd/issues/282), #788) | none: going the other way is refused when the source cannot support it, which needs a real source |
| `backup-set create` (incremental) | `backup-set/create-writes-an-incremental-set-with-its-whole-budget`: the engine, the repository domain, the consistency mode and the four verification flags accepted and carried out, which before #788 no command line could express at all | `backup-set/create-refuses-kopia-without-a-repository-domain` (exit 1, with the product's own reasoning asserted; **red on the `state` dimension**, `findings/DISC-011.md`: a refused create strands the SSH key it imported and a `known_hosts` file for a set that does not exist), `backup-set/create-reports-every-field-it-wrote` (**red on `stdout`**, `findings/DISC-012.md`: the report documents itself as complete and names none of the seven incremental keys it wrote) |
| `backup-set patch` (incremental) | `backup-set/patch-revises-an-incremental-sets-verification-budget`: the budget is the one EPIC K setting an operator tunes after watching what it costs, and before #788 it could not be revised from a terminal at all | none yet: the refusal for a set that does not exist is a different case and belongs with the artifact-side patch coverage |
| `fetch` | `fetch/happy`: FR-23 events, FR-10 transitions, the durable commit, and the incomplete artifact untouched; `fetch/stable-strategy-holds-the-remote-copy`: FR-8 plus FR-15, with the rename-strategy set as its positive control | `fetch/dry-run-changes-nothing`, `fetch/missing-required-flags` (exit 2), `fetch/nonexistent-backup-set` (exit 1), `fetch/unreachable-remote`, `fetch/f1-config-missing` |
| `retention` | `retention/preview-keeps-the-only-restore-point` (FR-18 tiers and FR-19 protection, hand-derived), `retention/every-artifact-is-kept-or-deleted` (FR-18's KEEP/DELETE partition over six artifacts), `retention/gfs-tiers-from-one-ingest` (the daily, weekly and monthly windows against each other over a 500-day backlog ingested in one cycle, with typed tier lists per artifact and FR-19's resolved date and provenance), `retention/override-flags-do-not-touch-config` and `retention/override-flags-narrow-the-itemisation`, which are each other's other half: accepted and inert against config, and actually deciding the preview | `retention/invalid-timezone`, `retention/invalid-negative-tier`, `retention/plain-retention-is-a-preview` (no --dry-run is not an apply: the note says so and `state: unchanged` proves it), `retention/f1-config-missing` |
| `reconcile` | `reconcile/clean`: exit 0, FR-23 startup, no unresolved findings | `reconcile/f1-config-missing` |
| `validate` | `validate/happy`: exit 0, checked and passed; `validate/operand-after-flags` and `validate/double-dash-ends-flags` cover the other two orders the banner permits | `validate/corrupted-local-copy` (exit 1 and FR-10 QUARANTINED), `validate/wrong-argument-count` (exit 2), `validate/malformed-artifact-id`, `validate/unresolvable-artifact`, `validate/unknown-flag-after-operand` (exit 2), `validate/f1-config-missing` |
| `catalog rebuild` | `catalog/rebuild-after-database-loss`, `catalog/rebuild-dry-run-writes-nothing` | `catalog/no-subcommand` (exit 2), `catalog/unknown-subcommand` (exit 2), `catalog/f1-config-missing` |
| `medium` | `medium/list-leads-with-the-local-hard-drive`: the drive this deployment's backups land on is the FIRST entry, names the drive, and says it is not declared, with the S3 medium after it as the control that the local entry was added to the list rather than replacing it ([#622](https://github.com/backupdproject/backupd/issues/622)); `medium/test-connection-local-passes`: all nine steps of the local report in the engine's own order, including `space`, which no bucket has, and the two that are SKIPPED rather than passed; `medium/preflight-is-still-the-same-check-under-the-old-name`: the alias, driven against the id the new verb made checkable, which is where two implementations would part; `medium/default-moves-the-mark-and-nothing-else` and `medium/default-writes-the-mark-and-local-clears-it`: the mark moves, no tier is rewritten, and moving it back to the drive REMOVES the key rather than writing `local` into it, which is FR-35's round trip | the three local failures, told apart by which step failed: `medium/test-connection-local-reports-a-missing-path` (`reach`, `not_found`, everything after it skipped), `medium/test-connection-local-reports-a-permission-problem` (`reach` and `space` pass, `write` fails `permission_denied`, from a real probe write into a directory the mutation made read-only), `medium/test-connection-local-reports-no-room` (everything an S3-shaped check looks at passes and `space` still fails, weighed against the operator's own FR-21 margin); plus the two removal refusals, `medium/remove-refuses-the-destination-that-carries-the-mark` and `medium/remove-refuses-the-local-hard-drive`, `medium/default-refuses-a-destination-nothing-declares`, and `medium/f1-config-missing` |
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
  stale-container sweep. The throwaway-key half of that design now
  exists: `fixtures/lib`'s `ssh_key: true` writes a deterministic
  ed25519 key, derived from a fixed seed, as PKCS#8 PEM at `${SSH_KEY}`
  with mode 0600, because `backup-set create` cannot be invoked without
  a key to import. It is key material for a host that does not exist,
  regenerated identically on every run, and it authenticates against
  nothing. A real SSH endpoint would need a matching HOST key and a
  known_hosts decision, which is the part still undesigned.
- **No POPULATED Kopia repository is exercised.** The `snapshot` and
  `repository` families are covered against a deployment whose
  repository has never been created, because creating one needs a real
  snapshot run over a real source tree, and this suite has no engine and
  no containers. So every answer BEFORE a first successful run is
  covered here -- which is the whole of what an operator sees while they
  set one up, and where these commands are read hardest -- and every
  answer after it is covered against a real repository in backupd's own
  `core/tests/e2eproduction` (local) and `core/tests/miniointegration`
  (a bucket, on MinIO), which run the same verbs' service layer with
  snapshots in it. What is consequently NOT black-box covered is the
  rendering of a populated `snapshot list`'s five numbers, a
  `snapshot show` transition log, a hold's own report, a KEEP/DELETE
  retention preview, and a verification or restore that succeeds.
- **`daemon` is exercised for one cycle and one signal.** Its
  single-instance journal lock, its behaviour when a second daemon
  attaches to the same state database, and multi-cycle scheduling are not
  covered.
- **`retention` is covered in both its modes; the apply path is not
  reachable from the CLI at all.** FR-20 deletion exists
  ([#21](https://github.com/backupdproject/backupd/issues/21) landed it,
  and [#239](https://github.com/backupdproject/backupd/issues/239)
  extended it to a storage medium), but the only surface that runs it is
  the API's retention preview/apply pair, behind a reviewed `plan_id`.
  That is deliberate rather than unfinished
  ([#431](https://github.com/backupdproject/backupd/issues/431)), so
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
  [backupdproject/backupd-tests#3](https://github.com/backupdproject/backupd-tests/issues/3):
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
