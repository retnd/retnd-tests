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
// runs a watcher beside the client for the lifetime of the run. Two
// requests, and for each of them two possible answers:
//
//   client  ->  <dir>/stop       please stop the engine container
//   watcher ->  removes `stop`, `docker stop`s it; on success removes
//               `started` and creates <dir>/stopped, and on failure
//               creates <dir>/stop-failed instead
//   client  ->  <dir>/start      please bring it back
//   watcher ->  removes `start`, `docker start`s it, waits for the
//               engine's healthcheck; on success removes `stopped` and
//               creates <dir>/started, and if either the start or the
//               healthcheck fails creates <dir>/start-failed instead
//
// The names carry the whole message for the two successes, so there is no
// content for either side to read half of. The two failures carry one
// short line of content, because "the rig could not do that" is only
// actionable with the reason, and that line is the only thing either side
// ever reads out of a file.
//
// Each call deletes BOTH answers it could be given before it asks, so an
// acknowledgement left over from an earlier call can never be mistaken for
// an answer to this one.
//
// A success acknowledgement therefore means the rig VERIFIED the state:
// `stopped` only after a stop that really stopped it, `started` only after
// a start whose healthcheck really passed. That is what lets the specs
// after it assert about a deployment rather than about a hope. The rig
// half must never write one it has not verified, and this half must never
// treat a missing one, or a failure one, as if it had.
//
// Nothing here shells out to Docker and nothing here is given a Docker
// socket. A client container that could stop containers is a client
// container that can stop anything on the host, for the sake of a test.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** The rig's six file names. Written down here because this module and
 *  `scripts/e2e/three-machine-web-ui.sh`, in the other repository, are the
 *  two halves of one protocol and neither can import the other. */
export const STOP_REQUEST = "stop";
export const START_REQUEST = "start";
export const STOPPED_ACK = "stopped";
export const STARTED_ACK = "started";

/** The two answers that say the rig TRIED and could not, each holding one
 *  short line of reason.
 *
 *  They exist because the alternative to an explicit refusal is not
 *  silence, it is a lie: a watcher that could not stop the container and
 *  said `stopped` anyway hands the suite a healthy deployment and a set of
 *  assertions written for a broken one, and the run then reports a product
 *  bug that is really a rig failure. */
export const STOP_FAILED_ACK = "stop-failed";
export const START_FAILED_ACK = "start-failed";

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

/** How long a failure acknowledgement is given to finish arriving.
 *
 *  The rig writes the reason into the file it then leaves in place, and a
 *  reader that happened to look between the create and the write would see
 *  an empty one. That is a millisecond-wide window and the answer is
 *  already known, so this waits briefly for the content rather than
 *  reporting a refusal with no reason in it. */
const REASON_SETTLE_MS = 1_000;

/** The longest reason this module will quote.
 *
 *  The rig promises one short line; this does not depend on that promise,
 *  because the thing most likely to be in there when it breaks is a Docker
 *  error dump, and a test report is not improved by burying the assertion
 *  under one. */
const REASON_LIMIT = 400;

/** The rig's reason, read out of a failure acknowledgement, as one line.
 *
 *  Never throws: this is called on a path that is already reporting a
 *  failure, and a missing or unreadable reason must not replace the
 *  refusal with an fs error about the file that was carrying it. */
async function refusalReason(path: string): Promise<string> {
  const settled = Date.now() + REASON_SETTLE_MS;
  for (;;) {
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      text = "";
    }
    const line = text.replace(/\s+/gu, " ").trim();
    if (line !== "") {
      return line.length > REASON_LIMIT ? line.slice(0, REASON_LIMIT) + "..." : line;
    }
    if (Date.now() >= settled) return "the rig gave no reason";
    await sleep(POLL_MS);
  }
}

/** Sends one request and waits for the rig to answer it.
 *
 *  Three outcomes, and only one of them returns. The rig either confirms
 *  the state it verified, refuses with a reason, or says nothing at all
 *  until the deadline - and the last two are failures of the RIG, which is
 *  why both messages name the directory: the half-failure somebody
 *  actually has to debug here is "the two halves of the rig are not
 *  looking at the same place", and that is unreadable without the paths.
 *
 *  What this must never do is return on anything else. A resolved call is
 *  read by everything downstream as "the deployment is now in that state",
 *  and an engine that is actually still running would then be asserted
 *  against by cases written for an engine that is gone. */
async function ask(
  control: EngineControl,
  request: string,
  ack: string,
  failedAck: string,
  timeoutMs: number
): Promise<void> {
  mkdirSync(control.dir, { recursive: true });
  const ackPath = join(control.dir, ack);
  const failedPath = join(control.dir, failedAck);
  // Both possible answers, not just the one this call hopes for: a
  // `start-failed` left behind by an earlier cycle would otherwise be read
  // as this cycle's refusal, and the run would stop on a stale reason.
  rmSync(ackPath, { force: true });
  rmSync(failedPath, { force: true });
  writeFileSync(join(control.dir, request), "", "utf8");

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(ackPath)) return;
    if (existsSync(failedPath)) {
      throw new Error(
        "the rig tried to answer `" +
          request +
          "` and could not: " +
          (await refusalReason(failedPath)) +
          " (it said so in " +
          failedPath +
          "). The deployment is in whatever state that left it, so nothing " +
          "after this can claim to know whether the engine is up."
      );
    }
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
          ", or refuses with " +
          failedPath +
          ", and neither appeared. The deployment is in whatever state the last request left it."
      );
    }
    await sleep(POLL_MS);
  }
}

/** Stops the engine container. serve-ui stays up, so the browser still has
 *  a web server and a loaded application - it is the hop BEHIND that
 *  server that is gone, which is #795's shape and not "the NAS is off".
 *
 *  Rejects unless the rig VERIFIED the stop, in either of the two ways it
 *  can fail to: an explicit `stop-failed` carrying the reason, or nothing
 *  at all within the timeout. Both are "the engine may well still be
 *  running", and a case that went on to assert #795's banner against a
 *  healthy deployment would fail with a screenshot of a working product
 *  and a message about the product.
 *
 *  `timeoutMs` is a parameter on this and on `startEngine` only so this
 *  module's own unit tests can assert what a silent rig produces without
 *  spending a minute doing it. Every caller in the suite takes the
 *  default. */
export async function stopEngine(
  control: EngineControl,
  timeoutMs: number = STOP_TIMEOUT_MS
): Promise<void> {
  await ask(control, STOP_REQUEST, STOPPED_ACK, STOP_FAILED_ACK, timeoutMs);
}

/** Starts it again, and returns once the rig has seen it healthy.
 *
 *  Healthy rather than merely started is what makes the recovery
 *  assertions honest: a container that is running but has not opened its
 *  database yet answers the proxy with a refusal, and a "Try again" that
 *  hit that would fail for a reason the case is not about.
 *
 *  So `start-failed` covers a start that did not start AND a start whose
 *  healthcheck never came good, and this rejects on both - the second one
 *  being the dangerous shape, since the container is then up, the run
 *  looks recovered, and every later case reads a half-open engine. */
export async function startEngine(
  control: EngineControl,
  timeoutMs: number = START_TIMEOUT_MS
): Promise<void> {
  await ask(control, START_REQUEST, STARTED_ACK, START_FAILED_ACK, timeoutMs);
}

/** Runs `body` with the engine stopped, and puts it back however `body`
 *  ends.
 *
 *  The restore is the load-bearing part. One deployment is shared by
 *  every spec in the run, so an engine left stopped by a failing assertion
 *  does not fail one case: it fails every case after it, with errors that
 *  say nothing about what broke. The specs additionally heal in an
 *  `afterAll`, for the one path this cannot cover - a test that exceeds its
 *  timeout is abandoned mid-await and never reaches its own restore.
 *
 *  It is written out rather than left as a `finally` because the restore
 *  can now fail out loud, and a throwing `finally` REPLACES whatever the
 *  body threw. That trade is the wrong way round: "the engine would not
 *  come back" has to be reported, since the rest of the run is worthless
 *  without it, but it must not delete the assertion failure that is the
 *  reason anyone is reading the report. So both are said, and the one the
 *  body raised is kept as the cause. */
export async function withEngineStopped<T>(
  control: EngineControl,
  body: () => Promise<T>
): Promise<T> {
  await stopEngine(control);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await body() };
  } catch (error) {
    outcome = { ok: false, error };
  }

  try {
    await startEngine(control);
  } catch (restore) {
    if (outcome.ok) throw restore;
    const asserted =
      outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    const restoring = restore instanceof Error ? restore.message : String(restore);
    throw new Error(
      "the case failed AND the engine did not come back, so every case after " +
        "this one runs against a deployment with no engine.\n" +
        "  the case: " +
        asserted +
        "\n  the restore: " +
        restoring,
      { cause: outcome.error }
    );
  }

  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
