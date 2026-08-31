# Suite A coverage matrix

Every case file under `cases/` appears here, and a test in
`suite_test.go` fails if one does not, so a case cannot be added without
the matrix showing it and a gap cannot be hidden by leaving a row out.

The command list was re-derived from `core/cmd/backup-manager/main.go` at
the pinned commit rather than trusted from a snapshot. It registers
twelve commands.

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
| `global/f6-unknown-flag` | exit 2 on a flag the command does not define |

## The shared failure family

Applied in full to `check`, whose whole job is these, and as F1 to every
other command that opens a config, so a command that stops honouring
`--config` cannot hide.

| Case | Fixture | Expectation |
|---|---|---|
| `check/f1-config-missing` | none | exit 1, `backup-manager: ` naming the path |
| `check/f2-malformed-yaml` | `malformed-yaml` | exit 1, stderr naming a parse problem |
| `check/f3-duplicate-backup-set-id` | `invalid-duplicate-set` | exit 1, stderr naming the offending field path (FR-7) |
| `check/f3-unsupported-remote-type` | `invalid-remote-type` | exit 1, stderr naming the type and the field (FR-4) |
| `check/f3-missing-local-path` | `invalid-missing-local-path` | exit 1, stderr naming `local_path` |
| `check/f3-zero-sources` | `zero-sources` | exit 1: a config that configures nothing to back up is a mistake to report, not an empty deployment to accept |
| `check/f4-state-database-absent` | `absent-state` | derived: FR-9 makes migrations version-controlled, which only makes sense if opening a missing database creates it, and nothing documents a missing file as an error. So exit 0, and the database exists afterwards |
| `check/f5-state-database-corrupt` | `corrupt-state` | exit 1, stderr naming the state database |
| `global/f6-unknown-flag` | any | exit 2 |

F1 is repeated for every other command that opens a config, as
`<command>/f1-config-missing`: `sources`, `status`, `artifacts`, `fetch`,
`retention`, `reconcile`, `validate`, `catalog`, `run` and `daemon`. That
is eleven near-identical cases on purpose. A command that quietly stops
honouring `--config`, or that starts reporting a missing file as a usage
error instead of an operational one, has to fail somewhere, and the only
place that catches it per command is a case per command.

## Per command

| Command | Happy path | Failure paths |
|---|---|---|
| `run` | `run/happy`: exit 0, FR-23 startup and rclone-version events, both sets committed per FR-14, the artifact FR-8 has not proven complete left on the remote | `run/f1-config-missing` |
| `daemon` | `daemon/sigterm-stops-cleanly`: bounded by a real SIGTERM after the first cycle; the cycle's commit and the committed file are asserted strictly, the exit status is marked against [#190](https://github.com/spdrman/rclone-manager/issues/190) | `daemon/f1-config-missing` |
| `check` | `check/happy`: exit 0, the source and set counts, the state database path | the whole F1 to F6 family |
| `status` | `status/healthy`: exit 0, HEALTHY per set, FR-24's exposed fields | `status/stale-exits-one` (exit 1 and STALE), `status/never-run-is-degraded` (exit 1 and DEGRADED), `status/f1-config-missing` |
| `sources` | `sources/happy`: exactly the configured ids, their remote type, paths and stale threshold | `sources/f1-config-missing`, and `check/f3-zero-sources` covers the empty-config question |
| `artifacts` | `artifacts/happy`: both seeded artifacts with their FR-10 lifecycle states; `artifacts/filters-narrow` asserts both the included and the excluded id | `artifacts/nonexistent-backup-set` marked against [#187](https://github.com/spdrman/rclone-manager/issues/187), `artifacts/f1-config-missing` |
| `fetch` | `fetch/happy`: FR-23 events, FR-10 transitions, the durable commit, and the incomplete artifact untouched | `fetch/dry-run-changes-nothing`, `fetch/missing-required-flags` (exit 2), `fetch/nonexistent-backup-set` (exit 1), `fetch/unreachable-remote`, `fetch/f1-config-missing` |
| `retention` | `retention/preview-keeps-the-only-restore-point` (FR-18 tiers and FR-19 protection, hand-derived), `retention/override-flags-do-not-touch-config` | `retention/invalid-timezone`, `retention/invalid-negative-tier`, `retention/apply-is-not-implemented` marked against [#21](https://github.com/spdrman/rclone-manager/issues/21) with `retention/apply-announces-it-is-preview-only` as its control, `retention/f1-config-missing` |
| `reconcile` | `reconcile/clean`: exit 0, FR-23 startup, no unresolved findings | `reconcile/f1-config-missing` |
| `validate` | `validate/happy`: exit 0, checked and passed | `validate/corrupted-local-copy` (exit 1 and FR-10 QUARANTINED), `validate/wrong-argument-count` (exit 2), `validate/malformed-artifact-id`, `validate/unresolvable-artifact`, `validate/operand-after-flags` marked against [#188](https://github.com/spdrman/rclone-manager/issues/188), `validate/f1-config-missing` |
| `catalog rebuild` | `catalog/rebuild-after-database-loss`, `catalog/rebuild-dry-run-writes-nothing` | `catalog/no-subcommand` (exit 2), `catalog/unknown-subcommand` (exit 2), `catalog/f1-config-missing` |
| `version` | `version/happy`: all four fields, shapes asserted, and this case doubles as the identity handshake | `version/no-config-flag` marked against [#189](https://github.com/spdrman/rclone-manager/issues/189) |

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
- **`--dry-run` for `retention` is covered; the apply path cannot be**,
  because FR-20 deletion does not exist yet ([#21](https://github.com/spdrman/rclone-manager/issues/21)).
- **The disk-pressure and quarantine surfaces** FR-21 and FR-10 describe
  are visible in `status` output but have no fixture that drives a set
  into them.
- **`backup-manager-web`** and its `serve`, `serve-ui` and `healthcheck`
  commands are Suites B and C's territory and are not covered here.
