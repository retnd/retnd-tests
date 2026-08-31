# Suite B: the Web UI Playwright suite

Not migrated yet. This directory holds the plan and the preconditions,
not a half-moved suite.

## Why it has not moved

The migration has one property it has to have, and only one: it must be
behaviour-preserving. The way that is demonstrated is by the suite
passing at the same count in its new home as in its old one, at the same
`rclone-manager` commit. Both halves of that are currently unavailable:

1. **The suite is red on `main`.** PR
   [#181](https://github.com/spdrman/rclone-manager/pull/181) fixes a spec
   that [#164](https://github.com/spdrman/rclone-manager/issues/164) broke,
   and it is still an open draft. A migration measured against a red
   baseline proves nothing, because "it fails the same way afterwards" is
   not a claim anybody wants.
2. **The baseline count is not known.** The most recent measurement says
   174, an earlier one says 158, and a static count of `test(` call sites
   disagrees with both because some tests are loop-generated. Only
   `npx playwright test --list` at the chosen baseline commit settles it,
   and the migration has to carry that number rather than a remembered
   one.

Moving it now would mean the one property that makes the move safe could
not be checked. So the foundation and Suite A landed first, which is what
the rest of this repository is.

## The plan, in order

1. **Baseline capture** in `rclone-manager` at the chosen commit: record
   `npx playwright test --list` output verbatim, and the pass count from
   three consecutive full runs of `npm run e2e` across the `generic` and
   `small-window` projects.
2. **Copy verbatim** into `suites/web-ui/`: `e2e/**` (every spec plus
   `fixtures.ts` and its README), `playwright.config.ts`, a `package.json`
   trimmed to the Playwright bits with the identical `@playwright/test`
   pin, and a lockfile resolving to the same version.
3. **Permitted harness deltas, exhaustively:** the `baseURL` and
   `webServer` block are replaced by harness-managed server startup on an
   ephemeral port the harness picked and proved free; `reuseExistingServer`
   is gone, in every form, not conditionally kept; reporter and output
   paths change. **Zero changes inside `e2e/*.spec.ts` or `fixtures.ts`**,
   proved by a `diff -r` against the baseline commit's `ui/shared/e2e/`
   pasted into the migration PR.
4. **The app under test** comes from `RM_UI_DIR` pointing at a checkout's
   `ui/shared`, or from the pin's own checkout in a standalone run.
5. **Faithfulness proof** in the PR: identical `--list` output modulo path
   prefix, equal pass counts, three consecutive green runs.
6. **The removal PR in `rclone-manager` is one PR**, carrying the deletion
   of `ui/shared/e2e/`, the `playwright.config.ts` and `e2e*` scripts, the
   tests-repo pin file, the `ci-local.sh` gate step, the `nightly-e2e.yml`
   rewrite, and the documentation in both repositories. The old home and
   its replacement signal swap in one merge, so there is no window in
   which a UI regression can land unseen. See `docs/ci-signal.md`.
7. **Only then, convergence** onto the shared fixture layer, and a
   `real-backend` project that boots the container image against fixture
   work directories, moving specs onto it one at a time and only where the
   asserted state is reachable on a real backend.

## One thing to be honest about up front

The suite as it stands does not test the backend. `ui/shared/src/app/createApp.tsx`
wires `createMockApi(scenarioFromLocation())` only when
`import.meta.env.DEV` is true, so every `?scenario=` state the specs drive
(`storage-critical`, `version-mismatch`, and the rest) exists only against
`npm run dev`. "Migrate the suite" therefore means migrating a mock-backed
dev-server suite, and "run it against the real built app" is a separate,
later step that cannot be behaviour-preserving for every spec, because
some of those scenarios are unreachable on a real backend by design.

Both are worth doing. Pretending they are one step is what would make the
result untrustworthy, so the plan keeps them apart and the README will say
which project proves what.
