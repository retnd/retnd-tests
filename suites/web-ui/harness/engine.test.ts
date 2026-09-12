// The control channel's own tests.
//
// Two halves live in two repositories - this module and the watcher inside
// `scripts/e2e/three-machine-web-ui.sh` - and neither can import the
// other, so the protocol is only as good as what each side pins. This side
// pins: which environments enable it, which environment is a rig that
// half-implemented it, that an acknowledgement left over from an earlier
// cycle is never read as an answer to this one, that a rig which tried and
// could not is believed rather than assumed successful, and that a rig
// nobody is running fails with every path in the message.
//
// The stale-ack case is the one worth having. A leftover `stopped` would
// make `stopEngine()` return instantly with the engine still running, and
// every #795 assertion after it would then run against a perfectly healthy
// deployment and fail for reasons that have nothing to do with the bug: a
// green rig, a red suite, and nothing pointing at the cause.
//
// The refusal cases are the same failure reached the other way round. The
// rig can only write `stopped` for a stop it verified, so the honest
// answer to a `docker stop` that failed, or to a start whose healthcheck
// never came good, is `stop-failed`/`start-failed` and a reason - and a
// client that ignored those, or timed out and shrugged, would put the suite
// back in exactly the state the stale ack does. So both failure answers
// must reject, and the reason has to survive into what the run prints,
// because "the rig could not restart the engine" and "the product is
// broken" are otherwise the same red run.
//
// Nothing here starts a container. The watcher is a few lines of fs, which
// is exactly the contract the shell one has to meet.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ENGINE_CONTROL_VAR,
  ENGINE_UNREACHABLE_VAR,
  STARTED_ACK,
  START_FAILED_ACK,
  START_REQUEST,
  STOPPED_ACK,
  STOP_FAILED_ACK,
  STOP_REQUEST,
  canBreakEngine,
  resolveEngineControl,
  startEngine,
  stopEngine,
  withEngineStopped
} from "./engine";

const dirs: string[] = [];

function controlDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "engine-control-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** The watcher, as the rig implements it in bash: take the request away,
 *  do the work, drop the opposite acknowledgement, raise this one.
 *
 *  A real interval, deliberately: these cases are about two processes
 *  taking turns through a directory, and what they wait on is the
 *  protocol's own promise resolving, never a duration somebody guessed. */
function watch(dir: string, request: string, ack: string, opposite: string): void {
  const timer = setInterval(() => {
    if (!existsSync(join(dir, request))) return;
    clearInterval(timer);
    rmSync(join(dir, request), { force: true });
    rmSync(join(dir, opposite), { force: true });
    writeFileSync(join(dir, ack), "", "utf8");
  }, 5);
  timer.unref();
}

/** The same watcher on its bad day: it took the request, it tried, and it
 *  is saying so instead of claiming a state it never reached.
 *
 *  `reason` is written as the file's one line, exactly as the rig's half
 *  does.
 *
 *  A real interval for the same reason `watch` uses one, and it is the
 *  exception these tests are: the module under test polls a directory with
 *  the real clock because its other half is a bash loop in another
 *  container, so a faked clock would test a protocol nobody implements.
 *  Nothing below waits for a duration - every case awaits the call's own
 *  promise settling. */
function refuse(dir: string, request: string, failedAck: string, reason: string): void {
  const timer = setInterval(() => {
    if (!existsSync(join(dir, request))) return;
    clearInterval(timer);
    rmSync(join(dir, request), { force: true });
    writeFileSync(join(dir, failedAck), reason, "utf8");
  }, 5);
  timer.unref();
}

/** A refusal that arrives before its reason does, which is what a reader
 *  sees if it looks between the rig creating the file and filling it.
 *  Created empty on one tick and written on the next, so the ordering is
 *  the point and no case waits on how long the gap was. */
function refuseMidWrite(dir: string, request: string, failedAck: string, reason: string): void {
  const timer = setInterval(() => {
    if (!existsSync(join(dir, request))) return;
    clearInterval(timer);
    rmSync(join(dir, request), { force: true });
    writeFileSync(join(dir, failedAck), "", "utf8");
    const fill = setInterval(() => {
      clearInterval(fill);
      writeFileSync(join(dir, failedAck), reason, "utf8");
    }, 5);
    fill.unref();
  }, 5);
  timer.unref();
}

describe("whether a run may break the engine", () => {
  it("is off unless the rig says so, because an ordinary run must leave the deployment alone", () => {
    expect(resolveEngineControl({} as NodeJS.ProcessEnv)).toBeNull();
    expect(
      canBreakEngine({ [ENGINE_CONTROL_VAR]: "/artifacts/engine-control" } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  it("is on when the rig exports both halves", () => {
    const env = {
      [ENGINE_UNREACHABLE_VAR]: "1",
      [ENGINE_CONTROL_VAR]: "/artifacts/engine-control"
    } as NodeJS.ProcessEnv;
    expect(resolveEngineControl(env)).toEqual({ dir: "/artifacts/engine-control" });
    expect(canBreakEngine(env)).toBe(true);
  });

  it("refuses a rig that asked for the mode and gave no channel, rather than skipping quietly", () => {
    // The dangerous shape: a skip here reads exactly like an ordinary run
    // against an unbroken deployment, so the #795 cases would be reported
    // as "not applicable" on the very run that asked for them.
    const env = { [ENGINE_UNREACHABLE_VAR]: "1" } as NodeJS.ProcessEnv;
    expect(() => resolveEngineControl(env)).toThrow(new RegExp(ENGINE_CONTROL_VAR));
    expect(() => resolveEngineControl(env)).toThrow(/--break-engine/);
  });
});

describe("the request and acknowledgement pair", () => {
  it("asks by name and returns only once the rig has answered", async () => {
    const dir = controlDir();
    watch(dir, STOP_REQUEST, STOPPED_ACK, STARTED_ACK);
    await stopEngine({ dir }, 5_000);
    expect(existsSync(join(dir, STOPPED_ACK))).toBe(true);
    // Taken away by the watcher, which is what stops one request from
    // being answered twice.
    expect(existsSync(join(dir, STOP_REQUEST))).toBe(false);
  });

  it("does not read the previous cycle's acknowledgement as this cycle's answer", async () => {
    const dir = controlDir();
    // This deployment has been stopped and started before, so both acks
    // have existed. Leave the one this call waits for lying around.
    writeFileSync(join(dir, STOPPED_ACK), "", "utf8");

    const pending = stopEngine({ dir }, 5_000);
    // Asserted on the synchronous part of the call, which is the whole
    // contract and needs no waiting to see: by the time this request is on
    // disk, the ack it will be answered with is gone. A call that trusted
    // the stale file would have resolved against a running engine.
    expect(existsSync(join(dir, STOP_REQUEST))).toBe(true);
    expect(existsSync(join(dir, STOPPED_ACK))).toBe(false);

    // And it is the rig's own answer, not the leftover, that ends the wait.
    watch(dir, STOP_REQUEST, STOPPED_ACK, STARTED_ACK);
    await pending;
    expect(existsSync(join(dir, STOPPED_ACK))).toBe(true);
  });

  it("does not read the previous cycle's refusal as this cycle's answer either", async () => {
    const dir = controlDir();
    // A `stop-failed` from an earlier cycle that was then retried and
    // recovered. Left behind, it would stop the very next stop request
    // with a reason that belongs to a different minute of the run.
    writeFileSync(join(dir, STOP_FAILED_ACK), "the previous cycle's dead container", "utf8");

    const pending = stopEngine({ dir }, 5_000);
    expect(existsSync(join(dir, STOP_REQUEST))).toBe(true);
    expect(existsSync(join(dir, STOP_FAILED_ACK))).toBe(false);

    watch(dir, STOP_REQUEST, STOPPED_ACK, STARTED_ACK);
    await pending;
  });

  it("rejects a stop the rig could not make, rather than reporting on a running engine", async () => {
    const dir = controlDir();
    refuse(dir, STOP_REQUEST, STOP_FAILED_ACK, "docker stop backupd-engine: permission denied");

    const error = await stopEngine({ dir }, 5_000).catch((thrown: unknown) => thrown);

    // The whole point of the failure answer. A resolved call here would
    // send every #795 assertion that follows at a healthy deployment, and
    // the run would report the product broken because the rig was.
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("permission denied");
    expect((error as Error).message).toContain(join(dir, STOP_FAILED_ACK));
    // And it is not dressed up as silence: the rig answered, so the
    // message must not send anyone looking for a watcher that is running.
    expect((error as Error).message).not.toMatch(/never answered/i);
  });

  it("rejects a start the rig could not make, so no case claims a recovered deployment", async () => {
    const dir = controlDir();
    refuse(dir, START_REQUEST, START_FAILED_ACK, "healthcheck never passed after 120s");

    const error = await startEngine({ dir }, 5_000).catch((thrown: unknown) => thrown);

    // The dangerous half. `startEngine` resolving means "the engine is
    // healthy again", and it is what `withEngineStopped` puts the
    // deployment back with; a silent success on a failed start hands the
    // rest of the run a stack with no engine in it.
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("healthcheck never passed after 120s");
    expect((error as Error).message).toContain(START_REQUEST);
  });

  it("waits for a reason that is still being written, instead of quoting an empty one", async () => {
    const dir = controlDir();
    refuseMidWrite(dir, START_REQUEST, START_FAILED_ACK, "no such container: backupd-engine");

    const error = await startEngine({ dir }, 5_000).catch((thrown: unknown) => thrown);

    // The refusal is the file's existence and the reason is its content,
    // so a reader that arrives between the two has the answer and not the
    // half of it anybody can act on.
    expect((error as Error).message).toContain("no such container: backupd-engine");
  });

  it("still refuses when the reason never arrives, and says that is what happened", async () => {
    const dir = controlDir();
    // A rig that wrote the file and nothing in it. The refusal is real
    // either way; what must not happen is the missing reason turning into
    // a success, or into an fs error about the file carrying it.
    refuse(dir, STOP_REQUEST, STOP_FAILED_ACK, "");

    const error = await stopEngine({ dir }, 5_000).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("gave no reason");
  });

  it("gives up on a rig that is not listening, and names every file it waited on", async () => {
    const dir = controlDir();
    // No watcher at all. The half-failure most likely in practice is the
    // two sides disagreeing about the directory, and a hang with no
    // message is the worst possible way to learn that. A real 50ms, since
    // the behaviour under test IS the deadline.
    const error = await startEngine({ dir }, 50).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(join(dir, START_REQUEST));
    expect((error as Error).message).toContain(join(dir, STARTED_ACK));
    // Including the one it could have been refused with: "neither of these
    // appeared" is what distinguishes a watcher pointed at another
    // directory from one that is there and losing to Docker.
    expect((error as Error).message).toContain(join(dir, START_FAILED_ACK));
  });
});

describe("running something with the engine stopped", () => {
  it("puts the engine back when the body throws, so one red case does not redden the run", async () => {
    const dir = controlDir();
    watch(dir, STOP_REQUEST, STOPPED_ACK, STARTED_ACK);
    const order: string[] = [];

    await expect(
      withEngineStopped({ dir }, async () => {
        order.push("asserted");
        watch(dir, START_REQUEST, STARTED_ACK, STOPPED_ACK);
        throw new Error("the banner never appeared");
      })
    ).rejects.toThrow(/banner/);

    expect(order).toEqual(["asserted"]);
    expect(existsSync(join(dir, STARTED_ACK))).toBe(true);
    expect(existsSync(join(dir, STOPPED_ACK))).toBe(false);
  });

  it("fails the case when only the restore does, because the run is over either way", async () => {
    const dir = controlDir();
    watch(dir, STOP_REQUEST, STOPPED_ACK, STARTED_ACK);

    await expect(
      withEngineStopped({ dir }, async () => {
        refuse(dir, START_REQUEST, START_FAILED_ACK, "start: address already in use");
        return "the banner said the right thing";
      })
    ).rejects.toThrow(/address already in use/);
  });

  it("says both when the case failed AND the engine would not come back", async () => {
    const dir = controlDir();
    watch(dir, STOP_REQUEST, STOPPED_ACK, STARTED_ACK);

    const error = await withEngineStopped({ dir }, async () => {
      refuse(dir, START_REQUEST, START_FAILED_ACK, "start: address already in use");
      throw new Error("the banner never appeared");
    }).catch((thrown: unknown) => thrown);

    // Two different people read these two lines: the restore failure is
    // why every later case in the run is meaningless, and the assertion
    // failure is why anybody opened the report. A restore that threw over
    // the body's error would have deleted the second.
    expect((error as Error).message).toContain("the banner never appeared");
    expect((error as Error).message).toContain("address already in use");
    // And the original is still the thing that was thrown, not a string
    // in a message: a reporter that reads `cause` gets the real stack.
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).message).toBe("the banner never appeared");
  });
});
