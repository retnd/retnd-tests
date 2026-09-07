# rclone-manager-tests

End-to-end test suites for [`rclone-manager`](https://github.com/spdrman/rclone-manager),
run from outside it, against a build it has already released.

Four suites live here:

| Suite | What it is | Status |
|---|---|---|
| **A. CLI contract** | `backup-manager` driven black-box: argv in, exit code plus stdout plus stderr plus resulting on-disk state out | built, `make suite-a` |
| **B. Web UI** | the Playwright suite, migrated out of `rclone-manager`'s `ui/shared/e2e/` | migrated, `make suite-b`, see [`suites/web-ui/README.md`](suites/web-ui/README.md) |
| **C. UI to CLI equivalence** | every backend-affecting UI action proved equal to its CLI equivalent by comparing resulting backend state | built, `make suite-c`, with the matrix in [`suites/equivalence/MATRIX.md`](suites/equivalence/MATRIX.md) |
| **D. Live deployment** | the shipped image deployed in containers, a real SFTP machine behind it, and a browser driving the operator's path between them | the harness plus enrolment, `make suite-d`, see [`suites/live-deployment/README.md`](suites/live-deployment/README.md) |

The first three share one fixture layer, which is the main reason they
share a repository. A Web UI test that exercises retention or quarantine
needs a backend seeded with the same artifacts, states and config that the
equivalent CLI test needs, and maintaining that twice would guarantee the
two drift. Suite D is the exception and says so: its fixture is a
deployment rather than a work directory, and the machine it backs up comes
from `rclone-manager`'s own single definition of one
(`scripts/e2e/source-machine.Dockerfile`) rather than from anything here.

## Why these live outside `rclone-manager`

Because a test that can call the product's exported Go functions is not
testing what an operator has. From out here, a suite has exactly what a
real deployment has: a binary, a YAML config file, a state directory,
exit codes, printed output, and a browser. That is what catches a
contract break, and it is why **nothing in this repository may import
`github.com/spdrman/rclone-manager/core/...`**. The moment it does, it
stops being an outside consumer and starts checking the product against
itself.

## Running it

```sh
make build           # resolve the pinned build and make it prove its identity
make suite-a         # the CLI contract suite
make suite-b-install # once: Playwright and a Chromium
make suite-b         # the Web UI suite, against RM_UI_DIR or the pin
make suite-c         # UI-to-CLI equivalence, against the real engine
make suite-d-install # once: Playwright and a Chromium
make suite-d         # the operator's path against a deployment in containers
make gate            # everything that has to be green before a commit here
```

Suite A needs Go and nothing else. No browser, no Docker, no network
beyond the one clone of `rclone-manager` that the pin resolves, which is
cached per commit. Most fixtures use `remote.type: local` (FR-4), so a
checked-in directory tree is a valid remote and there is no SSH endpoint
to stand up.

Suite D is the other end of that: it needs Docker as well as a browser,
because what it tests is a deployment rather than a process, and there
really is an SSH endpoint to stand up. On a machine without a daemon it
refuses rather than skipping.

## Which build is under test

`build-under-test.json` is the pin, and it is the only thing that decides
what a run certifies. See [`docs/pinning.md`](docs/pinning.md) for the
three modes and how to point the suites at a newer build in one command.

Every run, in every mode, starts by asking the binary `version` and
refusing to continue unless the commit it reports matches what the pin
promised. That handshake exists because "the harness was pointed at the
right build" and "the harness tested the right build" are different
claims, and this project has already had the second one turn out false: a
control reported green against a stale dev server on a shared port, from
an entirely different commit. A path, a port and a container name can all
be stale without looking stale. A commit the binary prints about itself
cannot.

For the same reason, no suite here ever talks to a server it did not
start itself, on a port it did not pick and prove free.

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
filed against `rclone-manager`, and the case is marked
`known_discrepancy`, which the runner treats as a strict expected
failure: red while the issue is open, and red again the moment it starts
passing, so a fix forces the marker's removal. Two entries are open
today, and no contract question is. Five have been retired: four when
[#209](https://github.com/spdrman/rclone-manager/pull/209) answered them,
and DISC-006's FR-18 bucket-key question when
[#215](https://github.com/spdrman/rclone-manager/pull/215) wrote the
missing rule into the requirement. Each time the pin moved onto the
answer in the same change, which is the mechanism working rather than an
exception to it: the cases stayed and now assert the contract with no
marker to relax them.

## Layout

```
build-under-test.json      the pin: which rclone-manager build a run certifies
fixtures/
  scenarios/<name>/        declarative scenario definitions
  lib/                     materialisation, seeding by replay
  cmd/mkfixture/           the same, as a CLI, for the TypeScript suites
tools/
  getbuild/                resolve the pin, run the identity handshake
  statesnap/               normalised backend-state snapshot and diff
suites/
  cli/                     Suite A: harness, cases, COVERAGE.md
  web-ui/                  Suite B
  equivalence/             Suite C
  live-deployment/         Suite D: containers, a real SFTP source, a browser
findings/                  contract-versus-observed discrepancies
docs/                      pinning, and the CI signal design
```

## Working in this repository

```sh
git config core.hooksPath .husky
```

That wires `.husky/pre-commit` to `scripts/gate-local.sh`, which is the
gate: `gofmt`, `go vet`, the fixture and state-differ unit tests, the
harness self-tests, Suite A in full, `tsc --noEmit` over all three
TypeScript suites, and the unit tests of Suite B's and Suite D's
harnesses. It mirrors how `rclone-manager`
gates itself, and for the same reason: the merge signal in this estate is
local, so a red gate has to refuse the commit rather than annotate it
afterwards.

It needs Go, plus `npm ci` in `suites/web-ui`, `suites/equivalence` and
`suites/live-deployment`. It refuses rather than skips when those are
missing, and names the `npm ci` that fixes it. `make gate` is the Go-only half, for a machine with no
Node on it; the hook runs the script.

Playwright transpiles types away without checking them, so before the
type check went in, nothing in this repository ever read the types in the
browser suites at all. What the check does not turn on is
`noUnusedLocals`/`noUnusedParameters`, and the reason has changed: while
`suites/web-ui/e2e/` was byte-identical to `rclone-manager`'s
`ui/shared/e2e/` the one unused binding in there belonged upstream, but
#217 deleted that directory, so it is this repository's to fix and these
options are this repository's to turn on, in a change of its own. Real
ESLint is absent for the same reason, spelled out in
`suites/web-ui/README.md`.

## The CI signal

Moving the Playwright suite out of `rclone-manager` would take away the
e2e feedback that repository's pull requests currently rely on, so the
replacement has to land in the same change. The design is in
[`docs/ci-signal.md`](docs/ci-signal.md), including the part that has not
been implemented yet and why.
