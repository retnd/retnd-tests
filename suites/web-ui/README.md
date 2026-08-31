# Suite B: the Web UI Playwright suite

Migrated out of `rclone-manager`'s `ui/shared/e2e/`, behaviour-preserving.

```sh
cd suites/web-ui && npm ci && npx playwright install chromium   # once
RM_UI_DIR=/path/to/rclone-manager/ui/shared npm run e2e         # 165 tests
```

Or from the repository root, `make suite-b`.

## What "behaviour-preserving" was made to mean

Not an intention. Three checkable facts, all recorded in the migration
pull request:

1. **`e2e/` is byte-identical** to `rclone-manager`'s `ui/shared/e2e/` at
   the baseline commit. `diff -r` between the two directories prints
   nothing. Every spec, `fixtures.ts`, the port helper, its unit test, and
   the suite's own README moved without an edit, including the parts of
   that README that describe the old home. Nothing inside a spec was
   touched in the same change that moved it, because a migration that
   edits and moves at once cannot be shown to be faithful.
2. **The test list is identical**, modulo the one startup line this
   harness prints about which tree it is testing. `playwright test --list
   --project=generic --project=small-window` reports **165 tests in 13
   files** in both homes, and the 165 lines match one for one.
3. **The pass count is identical**: 165 passed in the old home, 165 passed
   in the new one, three consecutive times, at the same `rclone-manager`
   commit.

That third number is worth stating carefully, because a remembered one was
wrong. The count quoted in the issue was 174, an earlier one 158, and a
static count of `test(` call sites disagreed with both. 174 counts the
`providers` project's loop-generated re-runs of the provider spec, which
`npm run e2e` does not run. The baseline for this migration is what
`--list` says for the two projects `npm run e2e` actually runs, and that
is 165.

## The permitted deltas, exhaustively

All of them are in `playwright.config.ts` and `harness/`, and all of them
are about **where the app comes from**, never about what is asserted:

| Delta | Why |
|---|---|
| the app under test is resolved from `RM_UI_DIR`, then `RM_SOURCE_DIR/ui/shared`, then the pin's own checkout | in the old home it was implicitly "the directory this config sits in", which out here would be this repository, which has no app in it |
| the derived port is derived from the checkout the **app** is in | out here the config and the app live in two different repositories, and only the app's checkout varies per concurrent run |
| the port is additionally probed free before Vite is asked for it, **once**, in the runner, and read back by the workers | one tests-repo checkout can be pointed at many product checkouts, so the collision odds went up rather than down. The scan runs once because Playwright re-evaluates this config in every worker, and by then the runner's Vite holds the runner's answer, so a worker that scans again walks to the next slot and points `baseURL` at nothing. `harness/under-test.test.ts` occupies the port and requires the two to agree, with a no-handoff resolver over the same occupied port as the control that the scan really does move on |
| `webServer.cwd` is the app under test | `npm run dev` has to run where the app is |
| reporter and `outputDir` are local to this suite | nothing else to say about this one |

Deliberately **not** a delta: `reuseExistingServer` is still an
unconditional `false`, `--strictPort` is still passed, and there is no
environment variable that opens either. A run here never adopts a server
it did not start. That property was bought expensively (`rclone-manager`
#172: a stale dev server from another worktree answered a run on a shared
port, a control reported green against a different commit, and the real
failure was dismissed twice as an ordering flake) and the move out here
makes the hazard bigger, not smaller.

## What this suite does and does not prove

It drives **the mock API**. `ui/shared/src/app/createApp.tsx` wires
`createMockApi(scenarioFromLocation())` under `import.meta.env.DEV`, and
this config runs the dev server, so every `?scenario=` state the specs
drive is a fixture inside the browser rather than a backend.

That is not a defect of the migration, it is what the suite has always
been, and it is worth saying out loud in its new home because the move
makes it easy to assume otherwise. What it proves is product behaviour in
the browser: information architecture, accessibility, safety invariants,
capability honesty per provider, and the states an operator can reach.

What it does not prove is that any of that reaches a real backend. That
claim belongs to Suite C, which drives the real built app against a real
engine and compares resulting backend state. Two of the scenarios here
(`storage-critical`, `version-mismatch`) are unreachable against a real
backend by design, so "run this same suite against the real app" is not a
behaviour-preserving step and is not attempted as one.

## The app under test

Resolved once, printed at startup, and the run refuses to start if it
cannot be resolved:

| Source | When |
|---|---|
| `RM_UI_DIR` | `rclone-manager`'s own gate sets it, so the app under test is the working tree being committed |
| `RM_SOURCE_DIR/ui/shared` | the same variable Suite A already uses to name a checkout |
| the pinned build's checkout | a standalone run, which also gets Suite A's identity handshake on the way, since `tools/getbuild` resolves it |

A resolved directory with no `node_modules/` stops the run and names the
`npm ci` that fixes it, rather than letting `npm run dev` fail sixty
seconds later inside a webServer timeout.

## Files

```
e2e/                     byte-identical to ui/shared/e2e/ at the baseline commit
harness/under-test.ts    which app, which port, resolved out loud
harness/under-test.test.ts  the port is the same number in every process of one run
harness/pick-free-port.mjs
playwright.config.ts     the deltas above, and nothing else
scripts/e2e-all-providers.mjs
scripts/e2e-all-providers.test.ts
vitest.config.ts         runs the two unit tests ui/shared's vitest used to
```

Two of the three `.test.ts` files came with the code they test:
`e2e/port.test.ts` pins the port helper's `E2E_PORT` validation, and
`scripts/e2e-all-providers.test.ts` reads back what the seven-provider
spawner hands each run, including the negative assertion that it no longer
forces `CI=1` (which used to buy a retry, and a retry is what turned
rclone-manager #172's deterministic red into something that read as a
flake). The third, `harness/under-test.test.ts`, is new here, because the
per-process port resolution is new here. `npm run unit` runs all three,
and all three are in this repository's gate and in rclone-manager's.
