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

echo "gate: green"
