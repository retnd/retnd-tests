# Suite B: the Web UI, against a real deployment

This suite used to drive a Vite dev server. It drives a running
`rclone-manager` now: a browser in one container, `rbm-web serve-ui` and
`rbm-web serve` in another, a real sshd holding real backup files in a
third, and SQLite behind all of it.

```sh
cd suites/web-ui && npm ci && npx playwright install chromium   # once
RM_BASE_URL=http://rclone-manager:8080 \
RM_ADMIN_USERNAME=e2e-operator \
RM_ADMIN_PASSWORD=... \
  npm run e2e
```

The rig itself lives in the product repository, under `scripts/e2e/`, and
brings the containers up before this runner starts. Nothing in this
directory starts anything. From a product checkout:

```sh
scripts/e2e/three-machine-web-ui.sh --suite ../rclone-manager-tests/suites/web-ui
```

Against the rig as it stands (one backup set, three ingested artifacts, a
healthy deployment with nothing declared), that is **191 passed, 69
skipped, 8 expected failures**, green, in about ten minutes. The eight
expected failures are all `findings/DISC-010.md`, and the run ends by
printing every skipped case with the reason it declined.

## Why it moved

The old arrangement ran `npm run dev` against a `ui/shared` checkout, and
`ui/shared/src/app/createApp.tsx` wires `createMockApi` under
`import.meta.env.DEV`. So the app under test answered its own questions:
every `?scenario=` state a spec drove was a fixture inside the browser,
and no test in this repository could fail on anything below it. Not the
session, not the reverse proxy, not the engine, not the database.

That gap cost something specific. `rclone-manager` #598 was the Activity
page erroring in a browser while the server answered HTTP 200 with 64KB
of valid JSON in 20ms. `activity-failure.spec.ts` has a case beside it
called "activity, when the feed reads fine, still lists the recorded
events", and it passed the whole time, because the mock resolved
`listActivity` cleanly every time it was asked.

The old README argued this was fine and that proving the real path was
"Suite C's job". That argument is retired: the browser is where an
operator meets this product, and a browser suite that cannot see the
service is a suite that reports on a drawing of it.

## The environment it reads

Four variables are required and have no defaults. A base URL that
silently fell back to `localhost` is the same defect the old
`reuseExistingServer: true` was, so the run stops and names the variable
instead.

| variable | what it is |
|---|---|
| `RM_BASE_URL` | where the Web UI answers on the private network, e.g. `http://rclone-manager:8080`. A container name, resolved by Docker's embedded DNS, not a published host port |
| `RM_ADMIN_USERNAME` | the throwaway administrator this run signs in as |
| `RM_ADMIN_PASSWORD` | its password. Held in this process's environment and written nowhere: no file, no argv, no report |
| `RM_ARTIFACTS_DIR` | where the evidence goes. Traces, screenshots and videos land in `<dir>/test-results` and the HTML report in `<dir>/html-report`, both a level below the directory itself: Playwright removes its own output directory on startup and a bind mount cannot be unlinked from inside the container |

And the optional ones, each of which unlocks cases that otherwise state
why they are skipped:

| variable | what it unlocks |
|---|---|
| `RM_BACKUP_SET` | the set the topology seeded, in `source/set` form (`e2e/vps`). It is the anchor `real-path.spec.ts` uses: a name this suite did not choose and the bundle cannot invent |
| `RM_BOOTSTRAP_TOKEN` | the single-use enrolment token, for a deployment that has no administrator yet. Without it the run needs one already enrolled |
| `RM_VPS_HOST`, `RM_VPS_PORT`, `RM_VPS_USER`, `RM_VPS_PATH` | the source machine, for the wizard cases that probe a real host and prove a real connection |
| `RM_PLATFORM` | which provider bundle the image serves. It DESCRIBES the image; it does not choose one |
| `RM_ALLOW_DESTRUCTIVE=1` | the cases that destroy data nothing puts back: applying a retention plan, and removing a declared storage destination |
| `RM_WORKERS` | more than one browser at a time. Read the note in `harness/deployment.ts` before setting it |
| `RM_NO_SANDBOX=1` | `--no-sandbox`, for an image that runs Chromium as root |

## Signing in, for real

`e2e/fixtures.ts` used to intercept `**/api/v1/auth/session` and answer
`{"username":"e2e-admin"}`. Nothing authenticated and nothing could be
refused. It now does what the client does (`harness/session.ts`):

1. GET any page. `apps/common/csrf`'s `EnsureCookie` runs in front of
   every response precisely so a fresh client has a token before it needs
   one, and sets `bm_csrf`.
2. POST `/api/v1/auth/login` carrying that cookie and its value again in
   `X-CSRF-Token`. The cookie is what a cross-site attacker can make a
   browser send; the header is what it cannot read to construct.
3. A 204, and a `bm_session` cookie the browser then carries.

A deployment with no administrator is enrolled instead, through
`/api/v1/auth/enroll` with the single-use `X-Bootstrap-Token`, when the
run was handed one.

Two properties are worth knowing about:

- **Once per worker.** `apps/common/auth/local` allows ten login attempts
  a minute per client address. A per-test login across 260 cases would
  trip that and report a product failure that was really a fixture
  failure. So the session is a worker fixture, checked before each test
  with the un-rate-limited `GET /auth/session`, and re-established only
  after something spends it.
- **Nothing reaches disk.** There is no `storageState` file: the cookies
  come back as an in-memory object and go straight into a browser
  context. No failure path in `harness/session.ts` quotes a response
  body either, because a refusal from these two routes can echo what was
  submitted.

A spec that wants the signed-out UI says `test.use({ signedIn: false })`
and gets a context with no session at all, which is both the honest thing
and free. `bm.signOut()` is kept for the one case that is about signing
out: it really revokes the session server-side, which is why it tells the
store.

## The trap, and what it did to the specs

The mock returned fixed, complete data on every call: a dozen backups, a
stale set, a set halted on a changed host key, an operation mid-transfer,
a five-row quarantine queue, two declared storage mediums. A real
deployment starts empty and gains each of those only when something
actually happens.

So a case asserting on rows now does one of four things, and says which:

| | what it means | where it shows up |
|---|---|---|
| runs | the claim never depended on which data was behind it | most of the suite |
| `needs(...)` | the deployment is not in the state this case is about, and the reason is read off the API rather than off a flag | the run prints `needs a backup set halted on a changed host key`, and so on |
| `mockOnly(...)` | the case's SUBJECT is a state only `createMockApi` could manufacture | three cases, all in the version-mismatch block |
| `destructive()` | it destroys something nothing puts back | two cases |

Nothing was deleted to reach green. A case that quietly disappears is
indistinguishable from one nobody wrote; a case that says "skipped,
because this deployment has no quarantined backups" is a line somebody
can act on, and it turns back on by itself the moment the topology
arranges that state.

`harness/skips-reporter.ts` is what makes that true rather than
aspirational. Playwright's list reporter prints a bare `-` for a skip and
leaves the reason in an annotation only the HTML and JSON reporters
render, so the run ends with a grouped summary of every declined case and
why, deduplicated by reason: eleven cases wanting a quarantined backup is
one thing for the topology to arrange, not eleven.

Several assertions got sharper rather than softer, because a real service
can disagree with a page in a way a mock cannot:

- the dashboard's backup-set count is compared against `GET
  /system/health` in the same run;
- the last-cycle panel's two numbers are compared against `GET
  /operations`;
- a retention policy saved through the form is read back through `GET
  /settings`;
- a reinstatement is required to have changed the quarantine queue, not
  merely to have drawn a cheerful notice;
- the System information card's service version is compared against the
  binary that answered the request.

And three cases inverted. `?scenario=empty`, `?scenario=no-medium` and an
empty quarantine queue were all fixtures the mock had to manufacture, and
all three are a real deployment's ordinary state.

## Arranging state through the API

`harness/api.ts` is where a spec goes to put the deployment in a state,
and the browser is kept for the thing under test. Driving the UI to reach
a precondition makes every spec depend on the flow it is not testing.

The storage-critical case is the one worth reading. It was
`?scenario=storage-critical`, a fixture that could never have been real.
It is now a capacity threshold written through `PATCH /settings` above
what the disk actually has free, a `CRITICAL` verdict the service really
computes from it, an escalated headline in the browser, and a restore in
a `finally` so the next spec reads the deployment this one found.
Everything that writes here knows how to put back what it changed.

## Running it

```sh
npm run e2e          # generic, small-window and provider projects
npm run e2e:list     # the test list, with no deployment
npm run unit         # the harness's own unit tests
npm run typecheck
```

`npm run e2e:list` passes a deliberately unreachable base URL of its own,
so listing the suite never needs a deployment and never quietly points at
one.

## What running it for the first time found

Worth recording, because it is the answer to "was this worth doing".

The first run against the rig was 173 passed, 24 failed. Every one of the
24 was a real finding about something, and they sorted into three kinds.

**A product bug nothing could have caught.** Clicking a backup lands an
operator on the Dashboard. An artifact id is three slash-separated
segments (`e2e/vps/notes.txt`) and `BackupsPage` navigates with
`"/backups/" + a.id` against a route declared as one segment, so the URL
matches nothing and App.tsx's catch-all takes it. The detail page, the
lifecycle timeline and the whole Copies card are unreachable in a browser
on any real deployment. The mock's ids were `art_01J9C1XY7T09`, one
segment, so the route matched and five cases asserted their way through a
page nobody could open. `findings/DISC-010.md`, and App.tsx fixed this
exact defect on the neighbouring backup-set route in #285.

**Two cases that had learned something untrue from the fixture.** The
storage-critical case asserted that a full disk escalates the headline;
§8 says the headline is the BACKUP verdict and storage is a chip beside
it, and `HealthSummary` does exactly that. The mock escalated it. And the
nav badge beside "Backups" counts backup SETS, not backups (#211), so it
reads 1 beside a page listing 3, which the mock's fixture hid by having
the two numbers agree.

**The rest, which were mine, and all of one shape:** copy, counts and
locators pinned to what the fixture happened to render. The engine's
retention verdict is a paragraph where the mock's was a phrase; a badge is
omitted at zero rather than showing one; the product name is on the page
twice; the terminal truthfully logs a refused host-key probe naming the
wizard's example host, which an unscoped negative read as the review step
showing it.

None of them was reachable from the mock, and none of them is exotic.

## What this suite still does not prove

- **The other six providers.** The bundle is chosen when the image is
  built (`VITE_PLATFORM`, and `serve-ui --profile`), so a deployment is
  one provider. `scripts/e2e-all-providers.mjs` re-ran the provider spec
  seven times by restarting Vite with a different value; nothing here can
  do that, and the sweep is not pretended at. `RM_PLATFORM` says which
  one this image is, and the expectations table in
  `provider-treatment.spec.ts` is kept whole so a second image is the
  only thing a second provider needs.
- **A service speaking a different `/api/v1` contract.** Version mismatch
  needs two builds that genuinely disagree. Three cases are marked
  `mockOnly` for it, each naming what it would take.
- **The three local test-connection failure modes.** A missing path, an
  unwritable directory and a full filesystem are told apart by which step
  failed, and arranging each one means arranging a filesystem.
  `suites/cli/cases/medium/test-connection-local-*` drives the real
  binary against a real directory for each.

## Files

```
e2e/                      the browser specs
e2e/fixtures.ts           real sign-in, deployment facts, and the three ways
                          a case can decline to assert
e2e/real-path.spec.ts     the claim the move exists to make, in one file
harness/deployment.ts     which deployment, read out of the environment
harness/session.ts        the CSRF and login handshake
harness/api.ts            reading the deployment, and arranging it
```

`harness/under-test.ts`, `harness/pick-free-port.mjs`, `e2e/port.ts` and
`scripts/e2e-all-providers.mjs` are gone. All four existed to start and
find a dev server, and there is no dev server. Their unit tests went with
them and were replaced by `harness/deployment.test.ts` and
`harness/session.test.ts`, which pin the same kind of thing one layer up:
what a run reads out of its environment, and what it refuses.
