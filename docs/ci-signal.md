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

None of this is implemented yet, and deliberately so: `scripts/ci-local.sh`
is owned by another in-flight change (#160), and two agents editing one
gate script at once is how a gate ends up broken for everybody. This
section is the specification for whoever adds it.

1. **`scripts/e2e/tests-repo.pin`** holds this repository's URL and a full
   commit sha. `scripts/e2e/bump-tests-pin.sh [ref]` moves it, and the
   commit that moves it is itself gated against the new pin, so a bad
   change here cannot land in the pin unnoticed.

2. **A new non-FAST step in `ci-local.sh`**, so `CI_LOCAL_FAST=1` skips it
   and the existing never-merge-on-FAST rule already covers that. The step:

   - clones or fetches `rclone-manager-tests` into
     `${XDG_CACHE_HOME:-$HOME/.cache}/rclone-manager-tests-gate` and checks
     out the pinned sha detached;
   - runs the **Suite A smoke slice** against the working tree's own build:

     ```sh
     go build -ldflags "-X main.version=$(git rev-parse --short HEAD) -X main.commit=$(git rev-parse HEAD)" \
       -o "$tmp/backup-manager" ./core/cmd/backup-manager
     RM_MODE=local RM_BINARY="$tmp/backup-manager" RM_SOURCE_DIR="$PWD" \
       make -C "$gate_checkout" smoke
     ```

     The `-ldflags` are load-bearing: without them the binary reports
     `commit none` and the identity handshake refuses the run, which is
     the handshake doing its job rather than a problem to work around.

   - once Suite B is migrated, runs it too, with `RM_UI_DIR` pointing at
     the working tree's `ui/shared`, so the app under test is the commit
     being made rather than the pinned release.

3. **Who triggers it, against which build, and how red blocks.** The
   pre-commit hook triggers it on every commit. The build under test is
   the working tree itself. A red suite exits nonzero, `ci-local.sh` is
   `set -e`, so the commit is refused, and the merge policy (full non-FAST
   green before an admin merge) makes it merge-blocking.
   `git commit --no-verify` stays the documented WIP escape hatch it
   already is.

4. **`nightly-e2e.yml`** is rewritten to check this repository out at the
   pin and run the full Suite B including the seven-provider re-run, still
   `workflow_dispatch`-only per the estate's Actions-off policy. The
   schedule stays commented unless the owner turns it on.

The Suite A smoke slice is worth calling out separately: it is a signal
`rclone-manager` has never had. Today nothing exercises the CLI
black-box on a per-commit basis at all. The smoke slice runs the real
binary against real fixtures on local remotes, needs no Docker and no
browser, and takes a couple of seconds.

## What goes into this repository

The mirror of the same pattern: `.husky/pre-commit` runs
`scripts/gate-local.sh`, which runs `go vet`, the tool and fixture unit
tests, the harness self-tests, and Suite A in full against the pinned
build. `make gate` is the single documented command.

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
