# Suite D: the operator's path against a live deployment

```sh
cd suites/live-deployment && npm ci && npx playwright install chromium   # once
npm test
```

Or from the repository root, `make suite-d`.

The claim is the one no other suite here makes: **the path an operator
actually takes on a new install works, against the deployment we ship,
with a real machine behind it.**

Suite B drives the mock API, on purpose, and says nothing about an engine.
Suite C boots a real engine and a real UI host, but as local processes over
a scratch directory with no source to back up, and it enrols over HTTP
because enrolment is its setup rather than its subject. This one deploys
the image, in containers, with a real SFTP endpoint holding known content,
and drives a browser between them.

## What a run stands up

Three containers on a private network named after the run, and nothing
published except one loopback port:

| Container | What it is |
|---|---|
| `rmlive-<run>-engine` | the image under test, `/backup-manager-web serve`. The API, local authentication and the scheduler. **No published port at all**, exactly as `container/compose.yaml` has it. |
| `rmlive-<run>-ui` | the same image, `/backup-manager-web serve-ui`. The static bundle plus a reverse proxy to the engine. The only thing with a port, bound to `127.0.0.1`. |
| `rmlive-<run>-source` | the machine being backed up: a real chrooted OpenSSH endpoint holding three files of known content. |

Plus three volumes for the manager's state, backups and config directory,
chowned to the uid the containers run as before first start, which is the
step `docs/deployment.md` tells an operator to take with the host paths.

The manager is two containers rather than one because that is what ships.
The browser reaches the engine the way a browser on a NAS does: through
the proxy, over two hops, with the forwarded-header trust boundary between
them. A single-process shortcut would be testing a binary rather than a
deployment.

### The source machine is not this suite's to define

It is built from `scripts/e2e/source-machine.Dockerfile` in the
rclone-manager checkout the pin resolved. That file says in its own header
that it is the one definition of the simulated VPS, and that two copies of
it is exactly the failure it exists to end. The Go machine tier reads it,
`scripts/e2e/two-machine-backup.sh` reads it, and this suite is its third
consumer. There is no Dockerfile for it in this repository and there must
not be.

## Which build

Through `build-under-test.json` and `tools/getbuild`, like every other
suite here, one step further along: the pin resolves the checkout, and
`container/Dockerfile` in that checkout becomes the image, under the same
tag `getbuild`'s own docker builder uses so the two share a cache. The
first run on a machine builds it, which takes minutes on a cold Docker
cache; every run after that finds it.

Then the image is made to state its own identity, from inside itself:
`/backup-manager version` in a throwaway container, compared against what
the pin promised. A mismatch aborts the run before a browser starts.

`RM_IMAGE` names an image directly, for a local build or for the day
`registry` mode in `docs/pinning.md` goes live. It changes where the image
comes from and nothing else: the handshake still runs, and still compares
against the pin unless `RM_COMMIT` says what that image is meant to be.
Naming an image is not evidence about what is in it.

## The enrolment token

The engine prints a one-time enrolment link to its own log on first start,
and that is the only place it exists. It must not reach a file, an argv
where `ps` can see it, or this suite's output, and each of those is closed
somewhere different:

- **a file**: it is read with `docker logs` into a variable, and nothing
  writes it down.
- **an argv**: nothing passes it to a child process. `docker logs` takes a
  container name.
- **the output**: this is the one that needed engineering, because a
  browser suite carries the token in a URL and Playwright puts the URL of a
  failed navigation into the error it raises. Every step that touches the
  token runs inside `redacting` (`harness/secrets.ts`), which scrubs the
  message and the stack before an error is allowed to leave. `trace` is
  `off` for the same reason: a trace records every navigation URL.

The suite's own `enrolmentToken()` failure message deliberately does not
quote the log, because the run where that message is wrong is a run whose
log has a live token in it.

## Never a deployment this run did not start

`suites/web-ui`'s config keeps `reuseExistingServer` an unconditional
false and explains what a stale dev server on a shared port once cost.
Containers make that worse: a leftover answers on its port, reports
healthy, serves a different build, and has no banner to notice it by. So:

- every container, network and volume name carries a per-run id;
- `Run.claimContainer` refuses a name that already exists rather than
  adopting it;
- the one published port is probed free and then bound by a container this
  run starts, so losing that race is a start failure rather than a run
  reporting on somebody else's deployment;
- the image states its own commit before any test runs.

## Teardown

Everything created is registered the moment it exists, and removed when the
test ends however it ends: containers first, then the network they were on,
then the volumes, because neither can be removed while something is
attached. A sweep by the run's own label catches the short-lived helper
containers an interrupt could leave behind, and the teardown then checks
itself and complains if anything with the label is still there.

Three exit paths, not one. The fixture's `finally` covers a passing or
failing test. `process.on("exit")` plus handlers for SIGINT, SIGTERM and
SIGHUP cover the window the fixture cannot see, which is the boot itself:
that is exactly when a half-stood-up deployment is sitting there.

What it does not cover: a `SIGKILL`, and a machine that loses power. Both
leave containers behind, and nothing in a process can promise otherwise.
Find them with the suite's label:

```sh
docker ps -a --filter label=rclone-manager-tests.suite=live-deployment
```

`RM_LIVE_KEEP=1` keeps a FAILED run's containers up for reading, and prints
what to remove. Never the default, for the reason the two-machine script
gives for its own `--keep-on-failure`.

## What it costs

Written down rather than left to be rediscovered, the way
`scripts/e2e/two-machine-backup.sh` writes down its own. On the machine
this was built on, with the image already there: **eight to nine seconds
for the whole run** over three consecutive runs, almost all of it the one
test, and that includes standing all three containers up, waiting for
sshd, seeding a megabyte of content and tearing the lot down again.

The expensive part is the first run on a machine, or the first run after
the pin moves, because that is when `container/Dockerfile` gets built: it
compiles the Go binaries and builds the UI bundle, and it is minutes on a
cold Docker cache. It happens once per commit, in `globalSetup`, outside
any test's own budget.

## No Docker is a failure, not a skip

A machine without a reachable daemon cannot perform this proof, and the run
says so and stops. It does not skip: a skip is invisible in a pass count,
and the pass count is what people read. This repository's whole argument is
that a check nobody notices stopping is worse than no check.

## What the harness hands a spec

One fixture, `deployment`, per test:

```ts
import { enrolAdministrator, expect, openApp, signIn, test } from "../harness/fixtures";

test("...", async ({ page, deployment }) => {
  await enrolAdministrator(page, deployment);   // or signIn, once enrolled
  await openApp(page, deployment);              // and then load the app afresh
  deployment.uiUrl;                             // where the browser goes
  deployment.source.host;                       // "source", on the run's network
  deployment.source.remotePath;                 // "/upload"
  deployment.source.user;                       // "backupuser"
  deployment.source.files;                      // [{ name, bytes, sha256 }, ...]
  await deployment.source.authorizeKey(pub);    // authorise the manager's key
  await deployment.source.hostKey("rsa");       // { line, fingerprint }
  await deployment.source.digest("payload.bin");// re-read, to prove read-only
  await deployment.manager.backupsListing();    // what is on /data/backups
  await deployment.manager.backupDigest(path);  // sha256, read from the volume
  await deployment.manager.configFile("config.yaml");
  await deployment.manager.stateFile("local-auth.json");
  await deployment.manager.restartEngine();
});
```

`openApp` is a full page load, and it is needed rather than tidy: the app
fetches its backup sets, health, operations and quarantine on its first
render, above its own authenticated/unauthenticated branch, so on a browser
with no session yet all four come back 401. Enrolling does not re-run them
and, on an instance with no configuration, neither does the poll, which is
switched off until a deployment is configured. Without the reload the
Backup sets page shows "authentication required" from a fetch that happened
before there was an administrator, and never offers "Add backup set".
`openApp`'s own doc has the detail.

`hostKey` takes an algorithm because the source machine serves two and the
manager does not pick the obvious one: `x/crypto/ssh`'s default client
preference puts ed25519 last, so the engine's probe negotiates `ssh-rsa`
and that is the key it pins. A spec checking what was pinned should read
the algorithm the page reports and ask for that one, rather than assume.

Walking the wizard is `harness/wizard.ts`: a step per wizard step, plus
`createBackupSet` for a spec whose subject is what happens afterwards. It
also mints the ed25519 keypair the wizard imports, in memory, since the
suite deliberately mounts no key.

A deployment per test, so every spec starts from a fresh install, which is
the only state in which enrolment, the first-run banner and an empty
catalogue are real rather than arranged.

`backupDigest` and `backupsListing` read the manager's volume with a
container of their own, read-only. That separation is the point: what the
UI reports and what is on disk are two different claims, and the
two-machine script's lesson is that only the second is evidence. A file
that exists is not a backup.

## What is proved today

| Spec | The claim |
|---|---|
| `enrolment.spec.ts` | an administrator is enrolled through the browser on a fresh deployment, with the tokenless attempt refused before it and the second attempt refused after it, and the resulting record read off the manager's state volume rather than believed from the page |
| `backup-set-wizard.spec.ts` | a backup set is created through the wizard against the source container, and the set that comes out is the set that was typed in (compared against `config.yaml` on the config volume, not against the wizard's own echo); the fingerprint an operator was asked to trust is the source machine's real host key, and the `known_hosts` line the engine pinned holds that same key; a set whose host was never trusted cannot be saved and writes nothing; and a source declared read-only in the wizard reaches the deployment that way, with the same walk minus the declaration as its control |
| `backup-set-edit.spec.ts` | every field the edit surface offers is changed, and each change is verified as having taken effect on the deployment rather than merely accepted by the form |
| `backup-run.spec.ts` | a deployment nobody had configured pulls all three files off the source machine, and each one's sha256 on the manager's backup volume is the digest the source machine itself reported for that name; the source comes out untouched |

`backup-run.spec.ts` also pins a discrepancy, in the shape
`findings/README.md` describes: the case asserts the behaviour that is
actually there, so the suite stays green while it stands and goes red the
moment it is fixed. What it pins is the sets page's run control being
refused by the destructive gate (rclone-manager#92), which is why nothing
here presses it to start a cycle. The cycle these specs are about is the
one the engine starts for itself the moment a configuration is activated.

### Reading a volume must not change it

Worth knowing before adding a read to `Manager`. Docker populates an EMPTY
named volume from whatever the image has at the mount point the first time
something mounts it, and that includes stamping the mount point's own
ownership onto the volume. Read-only does not stop it. So reading a
still-empty volume at `/mnt`, which the tool image has and root owns,
handed the whole backup volume to root, and the engine runs as uid 1000:
every transfer then died on `mkdir /data/backups/<set>: permission denied`,
minutes after the read that caused it, and an SSH-key import against a
config volume that had been read while empty died the same way. `READ_MOUNT`
is a path the image does not have for exactly that reason.

## One pair is red on purpose

`backup-set-wizard.spec.ts` ends with two tests over one walk and one
variable: a source declared read-only in the wizard, and the same walk with
the box left off. The pair is the assertion rather than either half, because
one test on its own cannot tell "read-only reached the deployment" apart
from "this deployment says read-only about everything".

The read-only half is RED against the pin this repository currently carries,
and that is deliberate. It asserts the behaviour
[rclone-manager#581](https://github.com/spdrman/rclone-manager/pull/581)
restores: `completeFirstRun` was building its request field by field beside
a decoder that fills in the whole spec, and `read_only` never made the
crossing, so a source declared read-only on a fresh install was saved
deletable. Red rather than skipped, and rather than a marker that would keep
the suite green: a skip is invisible in a pass count, and a green suite here
would be saying the deployment under test has a fix it does not have. It
turns green when `build-under-test.json` moves past #581, with nothing else
to change.
