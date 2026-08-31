# Suite B: the Web UI Playwright suite

Migrated out of `rclone-manager`'s `ui/shared/e2e/`, behaviour-preserving.

```sh
cd suites/web-ui && npm ci && npx playwright install chromium   # once
RM_UI_DIR=/path/to/rclone-manager/ui/shared npm run e2e         # 165 tests
```

Or from the repository root, `make suite-b`.

All 165 pass against `rclone-manager` `main`. This paragraph used to say
one of them was red at the pin, which stopped being true the moment
`612b48c` landed the fix and the pin moved onto it; "The one red there
used to be" below has that whole story and is written in the past tense
for the same reason.

## The byte-identity invariant, and when it ended

Read the next two sections as history. They describe a round trip that
existed while `e2e/` had an upstream twin, and it does not any more:
`rclone-manager` #217 (`0ec5f45`) deleted `ui/shared/e2e/` in the same
change that made this suite that repository's blocking gate step, so this
directory has been the only home the browser suite has since the day it
arrived. `diff -r` against `ui/shared/e2e/` no longer has anything to
compare against.

That matters because it moves where a spec edit belongs. While the twin
existed, an edit went upstream and this copy took it whole, and editing
here would have spent the migration's proof. Now there is nothing to
re-sync from, so a spec that has drifted from the UI is corrected here,
and the pin in `rclone-manager`'s `scripts/e2e/tests-repo.pin` is what
moves the correction into that repository's gate.

`fix/223-resync-web-ui-specs` is the first change to use that route, and
it is worth naming what it did NOT do. `rclone-manager` #214 removed nine
fields the shared UI was rendering that nothing in the running system
computes, and six specs here still asked for them. They were updated to
assert what the UI ships instead, never emptied: each one that lost a
field either asserts the honest replacement in its place or carries a
comment saying, in as many words, that the field is gone with no
replacement. Issue #6 has the reasoning per spec.

### The build pin still points before that commit

`build-under-test.json` names `612b48c`, which predates #214, so these
six specs would be red against a Suite B run resolved from the build pin
rather than from `RM_UI_DIR`. That is stated rather than hidden, and it
is bounded: nothing automated resolves Suite B from that pin.
`rclone-manager`'s gate step and its `nightly-e2e.yml` both set
`RM_UI_DIR` to a product checkout, this repository's own `suites.yml`
runs only the Go targets, and a standalone `make suite-b` with no
`RM_UI_DIR` refuses to start until someone installs dependencies inside
the cached checkout anyway.

Moving the build pin is issue #7 and not this change, because the bump
makes Suite C red on purpose: #214 closed six of the gap rows
`suites/equivalence/MATRIX.md` records as blocked, and
`specs/contract-gaps.spec.ts` is the strict expected-failure guard that
goes red the moment a gap closes so the matrix cannot quietly outgrow
its own rows. That is a matrix rewrite, and folding it in here would
make both halves harder to read.

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
   commit. That commit is `137f646`, the baseline, and the claim is about
   the two homes agreeing rather than about the number being permanent:
   at the pin's current commit both homes now say 164, together, for the
   reason set out below. Agreeing is the property that was being bought.

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

## The one red there used to be, and how it was closed

At `rclone-manager` `defa0a6` this suite was **164 passed, 1 failed**:

```
[generic] e2e/accessibility.spec.ts:65 accessibility > tab order reaches the section navigation
Error: Section navigation was not reachable within 12 tab stops
```

It was deterministic (three consecutive runs) and none of it belonged to
the migration. Four things established that at the time:

1. the same spec passed against `ui/shared` at `137f646`, the migration
   baseline, so the suite had not changed: the app had;
2. the same spec failed **in its old home**, run from
   `rclone-manager/ui/shared` with that repository's own
   `playwright.config.ts`, at `defa0a6`. That was `rclone-manager` main
   being red on its own e2e suite, and the move neither caused it nor
   hid it;
3. the accessibility property itself was intact. Wait for the shell and
   the section nav is **three** tab stops away, not more than twelve;
4. `e2e/` was still byte-identical to `ui/shared/e2e/`, `diff -r` and all.

The cause was a race the spec always had and had started always losing.
Line 65 did a bare `page.goto("/")` and started pressing Tab immediately,
with nothing waited on, while every neighbouring test goes through
`bm.goto()`, which waits for the section nav to render (the comment below
it says so, in as many words, about the test right underneath).
[#195](https://github.com/spdrman/rclone-manager/pull/195) then put an
extra round trip in front of the shell: `App.tsx` asks
`getFirstRunStatus()` before it can know which mode the instance is in,
and renders a `<Splash />` until the answer arrives. All twelve Tab
presses landed on that splash.

The fix belonged upstream, because `e2e/` is byte-identical to
`ui/shared/e2e/` by construction and editing it here would have spent the
migration's proof to close a product bug. It landed as `rclone-manager`
`612b48c`, the file was copied back rather than retyped, `diff -r` against
`ui/shared/e2e/` at that commit prints nothing, and this suite is
**165 passed** at the pin.

That round trip was the re-sync procedure, and it was the whole point of
insisting on byte-identity: a change to a spec went to the product
repository, and this copy took it whole. It is closed now, for the reason
at the top of this file: the tree it round-tripped through no longer
exists, so a spec fix is made here and reaches `rclone-manager` through
its pin instead.

## Type checking, and the one thing it does not check

`npm run typecheck` is `tsc --noEmit` over `e2e/`, `harness/`, `scripts/`
and both configs, and the gate runs it. It went in because Playwright
transpiles types away without checking them, so until it did, nothing in
this repository read the types in this suite at all.

`noUnusedLocals` and `noUnusedParameters` are off, and real ESLint is
absent, for one reason: both of them have exactly one finding on this
tree, and it is inside `e2e/`.

```
e2e/shell.spec.ts(20,77): 'page' is declared but its value is never read
```

That is an unused Playwright fixture in a destructured parameter list,
and it is a real (small) finding. But `e2e/` being byte-identical to
`ui/shared/e2e/` is this suite's whole migration argument, so editing it
to satisfy a check added here would trade a strong property for a weak
one. The alternative, configuring the check to ignore its own only
finding, is worse: a check that has been told not to look at the one
thing it can see is coverage in appearance only, which is the shape this
whole repository exists to argue against.

So it goes upstream, and it turns out it has to. Nothing catches that
binding in its old home either: `ui/shared`'s ESLint config switches
`@typescript-eslint/no-unused-vars` off on the stated grounds that "TS's
own noUnused* compiler options already cover this project-wide", and
`ui/shared/tsconfig.json` has both options on, but its `include` is
`["src"]`, so `tsc --noEmit` there has never read `e2e/` at all. The
rule was turned off in favour of a check that does not reach these files.
That is a gap in `rclone-manager`'s gate rather than something the
migration introduced, and it is why the finding survived the move.

The order that fixed it for both homes used to be: correct
`ui/shared/e2e/shell.spec.ts` upstream, give that tsconfig (or a second
one) the `e2e` directory so the claim its ESLint config makes becomes
true, re-sync the byte-identical copy here, and then turn both options on
in this suite with nothing left to suppress.

Half of that is moot now. There is no upstream copy to correct, so the
binding is this repository's to fix and the two options are this
repository's to turn on, in a change that does only that. It is left
alone here on purpose: this branch is a spec re-sync, and folding a
compiler-option change into it would make the re-sync harder to read.
The gap it names in `rclone-manager`'s own gate (its `tsconfig.json`
`include` is `["src"]`, so `tsc --noEmit` there never read `e2e/`) is
unchanged and still worth closing on the parts of `ui/shared` that do
still exist.

## Files

```
e2e/                     the browser specs; byte-identical to ui/shared/e2e/
                         until #217 deleted that directory (see the top of
                         this file), maintained here since
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
