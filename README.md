# backupd-tests

End-to-end test suites for [`backupd`](https://github.com/spdrman/backupd),
run from outside it, against a build it has already released.

Three suites live here:

| Suite | What it is | Status |
|---|---|---|
| **A. CLI contract** | `backupd` driven black-box: argv in, exit code plus stdout plus stderr plus resulting on-disk state out | built, `make suite-a` |
| **B. Web UI** | the Playwright suite, driving a real deployment: browser to `serve-ui` to the proxy to `serve` to SQLite | built, `make suite-b` against a running rig, see [`suites/web-ui/README.md`](suites/web-ui/README.md) |
| **C. UI to CLI equivalence** | every backend-affecting UI action proved equal to its CLI equivalent by comparing resulting backend state | built, `make suite-c`, with the matrix in [`suites/equivalence/MATRIX.md`](suites/equivalence/MATRIX.md) |

All three share one fixture layer, which is the main reason they share a
repository. A Web UI test that exercises retention or quarantine needs a
backend seeded with the same artifacts, states and config that the
equivalent CLI test needs, and maintaining that twice would guarantee the
two drift.

## Why these live outside `backupd`

Because a test that can call the product's exported Go functions is not
testing what an operator has. From out here, a suite has exactly what a
real deployment has: a binary, a YAML config file, a state directory,
exit codes, printed output, and a browser. That is what catches a
contract break, and it is why **nothing in this repository may import
`github.com/spdrman/backupd/core/...`**. The moment it does, it
stops being an outside consumer and starts checking the product against
itself.

## Running it

```sh
make build           # resolve the pinned build and make it prove its identity
make suite-a         # the CLI contract suite
make suite-b-install # once: Playwright and a Chromium
make suite-b         # the Web UI suite, against the deployment RM_BASE_URL names
make suite-c         # UI-to-CLI equivalence, against the real engine
make gate            # everything that has to be green before a commit here
```

Suite A needs Go and nothing else. No browser, no Docker, no network
beyond the one clone of `backupd` that the pin resolves, which is
cached per commit. Most fixtures use `remote.type: local` (FR-4), so a
checked-in directory tree is a valid remote and there is no SSH endpoint
to stand up.

## Which build is under test

`build-under-test.json` is the pin, and it is the only thing that decides
what a run certifies. See [`docs/pinning.md`](docs/pinning.md) for the
three modes and how to point the suites at a newer build in one command.

The command is `backupd` from 0.3.3
([backupd#648](https://github.com/spdrman/backupd/issues/648)),
and was `backupd` before it. The old name still runs, because the
image links it beside the new one, so this repository has to be able to
tell the two apart: what the binary *prints* is asserted as `backupd` in
every case, what an operator *types* is asserted under both names in
`global/g6-…` and `global/g7-…`, and the three things merely named after
the old command (the config directory `/etc/backupd`, the image
`ghcr.io/spdrman/backupd`, the Go package path
`core/cmd/backupd`) did not move and are still spelled that way
throughout.

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
buys the same property a different way: `RM_BASE_URL` is required, has no
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
filed against `backupd`, and the case is marked
`known_discrepancy`, which the runner treats as a strict expected
failure: red while the issue is open, and red again the moment it starts
passing, so a fix forces the marker's removal. Three entries are open
today, and no contract question is. (This line said two while the table
in `findings/` had one row in it, which is what a hand-maintained count
does; it is derived from that table now, and DISC-008 and DISC-009 are
the two that made the drift visible.) Five have been retired: four when
[#209](https://github.com/spdrman/backupd/pull/209) answered them,
and DISC-006's FR-18 bucket-key question when
[#215](https://github.com/spdrman/backupd/pull/215) wrote the
missing rule into the requirement. Each time the pin moved onto the
answer in the same change, which is the mechanism working rather than an
exception to it: the cases stayed and now assert the contract with no
marker to relax them.

## Layout

```
build-under-test.json      the pin: which backupd build a run certifies
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
suites, and Suite B's own unit tests. It mirrors how `backupd`
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
`suites/web-ui/e2e/` was byte-identical to `backupd`'s
`ui/shared/e2e/` the one unused binding in there belonged upstream, but
#217 deleted that directory, so it is this repository's to fix and these
options are this repository's to turn on, in a change of its own. Real
ESLint is absent for the same reason, spelled out in
`suites/web-ui/README.md`.

## The CI signal

Moving the Playwright suite out of `backupd` would take away the
e2e feedback that repository's pull requests currently rely on, so the
replacement has to land in the same change. The design is in
[`docs/ci-signal.md`](docs/ci-signal.md), including the part that has not
been implemented yet and why.
