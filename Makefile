# Entry points for the three suites. Every target that runs Go tests
# passes -count=1: the binary under test, the fixtures' replay output and
# the rclone-manager checkout all live outside this module, and Go's test
# cache cannot see any of them change.

GO ?= go

.PHONY: help
help:
	@echo "make gate        the Go half of the local gate (no Node needed)"
	@echo "                 scripts/gate-local.sh is the one the pre-commit hook runs,"
	@echo "                 and it adds the two type checks and Suite B's unit tests"
	@echo "make suite-a     the CLI contract suite (no browser, no Docker)"
	@echo "make smoke       the fast slice of Suite A, for rclone-manager's own per-commit gate"
	@echo "make selftest    prove the harness can fail, per assertion dimension"
	@echo "make tools       unit tests for the fixture layer and the state differ"
	@echo "make typecheck   tsc --noEmit over the TypeScript in Suites B, C and D"
	@echo "make build       resolve the pinned build under test and run the identity handshake"
	@echo "make suite-b     the Web UI Playwright suite (needs a browser; see suites/web-ui)"
	@echo "make suite-c     the UI-to-CLI equivalence suite (needs a browser; see suites/equivalence)"
	@echo "make suite-d     the live-deployment suite (needs a browser AND Docker; see suites/live-deployment)"

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

# tsc --noEmit over all three TypeScript suites. Playwright transpiles
# types away without checking them, so without this nothing in the
# repository ever reads them.
.PHONY: typecheck
typecheck:
	cd suites/web-ui && npm run --silent typecheck
	cd suites/equivalence && npm run --silent typecheck
	cd suites/live-deployment && npm run --silent typecheck

.PHONY: gate
gate: vet tools selftest suite-a
	@echo "gate: green"

# RM_UI_DIR names the ui/shared whose dev server the browser drives. Left
# unset, the suite resolves the pinned build's own checkout, which also runs
# the identity handshake on the way.
.PHONY: suite-b
suite-b:
	cd suites/web-ui && npm run e2e

.PHONY: suite-b-list
suite-b-list:
	cd suites/web-ui && npm run e2e:list

.PHONY: suite-b-install
suite-b-install:
	cd suites/web-ui && npm ci && npx playwright install chromium

.PHONY: suite-b-unit
suite-b-unit:
	cd suites/web-ui && npm run unit

# Boots the real engine and the real production UI bundle per spec, so
# RM_UI_DIR (or the pin's own checkout) must have its dependencies
# installed: the bundle is built from it.
.PHONY: suite-c
suite-c:
	cd suites/equivalence && npm test

.PHONY: suite-c-install
suite-c-install:
	cd suites/equivalence && npm ci && npx playwright install chromium

# Deploys the image under test in containers, with a real SFTP source
# behind it, and drives a browser between them. Needs Docker as well as a
# browser, and builds the image from the pinned checkout on first use,
# which is minutes on a cold Docker cache and nothing afterwards.
.PHONY: suite-d
suite-d:
	cd suites/live-deployment && npm test

.PHONY: suite-d-list
suite-d-list:
	cd suites/live-deployment && npm run list

.PHONY: suite-d-install
suite-d-install:
	cd suites/live-deployment && npm ci && npx playwright install chromium

.PHONY: suite-d-unit
suite-d-unit:
	cd suites/live-deployment && npm run unit
