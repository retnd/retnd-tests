// The workflow fixtures and the workflow control channel, pinned.
//
// Same shape and same reasoning as `engine.test.ts`, because it is the
// same protocol: two halves in two repositories, neither able to import
// the other, so each side's promises are only as good as what it pins.
//
// What this side pins:
//
//   - a run that was told nothing has NO fixtures, rather than defaults.
//     A workflow case that silently fell back to `e2e/vps` would assert
//     against a set with no hooks in it and report green;
//   - a malformed set name is a rig defect reported here, not a 404 in
//     the middle of a case;
//   - an acknowledgement left over from an earlier cycle is never read as
//     an answer to this one. A stale `crashed` would make `crashEngine()`
//     return with the engine still running, and every recovery assertion
//     after it would then run against a deployment nothing interrupted;
//   - a rig that tried and could not is believed rather than assumed
//     successful, and its reason survives into what the run prints,
//     because "the rig could not restart the engine" and "the product is
//     broken" are otherwise the same red run;
//   - the runner is put back even when the body failed, and when it
//     cannot be, BOTH failures are reported: the assertion failure is the
//     reason anybody is reading the report, and a runner left down is the
//     reason every later local-hook case is about to fail.
//
// Nothing here starts a container or a runner. The watcher is a few lines
// of fs, which is exactly the contract the shell one has to meet.
//
// The two helpers below use a REAL interval rather than a fake clock,
// and that is the exception these tests are: the module under test
// polls a directory with the real clock because its other half is a bash
// loop in another container, so a faked clock would be testing a
// protocol nobody implements. Nothing here waits for a duration - every
// case awaits the call's own promise settling - and the one case that
// does name a timeout names a 200ms one to assert what a silent rig
// produces without spending a minute finding out.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CRASHED_ACK,
  CRASH_FAILED_ACK,
  CRASH_REQUEST,
  RUNNER_DOWN_REQUEST,
  RUNNER_STARTED_ACK,
  RUNNER_STOPPED_ACK,
  RUNNER_UP_FAILED_ACK,
  RUNNER_UP_REQUEST,
  WORKFLOW_CONTROL_VAR,
  WORKFLOW_SET_VAR,
  crashEngine,
  resolveWorkflowControl,
  resolveWorkflowFixtures,
  withRunnerStopped
} from "./workflow";

const dirs: string[] = [];

function controlDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "workflow-control-"));
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
function watch(dir: string, request: string, ack: string): void {
  const timer = setInterval(() => {
    if (!existsSync(join(dir, request))) return;
    clearInterval(timer);
    rmSync(join(dir, request), { force: true });
    writeFileSync(join(dir, ack), "", "utf8");
  }, 5);
  timer.unref();
}

/** The same watcher on its bad day: it took the request, it tried, and it
 *  is saying so instead of claiming a state it never reached. */
function refuse(dir: string, request: string, failedAck: string, reason: string): void {
  const timer = setInterval(() => {
    if (!existsSync(join(dir, request))) return;
    clearInterval(timer);
    rmSync(join(dir, request), { force: true });
    writeFileSync(join(dir, failedAck), reason, "utf8");
  }, 5);
  timer.unref();
}

describe("which workflow fixtures a run was given", () => {
  it("is nothing at all when the rig said nothing, rather than a default", () => {
    const fixtures = resolveWorkflowFixtures({} as NodeJS.ProcessEnv);
    expect(Object.values(fixtures).every((value) => value === null)).toBe(true);
  });

  it("carries the set the rig named", () => {
    const fixtures = resolveWorkflowFixtures({
      [WORKFLOW_SET_VAR]: "e2e/workflow-happy"
    } as NodeJS.ProcessEnv);
    expect(fixtures.happySet).toBe("e2e/workflow-happy");
    expect(fixtures.execSet).toBeNull();
  });

  it("refuses a name that is not a backup set id, and names the variable carrying it", () => {
    // The dangerous shape: a one-segment name resolves to a URL that
    // 404s halfway through a case, and the failure reads as a product
    // defect rather than as a rig that exported the wrong thing.
    expect(() =>
      resolveWorkflowFixtures({ [WORKFLOW_SET_VAR]: "workflow-happy" } as NodeJS.ProcessEnv)
    ).toThrow(WORKFLOW_SET_VAR);
  });

  it("is off unless the rig is running the watcher", () => {
    expect(resolveWorkflowControl({} as NodeJS.ProcessEnv)).toBeNull();
    expect(
      resolveWorkflowControl({ [WORKFLOW_CONTROL_VAR]: "/artifacts/wf" } as NodeJS.ProcessEnv)
    ).toEqual({ dir: "/artifacts/wf" });
  });
});

describe("crashing the engine mid-run", () => {
  it("returns once the rig has confirmed it, and not before", async () => {
    const dir = controlDir();
    watch(dir, CRASH_REQUEST, CRASHED_ACK);
    await crashEngine({ dir }, 5_000);
    expect(existsSync(join(dir, CRASHED_ACK))).toBe(true);
  });

  it("never reads an earlier cycle's answer as this one's", async () => {
    const dir = controlDir();
    // Left behind by a previous crash that really did fail. A client
    // that did not clear it would reject instantly, here, against a
    // rig that has not been asked anything yet.
    writeFileSync(join(dir, CRASH_FAILED_ACK), "a stale refusal from last time", "utf8");
    watch(dir, CRASH_REQUEST, CRASHED_ACK);
    await crashEngine({ dir }, 5_000);
    expect(existsSync(join(dir, CRASH_FAILED_ACK))).toBe(false);
  });

  it("believes a rig that says it could not, and quotes the reason", async () => {
    const dir = controlDir();
    refuse(dir, CRASH_REQUEST, CRASH_FAILED_ACK, "docker: no such container e2e-engine");
    await expect(crashEngine({ dir }, 5_000)).rejects.toThrow(
      /no such container e2e-engine/u
    );
  });

  it("refuses a rig nobody is running, and says where it looked", async () => {
    const dir = controlDir();
    await expect(crashEngine({ dir }, 200)).rejects.toThrow(join(dir, CRASH_REQUEST));
  });
});

describe("taking the Host Workflow Runner away", () => {
  it("puts it back when the body succeeds", async () => {
    const dir = controlDir();
    watch(dir, RUNNER_DOWN_REQUEST, RUNNER_STOPPED_ACK);
    watch(dir, RUNNER_UP_REQUEST, RUNNER_STARTED_ACK);

    let ranWithItDown = false;
    await withRunnerStopped({ dir }, async () => {
      ranWithItDown = existsSync(join(dir, RUNNER_STOPPED_ACK));
    });

    expect(ranWithItDown, "the body ran before the rig confirmed the stop").toBe(true);
    expect(existsSync(join(dir, RUNNER_STARTED_ACK))).toBe(true);
  });

  it("puts it back when the body fails, and keeps the body's failure", async () => {
    const dir = controlDir();
    watch(dir, RUNNER_DOWN_REQUEST, RUNNER_STOPPED_ACK);
    watch(dir, RUNNER_UP_REQUEST, RUNNER_STARTED_ACK);

    await expect(
      withRunnerStopped({ dir }, async () => {
        throw new Error("the card still said Hooks valid");
      })
    ).rejects.toThrow("the card still said Hooks valid");
    expect(existsSync(join(dir, RUNNER_STARTED_ACK))).toBe(true);
  });

  it("reports both when the runner will not come back either", async () => {
    const dir = controlDir();
    watch(dir, RUNNER_DOWN_REQUEST, RUNNER_STOPPED_ACK);
    refuse(dir, RUNNER_UP_REQUEST, RUNNER_UP_FAILED_ACK, "the runner socket is already bound");

    const failure = await withRunnerStopped({ dir }, async () => {
      throw new Error("the card still said Hooks valid");
    }).catch((e: unknown) => e as Error);

    // Both, because either alone sends whoever reads the report to the
    // wrong place: the assertion is what broke, and the runner being
    // down is why the twenty cases after it are about to.
    expect(failure.message).toContain("the card still said Hooks valid");
    expect(failure.message).toContain("the runner socket is already bound");
    expect(failure.cause).toBeInstanceOf(Error);
  });
});
