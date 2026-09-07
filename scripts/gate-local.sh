#!/usr/bin/env bash
# The local gate for this repository, mirroring how rclone-manager gates
# itself: a pre-commit hook runs this, and a red result refuses the
# commit. See docs/ci-signal.md.
#
# Everything here passes -count=1. The binary under test, the fixtures'
# replay output and the rclone-manager checkout all live outside this Go
# module, and the test cache cannot see any of them change, so a cached
# "ok" would be a statement about a build that is no longer there.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> gofmt"
unformatted=$(gofmt -l .)
if [ -n "$unformatted" ]; then
  echo "these files are not gofmt-clean:" >&2
  echo "$unformatted" >&2
  exit 1
fi

echo "==> go vet"
go vet ./...

echo "==> the build under test"
go run ./tools/getbuild/cmd/getbuild

echo "==> fixture layer and state differ"
go test ./tools/... ./fixtures/... -count=1

echo "==> harness self-tests (prove it can fail)"
go test ./suites/cli/harness/... -count=1

echo "==> Suite A: the CLI contract"
go test ./suites/cli -count=1

# The unit tests that need no browser: Suite B's port helper and
# seven-provider spawner, and Suite D's redaction, log-token and
# commit-comparison helpers. The browser suites themselves are not in this
# gate, because they need a Chromium and this repository is cloned onto
# machines that have none; rclone-manager's gate runs Suite B on every
# commit, which is where the browser signal belongs. Suite D needs Docker on
# top of that, and a per-commit hook is not where a three-container
# deployment belongs either.
#
# Refused rather than skipped when the dependencies are missing. A gate that
# prints a skip and carries on is the shape rclone-manager's #160 was about,
# and importing it here would be a strange thing to do in the repository
# whose whole argument is that a check nobody notices stopping is worse than
# no check.
for suite in suites/web-ui suites/equivalence suites/live-deployment; do
  if [ ! -d "$suite/node_modules" ]; then
    echo "$suite has no installed dependencies, so its unit tests and type check cannot run." >&2
    echo "  fix: cd $suite && npm ci" >&2
    exit 1
  fi
done

# Playwright transpiles types away without checking them, so nothing else
# in this repository ever reads the types in these two suites: a spec that
# passes a string where the harness wants a number transpiles fine and
# fails in the browser, or worse, does not. `tsc --noEmit` is the whole
# check; both tsconfigs were already written for it and both were already
# clean, which is why this is a wiring change rather than a cleanup.
#
# What it does not turn on is noUnusedLocals/noUnusedParameters. That used
# to be because Suite B's e2e/ was byte-identical to rclone-manager's
# ui/shared/e2e/ and editing it here to satisfy a check here would have
# traded the migration's proof for something weaker. That reason expired
# with rclone-manager #217, which deleted the upstream directory, so the
# one unused binding in there (e2e/shell.spec.ts, an unused `page`
# fixture) is now this repository's to fix and these two options are this
# repository's to turn on. Still open, in a change of its own: see
# suites/web-ui/README.md.
echo "==> Suite B, Suite C and Suite D type checks"
(cd suites/web-ui && npm run --silent typecheck)
(cd suites/equivalence && npm run --silent typecheck)
(cd suites/live-deployment && npm run --silent typecheck)

echo "==> Suite B unit tests"
(cd suites/web-ui && npm run --silent unit)

# Suite D's harness unit tests. Small, and the ones worth having: they cover
# the three pure functions that decide whether a run is honest (does the
# image match the pin, is the one-time token found, is it scrubbed out of a
# failure), and a green suite run never takes the branch any of them exists
# for.
echo "==> Suite D harness unit tests"
(cd suites/live-deployment && npm run --silent unit)

echo "gate: green"
