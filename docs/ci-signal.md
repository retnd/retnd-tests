# The CI signal, in both directions

## The problem this has to solve

Today a `rclone-manager` change gets Web UI e2e feedback in the same
working tree, and pull requests in that repository have been using e2e
pass counts as merge evidence. Moving the Playwright suite out here takes
that away unless something replaces it, so **the migration and its
replacement signal have to land in one change**. There must be no window
in which a UI regression can arrive unseen.

## Where the gate actually is

Not in GitHub Actions. Every workflow in `rclone-manager` is
`workflow_dispatch`-only, `nightly-e2e.yml` has its schedule commented
out, and merges rely on `.husky/pre-commit` running `scripts/ci-local.sh`
having been green. A GitHub-side required check would gate nothing,
because nothing triggers it.

So the replacement signal goes where the gate is: into `ci-local.sh`.

## What goes into `rclone-manager`

Implemented. This section was the specification; it now describes what
landed, and the two places it differs from the original design are called
out where they occur.

1. **`scripts/e2e/tests-repo.pin`** holds this repository's URL and a full
   commit sha. `scripts/e2e/bump-tests-pin.sh [ref]` moves it, and the
   commit that moves it is itself gated against the new pin, so a bad
   change here cannot land in the pin unnoticed.

2. **A new non-FAST step in `ci-local.sh`**, so `CI_LOCAL_FAST=1` skips it
   and the existing never-merge-on-FAST rule already covers that. It lives
   in `scripts/e2e/run-tests-repo-gate.sh` rather than inline, for the same
   reason every other proof this gate runs does: a step the gate's own
   self-test has to stub is easier to stub as one path than as twenty
   lines. The step:

   - clones `rclone-manager-tests` into
     `${XDG_CACHE_HOME:-$HOME/.cache}/rclone-manager-tests-gate/<sha>` and
     checks out the pinned sha detached. Keyed by sha rather than one
     shared directory, which is a change from the original design: this
     machine carries around fifty worktrees of the product, and one shared
     working tree that every concurrent gate run checks out into is shared
     mutable state of exactly the kind that produced #172. A directory
     there is immutable once complete, and the clone plus its `npm ci`
     happen in a scratch sibling renamed into place only at the end, so a
     half-finished attempt can never be mistaken for a good checkout;
   - runs the **Suite A smoke slice** against the working tree's own build:

     ```sh
     go build -ldflags "-X main.version=$(git rev-parse --short HEAD) -X main.commit=$(git rev-parse HEAD)" \
       -o "$tmp/rbm" ./core/cmd/backup-manager
     RM_MODE=local RM_BINARY="$tmp/rbm" RM_SOURCE_DIR="$PWD" \
       make -C "$gate_checkout" smoke
     ```

     The `-ldflags` are load-bearing: without them the binary reports
     `commit none` and the identity handshake refuses the run, which is
     the handshake doing its job rather than a problem to work around.

   - runs Suite B too. This step is the one that changed shape when the
     browser suite stopped driving a Vite dev server: `RM_UI_DIR` named a
     `ui/shared` checkout to serve, and there is nothing to serve any
     more. Suite B drives a deployment it did not create, so the step has
     to stand the containers up first and hand the suite `RM_BASE_URL`,
     `RM_ADMIN_USERNAME` and `RM_ADMIN_PASSWORD`. The rig lives in
     `rclone-manager`'s own `scripts/e2e/`, and wiring the gate step to
     it is that repository's half of the change: this one only pins the
     specs.

     What the suite gives back in exchange is the thing the dev server
     could not: the app under test is the image the commit builds,
     answering through the same reverse-proxy hop an operator's browser
     goes through, over a real session, reading a real database.

3. **Who triggers it, against which build, and how red blocks.** The
   pre-commit hook triggers it on every commit. The build under test is
   the working tree itself. A red suite exits nonzero, `ci-local.sh` is
   `set -e`, so the commit is refused, and the merge policy (full non-FAST
   green before an admin merge) makes it merge-blocking.
   `git commit --no-verify` stays the documented WIP escape hatch it
   already is.

   **A missing Chromium** was the open question #197 left for whoever
   implemented this, and it is answered with the repository's own
   precedent rather than a new shape: the step refuses, names
   `npx playwright install chromium` as the fix, and `CI_LOCAL_SKIP_E2E=1`
   is the out-loud opt-out that ledgers through `gate_note_skip`, so that
   run ends `INCOMPLETE` and says which check it left out. That is exactly
   how `gate_require_docker` treats a stopped daemon. Docker is the
   higher-consequence capability and it is refuse-by-default with a
   ledgered opt-out, so a browser gets the same treatment and not a weaker
   one.

4. **`nightly-e2e.yml`** is rewritten to check this repository out at the
   pin and run the full Suite B including the seven-provider re-run, still
   `workflow_dispatch`-only per the estate's Actions-off policy. The
   schedule stays commented unless the owner turns it on.

### When the working tree and the pin disagree

The gate step runs the suite against the working tree's build, while the
suite's own pin names some other commit. Those are different builds by
construction, and a case can legitimately go red because the working tree
predates a behaviour the pinned build has, or because it is ahead of one.

That is the suite doing its job, and the fix is to read which case failed
rather than to loosen it. A case is written to pin one claim, and its
`contract:` list names where that claim came from, so a red case names
the behaviour that differs. If a change in `rclone-manager` deliberately
changes a documented behaviour, the accompanying tests-repo change updates
the case and its `contract:` list, and the pin bump lands with it.

What this arrangement will not tolerate is a case that pins several
unrelated claims at once, because then one deliberate change reddens a
case that is not about it, and the pressure is to weaken the case rather
than to update it. `artifacts/happy` and
`fetch/stable-strategy-holds-the-remote-copy` are split for exactly that
reason.

### The smoke slice is a new signal

The Suite A smoke slice is worth calling out separately: it is a signal
`rclone-manager` has never had. Today nothing exercises the CLI
black-box on a per-commit basis at all. The smoke slice runs the real
binary against real fixtures on local remotes, needs no Docker and no
browser, and takes a couple of seconds.

## What goes into this repository

The mirror of the same pattern: `.husky/pre-commit` runs
`scripts/gate-local.sh`, which runs `go vet`, the tool and fixture unit
tests, the harness self-tests, Suite A in full against the pinned build,
`tsc --noEmit` over Suites B and C, and Suite B's unit tests.

The two type checks are there because Playwright transpiles types away
without checking them, and the ESLint config that used to read this code
stayed behind in `ui/shared` when the suite moved. Without them nothing
reads the types in either TypeScript suite. They need `npm ci` in both
suite directories, and the gate refuses rather than skips when that is
missing, for the same reason everything else here does. `make gate` is
the Go-only half, which is what the `workflow_dispatch` job runs, since
that runner sets up Go and nothing else.

A `workflow_dispatch`-only workflow exists for on-demand cloud runs,
matching the estate's policy. Whether this repository, which has none of
the flake history that drove that policy, should get a schedule is the
owner's call.

## Why the pins point opposite ways

`rclone-manager` pins this repository, and this repository pins a
`rclone-manager` build. That asymmetry is deliberate:

- pinning the tests repository means a new or changed test cannot break
  unrelated in-flight work in the product until someone bumps the pin,
  and the bump is itself gated;
- pinning the product build means a release cannot silently change what
  these suites certify.

Each bump is one line, in one file, reviewable on its own.
