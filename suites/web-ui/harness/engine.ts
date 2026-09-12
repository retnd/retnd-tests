// Making the real engine unreachable, from inside the client container.
//
// This is the only thing in this suite that changes the DEPLOYMENT rather
// than reading it, and it exists because backupd#795 cannot be reproduced
// any other way.
//
// # Why a control file and not `page.route`
//
// `activity-failure.spec.ts` reproduces both failure shapes with
// `page.route`, and that is a legitimate thing to do: it substitutes the
// bytes on the wire and leaves the app, the bundle, the router and the
// error boundary real. But it substitutes them INSIDE the browser, so the
// hop #795 is actually about - `backupd-web serve-ui` trying to reach
// `backupd-web serve` and failing - never happens. The reported NAS's
// serve-ui logged `dial tcp: lookup rclone-manager on 127.0.0.11:53: no
// such host` and answered the browser itself; nothing a route handler
// does can produce that, because the request never leaves the page.
//
// So this module asks the RIG to stop the engine container, and the
// assertions that follow are about what a browser is shown when a real
// reverse proxy really cannot reach a real engine.
//
// # The break has to happen mid-session, and that is not a detail
//
// The obvious design - stop the engine, then run the suite - cannot work,
// and the reason is worth writing down because it is the same reason
// #795's symptom looked the way it did.
//
// serve-ui proxies the WHOLE of /api/v1 to the engine, `auth/session` and
// `auth/login` included. With the engine already down when a page loads,
// the bundle's one auth fetch fails, PlatformContext commits
// `{ authenticated: false }`, and the app renders its login screen. The
// browser never reaches /activity, and this suite's own sign-in throws in
// a worker fixture, so every spec in the directory errors in setup instead
// of asserting anything.
//
// The NAS did not hit that, because the operator's tab was already loaded
// and already authenticated when the engine went away underneath it -
// which is exactly what an in-place upgrade that renames a container does.
// So the break belongs in the middle of a live session: load the app while
// the engine is up, take the engine away, then navigate. Which means the
// suite, not the rig's start-up, has to choose the moment.
//
// # The protocol
//
// One directory, shared between the host (which has Docker) and the client
// container (which deliberately does not). `--break-engine` creates it,
// mounts it under RM_ARTIFACTS_DIR, names it in RM_ENGINE_CONTROL, and
// runs a watcher beside the client for the lifetime of the run. Four empty
// files, two of them requests and two of them acknowledgements:
//
//   client  ->  <dir>/stop       please stop the engine container
//   watcher ->  removes `stop`, `docker stop`s it, removes `started`,
//               creates <dir>/stopped
//   client  ->  <dir>/start      please bring it back
//   watcher ->  removes `start`, `docker start`s it, waits for the
//               engine's healthcheck, removes `stopped`, creates
//               <dir>/started
//
// The names carry the whole message, so there is no content for either
// side to read half of. Each call deletes the acknowledgement it is about
// to wait for before it asks, so an ack left over from an earlier call can
// never be mistaken for an answer to this one.
//
// Nothing here shells out to Docker and nothing here is given a Docker
// socket. A client container that could stop containers is a client
// container that can stop anything on the host, for the sake of a test.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** Set to "1" by `three-machine-web-ui.sh --break-engine`.
 *
 *  It means "this run may make the engine unreachable", not "the engine is
 *  unreachable right now": the rig leaves the stack whole and hands the
 *  suite the ability to break it, for the mid-session reason above. */
export const ENGINE_UNREACHABLE_VAR = "RM_ENGINE_UNREACHABLE";

/** The control directory, as the CLIENT container sees it. */
export const ENGINE_CONTROL_VAR = "RM_ENGINE_CONTROL";

/** The rig's four file names. Written down here because this module and
 *  `scripts/e2e/three-machine-web-ui.sh`, in the other repository, are the
 *  two halves of one protocol and neither can import the other. */
export const STOP_REQUEST = "stop";
export const START_REQUEST = "start";
export const STOPPED_ACK = "stopped";
export const STARTED_ACK = "started";

/** How long each half is given.
 *
 *  Stopping is a SIGTERM and a grace period; starting is a container boot
 *  plus the engine's own healthcheck, which opens SQLite and reads the
 *  configuration, so it is given considerably longer. Both are bounded: a
 *  control file nobody is watching would otherwise hang the run at the
 *  point where the deployment is broken. */
export const STOP_TIMEOUT_MS = 60_000;
export const START_TIMEOUT_MS = 180_000;

const POLL_MS = 100;

/** What this run is allowed to do to the deployment.
 *
 *  `null` in the ordinary case: a normal Suite B run drives a deployment it
 *  must leave exactly as it found it, and the specs that need a broken one
 *  say so with `needs()` rather than breaking one anyway. */
export interface EngineControl {
  /** Where the request/ack files go. */
  readonly dir: string;
}

/** Resolves the control channel, and refuses a half-implemented one.
 *
 *  A rig that exported the flag without the directory has said this run
 *  may break the engine and then given it no way to, and the specs would
 *  skip with a reason that reads like an ordinary unbroken deployment.
 *  That is a green run reporting on nothing, so it throws instead. The
 *  opposite pairing is not an error: a directory with the flag off is a
 *  rig that could have been asked and was not. */
export function resolveEngineControl(env: NodeJS.ProcessEnv = process.env): EngineControl | null {
  const dir = (env[ENGINE_CONTROL_VAR] ?? "").trim();
  if ((env[ENGINE_UNREACHABLE_VAR] ?? "").trim() !== "1") return null;
  if (dir === "") {
    throw new Error(
      ENGINE_UNREACHABLE_VAR +
        "=1 says this run may make the engine unreachable, but " +
        ENGINE_CONTROL_VAR +
        " names no control directory, so nothing can. The rig exports both together: " +
        "scripts/e2e/three-machine-web-ui.sh --break-engine --suite <dir>"
    );
  }
  return { dir };
}

/** Whether the #795 cases can run at all. The specs' own precondition, and
 *  a function rather than a constant because Playwright resolves the
 *  environment per worker. */
export function canBreakEngine(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveEngineControl(env) !== null;
}

/** The reason a spec gives when it cannot. Written once, because a skip
 *  line that does not say how to un-skip it is a case nobody ever runs. */
export const NEEDS_BREAKABLE_ENGINE =
  "a rig that can take the engine away mid-session: " +
  "scripts/e2e/three-machine-web-ui.sh --break-engine --suite <this directory>";

/** Sends one request and waits for its acknowledgement.
 *
 *  Both failure messages name the directory, because the failure somebody
 *  actually has to debug here is "the two halves of the rig are not
 *  looking at the same place", and that is unreadable without the path. */
async function ask(
  control: EngineControl,
  request: string,
  ack: string,
  timeoutMs: number
): Promise<void> {
  mkdirSync(control.dir, { recursive: true });
  rmSync(join(control.dir, ack), { force: true });
  writeFileSync(join(control.dir, request), "", "utf8");

  const deadline = Date.now() + timeoutMs;
  const ackPath = join(control.dir, ack);
  while (!existsSync(ackPath)) {
    if (Date.now() >= deadline) {
      throw new Error(
        "the rig never answered `" +
          request +
          "` within " +
          String(Math.round(timeoutMs / 1000)) +
          "s: its watcher reads " +
          join(control.dir, request) +
          " and answers with " +
          ackPath +
          ", and nothing appeared. The deployment is in whatever state the last request left it."
      );
    }
    await sleep(POLL_MS);
  }
}

/** Stops the engine container. serve-ui stays up, so the browser still has
 *  a web server and a loaded application - it is the hop BEHIND that
 *  server that is gone, which is #795's shape and not "the NAS is off".
 *
 *  `timeoutMs` is a parameter on this and on `startEngine` only so this
 *  module's own unit tests can assert what a silent rig produces without
 *  spending a minute doing it. Every caller in the suite takes the
 *  default. */
export async function stopEngine(
  control: EngineControl,
  timeoutMs: number = STOP_TIMEOUT_MS
): Promise<void> {
  await ask(control, STOP_REQUEST, STOPPED_ACK, timeoutMs);
}

/** Starts it again, and returns once the rig has seen it healthy.
 *
 *  Healthy rather than merely started is what makes the recovery
 *  assertions honest: a container that is running but has not opened its
 *  database yet answers the proxy with a refusal, and a "Try again" that
 *  hit that would fail for a reason the case is not about. */
export async function startEngine(
  control: EngineControl,
  timeoutMs: number = START_TIMEOUT_MS
): Promise<void> {
  await ask(control, START_REQUEST, STARTED_ACK, timeoutMs);
}

/** Runs `body` with the engine stopped, and puts it back however `body`
 *  ends.
 *
 *  The `finally` is the load-bearing part. One deployment is shared by
 *  every spec in the run, so an engine left stopped by a failing assertion
 *  does not fail one case: it fails every case after it, with errors that
 *  say nothing about what broke. The specs additionally heal in an
 *  `afterAll`, for the one path this cannot cover - a test that exceeds its
 *  timeout is abandoned mid-await and never reaches its own `finally`. */
export async function withEngineStopped<T>(
  control: EngineControl,
  body: () => Promise<T>
): Promise<T> {
  await stopEngine(control);
  try {
    return await body();
  } finally {
    await startEngine(control);
  }
}
