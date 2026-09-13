# DISC-010: `snapshot retention` reports "an internal error occurred" for a set whose repository has never been created

- **Filed as**: to be opened against `backupdproject/backupd` (see "Filing" below)
- **Pinned by**: `suites/cli/cases/snapshot/retention-previews-a-set-with-no-snapshots.yaml`
- **Build**: observed on `backupd` at
  `4ffc25fb1b8980a85fccc1cb6d9795f23b297569`
- **Kind**: a refusal that discards the one piece of information an
  operator needs, on the surface they reach first.

## Contract

`backupd snapshot retention <source/backup-set>` is documented, in the
binary's own usage text, as

> what snapshot retention would decide about each of this set's snapshots
> right now -- KEEP, DELETE or REFUSE, each with the reason. A preview;
> it deletes nothing

and exit code 0 is documented as "the command did what it was asked".

A set that has taken no snapshots has nothing for retention to decide
about, so the answer is an empty preview. Its two neighbours agree: on
the same fixture, `snapshot list` prints "production/uploads-tree has
taken no snapshots" and exits 0, and `snapshot holds` prints
"production/uploads-tree holds no snapshot" and exits 0.

## Observed

```
$ backupd snapshot retention production/uploads-tree --config .../config.yaml
backupd: service: reading production/uploads-tree's snapshots: an internal error occurred
$ echo $?
1
```

## Why

`app.Service.SnapshotRetentionPreview` opens the set's repository
(`openSetRepository`) before it asks the catalog anything, because
`snapshotretention.Pruner` needs a repository to confirm the restore
point with. On a deployment whose repository has never been created that
open fails, and the failure reaches `core/service`'s
`snapshotSurfaceError`, whose `switch` maps six named app-layer refusals
and sends everything else to

```go
default:
    return fmt.Errorf("service: reading %s's snapshots: an internal error occurred", id)
```

A repository that cannot be opened is not one of the six, so the cause is
replaced by a sentence that names nothing.

The information is not missing from the process. `repository health`, run
against the same fixture in the same state, reports the same condition
precisely, down to which of seven checks failed:

```
production  FAILING
  reachable:       false
  credentials:     the declared passphrase did not open this repository
  ...
  this repository's storage could not be reached
```

## Why this matters more than a wording nit

The state it fires in is the state every deployment is in while it is
being set up: a declared domain, a configured incremental set, and no
repository yet. So this is one of the first EPIC K commands a new
operator runs, and what it tells them is that the product has an internal
error. The two obvious next actions -- retry, and read the logs -- both
lead nowhere.

`an internal error occurred` is a deliberate boundary in `core/service`
and is right for what it is for: keeping SQLite sentences and filesystem
paths off the wire (see `ErrInvalidRequest`'s own doc). The defect is not
that the arm exists, it is that an unopenable repository falls into it
rather than being mapped like the other six refusals.

## Suggested shape of a fix

Either of two, and they are not equivalent:

1. Map the repository-open failure onto a named surface error, so the
   preview says the repository could not be opened and points at
   `repository health`. This is the smaller change.
2. Do not open the repository when the lineage is empty. A preview of
   nothing needs no repository, and this also makes the command work
   during the incident where the storage is down -- which is exactly the
   argument `repository maintenance` already makes for itself ("Opens
   nothing, so it answers while the repository itself is unreachable").

The second is the better answer and subsumes the first for this case, but
the first is still needed: a set WITH snapshots and an unreachable
repository hits the same arm.

## Filing

This finding was produced by the #789 release-gate work in
`backupdproject/backupd` and is recorded here with its reproduction. It
belongs upstream as its own issue against `core/service/snapshotsurface.go`
and `core/internal/app/snapshotsurface.go`; the case above stays red until
it is fixed, and goes red again if it starts passing while this marker is
still here.
