// The control channel's own tests.
//
// Two halves live in two repositories - this module and the watcher inside
// `scripts/e2e/three-machine-web-ui.sh` - and neither can import the
// other, so the protocol is only as good as what each side pins. This side
// pins: which environments enable it, which environment is a rig that
// half-implemented it, that an acknowledgement left over from an earlier
// cycle is never read as an answer to this one, and that a rig nobody is
// running fails with the two paths in the message.
//
// The stale-ack case is the one worth having. A leftover `stopped` would
// make `stopEngine()` return instantly with the engine still running, and
// every #795 assertion after it would then run against a perfectly healthy
// deployment and fail for reasons that have nothing to do with the bug: a
// green rig, a red suite, and nothing pointing at the cause.
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
  START_REQUEST,
  STOPPED_ACK,
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

  it("gives up on a rig that is not listening, and names both files", async () => {
    const dir = controlDir();
    // No watcher at all. The half-failure most likely in practice is the
    // two sides disagreeing about the directory, and a hang with no
    // message is the worst possible way to learn that. A real 50ms, since
    // the behaviour under test IS the deadline.
    const error = await startEngine({ dir }, 50).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(join(dir, START_REQUEST));
    expect((error as Error).message).toContain(join(dir, STARTED_ACK));
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
});
