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

# Suite B's own unit tests, which need no browser: the port helper's
# E2E_PORT validation and the seven-provider spawner's argv. Suites B and C
# themselves are not in this gate, because they need a Chromium and this
# repository is cloned onto machines that have none; rclone-manager's gate
# runs Suite B on every commit, which is where the browser signal belongs.
#
# Refused rather than skipped when the dependencies are missing. A gate that
# prints a skip and carries on is the shape rclone-manager's #160 was about,
# and importing it here would be a strange thing to do in the repository
# whose whole argument is that a check nobody notices stopping is worse than
# no check.
if [ ! -d suites/web-ui/node_modules ]; then
  echo "suites/web-ui has no installed dependencies, so its unit tests cannot run." >&2
  echo "  fix: cd suites/web-ui && npm ci" >&2
  exit 1
fi
echo "==> Suite B unit tests"
(cd suites/web-ui && npm run --silent unit)

echo "gate: green"
