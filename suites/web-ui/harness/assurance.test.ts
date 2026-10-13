// The assurance rig contract's own tests (retnd#986).
//
// Three things the specs for recovery and assurance need from a rig that the
// ordinary one does not give them: a way to change a copy's bytes underneath
// the engine (a real failing scrub has to be a real changed file), a backup
// set whose recovery test is slow enough to be caught in the middle of, and a
// backup large enough that a download cannot finish before the browser
// leaves. Each is a fact the rig supplies, and each is checked here the way
// engine.test.ts checks the engine control: which environments enable it,
// that a half-implemented rig throws, that a stale acknowledgement is never
// read as this call's answer, and that a refusal carries its reason.
//
// Nothing here starts a container. The watcher is a few lines of fs.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BIG_ARTIFACT_BYTES_VAR,
  BIG_ARTIFACT_VAR,
  COPY_CONTROL_VAR,
  CORRUPTED_ACK,
  CORRUPT_FAILED_ACK,
  CORRUPT_REQUEST,
  MIN_STREAM_BYTES,
  RESTORED_ACK,
  RESTORE_REQUEST,
  SLOW_RECOVERY_SET_VAR,
  corruptCopy,
  BUILTIN_CHECK_SET_VAR,
  resolveAssuranceFixtures,
  resolveCopyControl,
  restoreCopy,
  withCopyCorrupted
} from "./assurance";

const dirs: string[] = [];
const control = () => {
  const dir = mkdtempSync(join(tmpdir(), "copy-control-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** The rig's watcher: take the request away (remembering what it said), do
 *  the work, raise the acknowledgement. A real interval, for the reason
 *  engine.test.ts gives: the other half is a bash loop in another container. */
function watch(dir: string, request: string, ack: string, seen: string[] = []): void {
  const timer = setInterval(() => {
    if (!existsSync(join(dir, request))) return;
    clearInterval(timer);
    seen.push(readFileSync(join(dir, request), "utf8"));
    rmSync(join(dir, request), { force: true });
    writeFileSync(join(dir, ack), "", "utf8");
  }, 5);
  timer.unref();
}

function refuse(dir: string, request: string, failedAck: string, reason: string): void {
  const timer = setInterval(() => {
    if (!existsSync(join(dir, request))) return;
    clearInterval(timer);
    rmSync(join(dir, request), { force: true });
    writeFileSync(join(dir, failedAck), reason, "utf8");
  }, 5);
  timer.unref();
}

describe("the copy control channel", () => {
  it("is off unless the rig exported the directory", () => {
    expect(resolveCopyControl({})).toBeNull();
    expect(resolveCopyControl({ [COPY_CONTROL_VAR]: "  " })).toBeNull();
    expect(resolveCopyControl({ [COPY_CONTROL_VAR]: "/ctl" })).toEqual({ dir: "/ctl" });
  });

  it("tells the watcher which backup to change, in the request itself", async () => {
    const dir = control();
    const seen: string[] = [];
    watch(dir, CORRUPT_REQUEST, CORRUPTED_ACK, seen);
    await corruptCopy({ dir }, "production/postgres-primary/a.dump", 2_000);
    expect(seen).toEqual(["production/postgres-primary/a.dump"]);
  });

  it("never reads an acknowledgement left over from an earlier call as this call's answer", async () => {
    const dir = control();
    writeFileSync(join(dir, CORRUPTED_ACK), "", "utf8");
    // No watcher: a stale ack that was believed would resolve at once.
    await expect(corruptCopy({ dir }, "x/y/z", 150)).rejects.toThrow(/never answered `corrupt`/);
  });

  it("believes a rig that tried and could not, and carries its reason", async () => {
    const dir = control();
    refuse(dir, CORRUPT_REQUEST, CORRUPT_FAILED_ACK, "no such file: /data/x");
    await expect(corruptCopy({ dir }, "x/y/z", 2_000)).rejects.toThrow(/no such file: \/data\/x/);
  });

  it("puts the copy back however the body ends, and keeps the body's failure", async () => {
    const dir = control();
    watch(dir, CORRUPT_REQUEST, CORRUPTED_ACK);
    watch(dir, RESTORE_REQUEST, RESTORED_ACK);
    await expect(
      withCopyCorrupted({ dir }, "x/y/z", async () => {
        throw new Error("the assertion that was the point");
      })
    ).rejects.toThrow(/the assertion that was the point/);
    // The restore ran: the request was taken and its acknowledgement raised.
    expect(existsSync(join(dir, RESTORED_ACK))).toBe(true);
  });

  it("restoreCopy rejects when the rig says it could not", async () => {
    const dir = control();
    refuse(dir, RESTORE_REQUEST, "restore-failed", "snapshot missing");
    await expect(restoreCopy({ dir }, 2_000)).rejects.toThrow(/snapshot missing/);
  });
});

describe("the assurance fixtures", () => {
  it("are absent unless the rig names them", () => {
    expect(resolveAssuranceFixtures({})).toEqual({ slowRecoverySet: null, builtinCheckSet: null, bigArtifact: null });
  });

  it("names the slow set and the big artifact", () => {
    const got = resolveAssuranceFixtures({
      [SLOW_RECOVERY_SET_VAR]: " production/slow ",
      [BIG_ARTIFACT_VAR]: "production/big/archive.bin",
      [BIG_ARTIFACT_BYTES_VAR]: String(MIN_STREAM_BYTES * 2)
    });
    expect(got.slowRecoverySet).toBe("production/slow");
    expect(got.bigArtifact).toEqual({ id: "production/big/archive.bin", bytes: MIN_STREAM_BYTES * 2 });
  });

  it("refuses a big artifact that is not big enough to be caught mid-stream", () => {
    expect(() =>
      resolveAssuranceFixtures({
        [BIG_ARTIFACT_VAR]: "production/big/archive.bin",
        [BIG_ARTIFACT_BYTES_VAR]: String(MIN_STREAM_BYTES - 1)
      })
    ).toThrow(/too small/);
  });

  it("refuses a big artifact with no size, or a size with no artifact", () => {
    expect(() => resolveAssuranceFixtures({ [BIG_ARTIFACT_VAR]: "a/b/c" })).toThrow(new RegExp(BIG_ARTIFACT_BYTES_VAR));
    expect(() => resolveAssuranceFixtures({ [BIG_ARTIFACT_BYTES_VAR]: "99999999" })).toThrow(new RegExp(BIG_ARTIFACT_VAR));
  });

  it("refuses a slow set that is not source/set", () => {
    expect(() => resolveAssuranceFixtures({ [SLOW_RECOVERY_SET_VAR]: "nosep" })).toThrow(/source\/set/);
    expect(() => resolveAssuranceFixtures({ [BUILTIN_CHECK_SET_VAR]: "nosep" })).toThrow(/source\/set/);
    expect(resolveAssuranceFixtures({ [BUILTIN_CHECK_SET_VAR]: " e2e/builtin-check " }).builtinCheckSet).toBe("e2e/builtin-check");
  });
});
