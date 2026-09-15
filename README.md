<p align="center">
  <img src="assets/logo-mark.svg" alt="retnd mark: a broken ring standing for a transfer cycle in progress" width="72">
</p>

# backupd-tests

End-to-end test suites for [`retnd`](https://github.com/retnd/retnd),
run from outside it, against a build it has already released.

Three suites live here:

| Suite | What it is | Status |
|---|---|---|
| **A. CLI contract** | `retnd` driven black-box: argv in, exit code plus stdout plus stderr plus resulting on-disk state out | built, `make suite-a` |
| **B. Web UI** | the Playwright suite, driving a real deployment: browser to `serve-ui` to the proxy to `serve` to SQLite | built, `make suite-b` against a running rig, see [`suites/web-ui/README.md`](suites/web-ui/README.md) |
| **C. UI to CLI equivalence** | every backend-affecting UI action proved equal to its CLI equivalent by comparing resulting backend state | built, `make suite-c`, with the matrix in [`suites/equivalence/MATRIX.md`](suites/equivalence/MATRIX.md) |

All three share one fixture layer, which is the main reason they share a
repository. A Web UI test that exercises retention or quarantine needs a
backend seeded with the same artifacts, states and config that the
equivalent CLI test needs, and maintaining that twice would guarantee the
two drift.

## Why these live outside `retnd`

Because a test that can call the product's exported Go functions is not
testing what an operator has. From out here, a suite has exactly what a
real deployment has: a binary, a YAML config file, a state directory,
exit codes, printed output, and a browser. That is what catches a
contract break, and it is why **nothing in this repository may import
`github.com/retnd/retnd/core/...`**. The moment it does, it
stops being an outside consumer and starts checking the product against
itself.

## Running it

```sh
make build           # resolve the pinned build and make it prove its identity
make suite-a         # the CLI contract suite
make suite-b-install # once: Playwright and a Chromium
make suite-b         # the Web UI suite, against the deployment RETND_BASE_URL names
make suite-c         # UI-to-CLI equivalence, against the real engine
make gate            # everything that has to be green before a commit here
```

Suite A needs Go and nothing else. No browser, no Docker, no network
beyond the one clone of `retnd` that the pin resolves, which is
cached per commit. Most fixtures use `remote.type: local` (FR-4), so a
checked-in directory tree is a valid remote and there is no SSH endpoint
to stand up.

## Which build is under test

`build-under-test.json` is the pin, and it is the only thing that decides
what a run certifies. See [`docs/pinning.md`](docs/pinning.md) for the
three modes and how to point the suites at a newer build in one command.

The command is `retnd`, from EPIC R
([backupd#885](https://github.com/backupdproject/backupd/issues/885)). It
was `backupd` before that
([backupd#794](https://github.com/backupdproject/backupd/issues/794)) and
`rbm` from 0.3.3
([backupd#648](https://github.com/backupdproject/backupd/issues/648)).

The old name does NOT still run: R1.3
([backupd#888](https://github.com/backupdproject/backupd/issues/888))
retired `backupd` rather than aliasing it, and the image ships no link
under the old spelling, on the argument that printing two names is how a
reference stops being one. So what the binary *prints* is asserted as
`retnd` in every case, and what an operator *types* is asserted in
`global/g6-…` and `global/g7-…`, which reach this build through a
`backupd` filename the harness links itself and require the answer to
still say `retnd`. That is the outside view of a property nothing else
here checks: this binary does not dispatch on `argv[0]`, so the filename
it was reached through never decides what it calls itself.

Three things merely NAMED after the command are on their own schedules,
and this repository has to keep them apart from the command:

- the container's config directory, which **did** move, to `/etc/retnd`
  (R1.5, [backupd#890](https://github.com/backupdproject/backupd/issues/890));
- the Go package path, which **did** move, to `core/cmd/retnd`, in the
  same commit that moved the constant (R1.3);
- the published image, `ghcr.io/retnd/retnd`, which has **not**
  moved and is not this epic's in-tree half to move: a registry path is
  not redirected, and it changes with the organisation cutover (FR-41).

### The old name, where it deliberately survives here

FR-43's org-wide grep for the retired brand has to come back to an
enumerated allowlist rather than to nothing, and these are this
repository's entries — every one of them, checked by running the grep and
accounting for each line. Each is a REFERENCE to the old name rather than
a use of it, or a compat window with an owner:

| Where | What | Until |
|---|---|---|
| `suites/cli/cases/global/g6-…`, `g7-…` (`invoke_as: backupd`, and their docs) | the retired filename the binary is reached THROUGH, proving nothing dispatches on `argv[0]` | permanent |
| `tools/getbuild/handshake.go`'s version parser and `handshake_test.go`'s table (`retnd`, `backupd`, `rbm`, `backup-manager`) | every spelling the product has ever printed, because the pin may name a build on either side of any rename | permanent |
| `suites/web-ui/harness/session.ts`'s `backupd_*` and `bm_*` cookie names, and `session.test.ts`'s assertions about them | read-compat, mirroring `apps/common/csrf`'s own `cookieNames` list | closes with the product's, same issue and release |
| `suites/web-ui/harness/engine.ts` and the two Activity specs (`dial tcp: lookup rclone-manager …`) | a verbatim quotation of a log line from a reported incident, whose CAUSE was a container rename; rewriting it falsifies the record | permanent |
| `/backupd-web` in `docs/pinning.md`, `suites/cli/COVERAGE.md`, `tools/getbuild/getbuild.go` and g6's doc | a path that really is in the image: R1.5 (backupd#890) kept it for one release as a hardlink to `/retnd-web`, because published compose files name it in `command:` | closes with the hardlink |
| `core/cmd/backupd` in `docs/pinning.md` and `tools/getbuild/getbuild.go` | the package directory the Go builder used to compile, named in the sentence explaining why source mode cannot build a pre-rename sha | permanent |
| `BACKUP_MANAGER_API_URL` in `suites/equivalence/harness/fixtures.ts` | not a reference — the product's CURRENT variable name, unrenamed in `core/cmd/retnd/route.go`. Row 19 of the rename inventory, owned there, not here; spelling it any other way here would make a true comment false | until the product renames it |
| every `backupdproject/backupd#N`, `/issues/N` and `/pull/N` link, and every bare `backupd#N` reference | a record of where work was TRACKED. FR-41's cutover happened on 2026-09-15: `go.mod`'s module path, this repository's own name, the clone and checkout paths and the registry path all moved to `retnd/retnd-tests` and `ghcr.io/retnd/retnd` with it. What is left is issue and pull-request history, which GitHub's transfer preserves by number and redirects by URL, and rewriting a record of where something was filed falsifies it | permanent |

Reproduce with:

```sh
git grep -nE '(^|[^A-Za-z0-9_])(backupd|BACKUPD|Backupd|bm_[a-z]|RM_[A-Z]|rclone[-_ ]manager|backup[-_ ]manager|BACKUP_MANAGER)' \
  -- $(git ls-files | grep -v node_modules) \
  | grep -vE 'backupdproject|backupd#' | grep -v '^README.md:'
```

55 lines across 15 files as this was written, and every one of them is a
row above. This file is excluded from its own grep because it IS the
allowlist. `RM_[A-Z]` returns nothing at all: that contract is `RETND_*`
outright, with no compat alias, because the product repository's
`scripts/e2e` sets it and this repository reads it, and both halves move
together.

Every run, in every mode, starts by asking the binary `version` and
refusing to continue unless the commit it reports matches what the pin
promised. That handshake exists because "the harness was pointed at the
right build" and "the harness tested the right build" are different
claims, and this project has already had the second one turn out false: a
control reported green against a stale dev server on a shared port, from
an entirely different commit. A path, a port and a container name can all
be stale without looking stale. A commit the binary prints about itself
cannot.

For the same reason, no suite here ever talks to a server it cannot name.
Suites A and C still start their own, on a port they picked and proved
free. Suite B no longer starts anything at all, because what it drives is
a running deployment of four containers rather than a dev server, so it
buys the same property a different way: `RETND_BASE_URL` is required, has no
default, and a run without it stops and says so. A fallback to localhost
would be the stale dev server above wearing a different hat.

## How expectations are written

From the documentation, never from a recording.

Each case in `suites/cli/cases/` is a YAML file naming what it expects on
each of four dimensions (exit code, stdout, stderr, on-disk state) and,
in a `contract:` list, the FR number, document section or usage text the
expectation came from. The runner has **no whole-output golden mode**.
Not discouraged, not behind a flag: not implemented, so a recorded-output
expectation is structurally impossible to write.

That is a deliberate response to how a suite like this usually dies.
Record today's output as the expectation and you get a change detector:
it bakes current bugs in as correct, goes red when someone rewords a log
line, and stays green through a real regression as long as the wording
holds.

When derivation and observation disagree, the expectation does not move.
The disagreement is written up in [`findings/`](findings/README.md),
filed against `retnd`, and the case is marked
`known_discrepancy`, which the runner treats as a strict expected
failure: red while the issue is open, and red again the moment it starts
passing, so a fix forces the marker's removal. Three entries are open
today, and no contract question is. (This line said two while the table
in `findings/` had one row in it, which is what a hand-maintained count
does; it is derived from that table now, and DISC-008 and DISC-009 are
the two that made the drift visible.) Five have been retired: four when
(https://github.com/backupdproject/backupd/pull/209) answered them,
and DISC-006's FR-18 bucket-key question when
(https://github.com/backupdproject/backupd/pull/215) wrote the
missing rule into the requirement. Each time the pin moved onto the
answer in the same change, which is the mechanism working rather than an
exception to it: the cases stayed and now assert the contract with no
marker to relax them.

## Layout

```
build-under-test.json      the pin: which retnd build a run certifies
fixtures/
  scenarios/<name>/        declarative scenario definitions
  lib/                     materialisation, seeding by replay
  cmd/mkfixture/           the same, as a CLI, for the TypeScript suites
tools/
  getbuild/                resolve the pin, run the identity handshake
  statesnap/               normalised backend-state snapshot and diff
suites/
  cli/                     Suite A: harness, cases, COVERAGE.md
  web-ui/                  Suite B: the browser, against a real deployment
  equivalence/             Suite C
findings/                  contract-versus-observed discrepancies
docs/                      pinning, and the CI signal design
```

## Working in this repository

```sh
git config core.hooksPath .husky
```

That wires `.husky/pre-commit` to `scripts/gate-local.sh`, which is the
gate: `gofmt`, `go vet`, the fixture and state-differ unit tests, the
harness self-tests, Suite A in full, `tsc --noEmit` over both TypeScript
suites, and Suite B's own unit tests. It mirrors how `retnd`
gates itself, and for the same reason: the merge signal in this estate is
local, so a red gate has to refuse the commit rather than annotate it
afterwards.

It needs Go, plus `npm ci` in `suites/web-ui` and `suites/equivalence`.
It refuses rather than skips when those are missing, and names the `npm
ci` that fixes it. `make gate` is the Go-only half, for a machine with no
Node on it; the hook runs the script.

Playwright transpiles types away without checking them, so before the
type check went in, nothing in this repository ever read the types in
Suites B and C at all. What the check does not turn on is
`noUnusedLocals`/`noUnusedParameters`, and the reason has changed: while
`suites/web-ui/e2e/` was byte-identical to `retnd`'s
`ui/shared/e2e/` the one unused binding in there belonged upstream, but
 deleted that directory, so it is this repository's to fix and these
options are this repository's to turn on, in a change of its own. Real
ESLint is absent for the same reason, spelled out in
`suites/web-ui/README.md`.

## The CI signal

Moving the Playwright suite out of `retnd` would take away the
e2e feedback that repository's pull requests currently rely on, so the
replacement has to land in the same change. The design is in
[`docs/ci-signal.md`](docs/ci-signal.md), including the part that has not
been implemented yet and why.
