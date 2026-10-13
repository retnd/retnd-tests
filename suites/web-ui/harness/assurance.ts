// What the recovery and assurance specs need from a rig (retnd#986).
//
// The ordinary rig stands up one backup set with three small files and an
// engine nobody can reach into. That is enough to look at EPIC Q's screens
// and not enough to prove them, because three of the things the epic claims
// are about the bytes under the engine and about time:
//
//   - a scrub that FAILS has to be a real changed file, or the chip it
//     replaces was never earned;
//   - a restart in the MIDDLE of a recovery test needs a test long enough to
//     catch;
//   - a browser that leaves MID-DOWNLOAD needs a backup too big to finish
//     before it goes.
//
// This module is this repository's half of the contract for those three. The
// other half is the rig, in the product repository's
// scripts/e2e/three-machine-web-ui.sh, and nothing here assumes it exists:
// every export either reads an environment variable the rig sets or speaks
// the same request/acknowledgement protocol harness/engine.ts documents. A
// spec that needs one says so with needs() and the reason below, which is
// how a run states what it did not do instead of passing against a fixture it
// never had.
//
// # The copy control channel
//
// One directory shared with the host, exactly as the engine control is:
//
//   client  ->  <dir>/corrupt       body: the artifact id (source/set/name)
//   rig     ->  removes it, overwrites the first bytes of that artifact's
//               LOCAL copy in place so the size does not change, then
//               creates <dir>/corrupted (or <dir>/corrupt-failed with a
//               one-line reason)
//   client  ->  <dir>/restore-copy
//   rig     ->  puts every copy it changed back, creates <dir>/copy-restored
//               (or <dir>/restore-failed with a reason)
//
// The size must not change: a scrub that failed because the file got shorter
// would be a size check, and the case exists to catch an implementation that
// is satisfied by one.

import { ask, type EngineControl } from "./engine";

/** The control directory, as the client container sees it. */
export const COPY_CONTROL_VAR = "RETND_COPY_CONTROL";

export const CORRUPT_REQUEST = "corrupt";
export const CORRUPTED_ACK = "corrupted";
export const CORRUPT_FAILED_ACK = "corrupt-failed";
export const RESTORE_REQUEST = "restore-copy";
export const RESTORED_ACK = "copy-restored";
export const RESTORE_FAILED_ACK = "restore-failed";

export const COPY_TIMEOUT_MS = 60_000;

export interface CopyControl {
  readonly dir: string;
}

/** The copy control channel, or null when this run has none. */
export function resolveCopyControl(env: NodeJS.ProcessEnv = process.env): CopyControl | null {
  const dir = (env[COPY_CONTROL_VAR] ?? "").trim();
  return dir === "" ? null : { dir };
}

export const NEEDS_COPY_CONTROL =
  "a rig that can change a copy's bytes under the engine (" +
  COPY_CONTROL_VAR +
  " names its control directory): the product repository's scripts/e2e/three-machine-web-ui.sh, " +
  "which has no such channel yet";

/** Changes the named artifact's local copy in place, keeping its size.
 *  Rejects unless the rig verified it did. */
export async function corruptCopy(
  control: CopyControl,
  artifactId: string,
  timeoutMs: number = COPY_TIMEOUT_MS
): Promise<void> {
  await ask(control as EngineControl, CORRUPT_REQUEST, CORRUPTED_ACK, CORRUPT_FAILED_ACK, timeoutMs, artifactId);
}

/** Puts every copy the rig changed back. */
export async function restoreCopy(control: CopyControl, timeoutMs: number = COPY_TIMEOUT_MS): Promise<void> {
  await ask(control as EngineControl, RESTORE_REQUEST, RESTORED_ACK, RESTORE_FAILED_ACK, timeoutMs);
}

/** Runs `body` with the copy changed and puts it back however `body` ends.
 *
 *  One deployment is shared by every spec in the run, so a copy left changed
 *  by a failing assertion fails every later case that reads that backup, with
 *  errors that say nothing about what broke. The body's own failure is kept
 *  when the restore fails as well: both are said, the body's as the cause. */
export async function withCopyCorrupted<T>(
  control: CopyControl,
  artifactId: string,
  body: () => Promise<T>
): Promise<T> {
  await corruptCopy(control, artifactId);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await body() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  try {
    await restoreCopy(control);
  } catch (restore) {
    if (outcome.ok) throw restore;
    const asserted = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    const restoring = restore instanceof Error ? restore.message : String(restore);
    throw new Error(
      "the case failed AND the copy was not put back, so every later case reads a changed backup.\n" +
        "  the case: " + asserted + "\n  the restore: " + restoring,
      { cause: outcome.error }
    );
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/** The recovery-test set whose validator holds long enough to be caught. */
export const SLOW_RECOVERY_SET_VAR = "RETND_RECOVERY_SLOW_SET";
/** A backup set with no validator whose newest copy is a type the built-in
 *  structure check can read (retnd#1111, retnd-tests#91). */
export const BUILTIN_CHECK_SET_VAR = "RETND_BUILTIN_CHECK_SET";
/** A backup too big for a stream to finish before the browser leaves. */
export const BIG_ARTIFACT_VAR = "RETND_BIG_ARTIFACT";
export const BIG_ARTIFACT_BYTES_VAR = "RETND_BIG_ARTIFACT_BYTES";

/** The smallest backup a mid-stream disconnect can be proved on.
 *
 *  A download streams 4 MiB at a time and the proxy and the sockets between
 *  the engine and the browser buffer a few more, so a backup that fits in
 *  those buffers is fully written before the client can leave, and the
 *  outcome is "completed" however the client behaves. Thirty-two MiB is
 *  eight chunks past anything those buffers hold. */
export const MIN_STREAM_BYTES = 32 * 1024 * 1024;

export interface AssuranceFixtures {
  /** `source/set`, or null when the rig has no slow recovery test. */
  readonly slowRecoverySet: string | null;
  /** `source/set`, or null when the rig has no set the built-in check can read. */
  readonly builtinCheckSet: string | null;
  readonly bigArtifact: { readonly id: string; readonly bytes: number } | null;
}

/** Reads the fixtures the rig names, and refuses a half-described one.
 *
 *  An id without a size, or a size too small to prove anything, throws
 *  rather than skipping: a rig that said it had a big artifact and gave a
 *  small one would otherwise pass the disconnect case against a stream that
 *  had already finished. */
export function resolveAssuranceFixtures(env: NodeJS.ProcessEnv = process.env): AssuranceFixtures {
  const slow = (env[SLOW_RECOVERY_SET_VAR] ?? "").trim();
  if (slow !== "" && slow.split("/").length !== 2) {
    throw new Error(SLOW_RECOVERY_SET_VAR + " is " + JSON.stringify(slow) + ", which is not source/set");
  }
  const builtin = (env[BUILTIN_CHECK_SET_VAR] ?? "").trim();
  if (builtin !== "" && builtin.split("/").length !== 2) {
    throw new Error(BUILTIN_CHECK_SET_VAR + " is " + JSON.stringify(builtin) + ", which is not source/set");
  }
  const id = (env[BIG_ARTIFACT_VAR] ?? "").trim();
  const rawBytes = (env[BIG_ARTIFACT_BYTES_VAR] ?? "").trim();
  if (id === "" && rawBytes !== "") {
    throw new Error(BIG_ARTIFACT_BYTES_VAR + " is set but " + BIG_ARTIFACT_VAR + " names no artifact");
  }
  let bigArtifact: AssuranceFixtures["bigArtifact"] = null;
  if (id !== "") {
    const bytes = Number(rawBytes);
    if (rawBytes === "" || !Number.isFinite(bytes)) {
      throw new Error(BIG_ARTIFACT_VAR + " names " + id + " but " + BIG_ARTIFACT_BYTES_VAR + " does not give its size");
    }
    if (bytes < MIN_STREAM_BYTES) {
      throw new Error(
        id + " is " + String(bytes) + " bytes, which is too small to be caught mid-stream (the floor is " +
          String(MIN_STREAM_BYTES) + ")"
      );
    }
    bigArtifact = { id, bytes };
  }
  return { slowRecoverySet: slow === "" ? null : slow, builtinCheckSet: builtin === "" ? null : builtin, bigArtifact };
}

export const NEEDS_SLOW_RECOVERY_SET =
  "a backup set whose recovery-test validator holds for tens of seconds (" + SLOW_RECOVERY_SET_VAR +
  " names it as source/set), which the rig does not seed yet";

export const NEEDS_BIG_ARTIFACT =
  "a backup of at least 32 MiB (" + BIG_ARTIFACT_VAR + " and " + BIG_ARTIFACT_BYTES_VAR +
  " name it), because a small one finishes streaming before a browser can leave; the rig seeds three small files";

export const NEEDS_BUILTIN_CHECK_SET =
  "a backup set with no validator whose newest copy is a .tar.gz, .tar.zst, .gz, .zst or .tar (" + BUILTIN_CHECK_SET_VAR +
  " names it as source/set), which the rig does not seed yet";
