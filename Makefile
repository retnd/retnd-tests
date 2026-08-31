# Entry points for the three suites. Every target that runs Go tests
# passes -count=1: the binary under test, the fixtures' replay output and
# the rclone-manager checkout all live outside this module, and Go's test
# cache cannot see any of them change.

GO ?= go

.PHONY: help
help:
	@echo "make gate        the full local gate: everything that must be green before a commit"
	@echo "make suite-a     the CLI contract suite (no browser, no Docker)"
	@echo "make smoke       the fast slice of Suite A, for rclone-manager's own per-commit gate"
	@echo "make selftest    prove the harness can fail, per assertion dimension"
	@echo "make tools       unit tests for the fixture layer and the state differ"
	@echo "make build       resolve the pinned build under test and run the identity handshake"
	@echo "make suite-b     the Web UI Playwright suite (not migrated yet, see suites/web-ui)"
	@echo "make suite-c     the UI-to-CLI equivalence suite (not built yet, see suites/equivalence)"

.PHONY: build
build:
	$(GO) run ./tools/getbuild/cmd/getbuild

.PHONY: suite-a
suite-a:
	$(GO) test ./suites/cli/... -count=1

.PHONY: smoke
smoke:
	RM_TAGS=smoke $(GO) test ./suites/cli -count=1

.PHONY: selftest
selftest:
	$(GO) test ./suites/cli/harness/... -count=1

.PHONY: tools
tools:
	$(GO) test ./tools/... ./fixtures/... -count=1

.PHONY: vet
vet:
	@unformatted=$$(gofmt -l .); \
	if [ -n "$$unformatted" ]; then echo "not gofmt-clean:"; echo "$$unformatted"; exit 1; fi
	$(GO) vet ./...

.PHONY: gate
gate: vet tools selftest suite-a
	@echo "gate: green"

.PHONY: suite-b
suite-b:
	@echo "Suite B has not been migrated yet. See suites/web-ui/README.md for the preconditions." && exit 1

.PHONY: suite-c
suite-c:
	@echo "Suite C has not been built yet. See suites/equivalence/README.md for the preconditions." && exit 1
