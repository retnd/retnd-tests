// Keeping the one-time enrolment token, and the administrator password
// this run makes up, out of everywhere they must not be.
//
// The rule from issue #43 is that the token never reaches a file, an argv
// where `ps` can see it, or this suite's output. Two of those three are
// settled by construction elsewhere: the token is read out of the engine's
// log into a variable (never written down), and nothing passes it to a
// child process (`docker logs` takes a container name and nothing else).
//
// The third is not settled by construction, and this file is why it needs
// help. A browser suite carries the token in a URL, and Playwright puts the
// URL of a failed navigation into the error it raises. So a `page.goto`
// that times out would print the one-time token into the run's own output,
// on the one run where somebody is definitely reading the output. Every
// step that touches the token therefore goes through `redacting`, which
// scrubs both the message and the stack before the error is allowed to
// leave.
//
// This is a narrow fix by design rather than a global one. Scrubbing the
// process's stdout wholesale would also hide a token that leaked somewhere
// nobody expected, which is a bug worth seeing rather than papering over.

import { randomBytes } from "node:crypto";

export const REDACTED = "[redacted]";

/** Replaces every occurrence of every secret with a marker.
 *
 *  Empty and very short secrets are ignored on purpose: a one-character
 *  "secret" would turn the text into a wall of markers and destroy the
 *  failure message it was supposed to be protecting. Nothing this suite
 *  passes in is short; the guard is there so that a future caller handing
 *  in an empty string gets readable output rather than nonsense. */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

/** Runs a step that handles a secret, and makes sure a failure inside it
 *  cannot carry the secret out.
 *
 *  The error is replaced rather than mutated: Playwright's own errors carry
 *  extra properties (a call log, a matcher result) that can hold the same
 *  text, and rewriting `message` on the original would leave those intact.
 *  What survives is the message and the stack, scrubbed, which is what a
 *  reader needs to find the failing line. */
export async function redacting<T>(secrets: readonly string[], step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    const original = err instanceof Error ? err : new Error(String(err));
    const clean = new Error(scrub(original.message, secrets));
    clean.stack = scrub(original.stack ?? clean.stack ?? "", secrets);
    clean.name = original.name;
    throw clean;
  }
}

/** The administrator password this run enrols with.
 *
 *  Generated per run, held in a variable, and never written anywhere: not
 *  to a file, not into argv, not into the report. It exists for the length
 *  of one deployment that is deleted minutes later. Long enough to clear
 *  the enrolment form's own twelve-character minimum with room to spare. */
export function newPassword(): string {
  return `live-${randomBytes(18).toString("base64url")}`;
}

/** A container log with the one-time token taken out of it.
 *
 *  Every place this suite puts a log into a message goes through here, and
 *  the reason is a shape that is easy to miss: a failure that is NOT about
 *  the token (the engine came up and then failed its liveness probe, say)
 *  still quotes a log that has a live token in it, into the output of the
 *  run somebody is about to read. The token is found the same way the
 *  harness finds it for real, so the two cannot disagree about what a token
 *  looks like.
 *
 *  Also what `Manager.engineLog` hands a spec, so a spec that prints the
 *  engine's log while working something out cannot leak it either. The
 *  harness reads the raw log for exactly one purpose, which is finding the
 *  token in the first place. */
export function redactLog(text: string): string {
  const token = tokenFrom(text);
  return token === null ? text : scrub(text, [token]);
}

/** Reads the one-time enrolment token out of what the engine printed.
 *
 *  Two shapes, because the engine prints one or the other depending on
 *  whether it was told a public base URL (apps/common/auth/local's
 *  PrintBootstrapNotice). This suite always sets one, so the link form is
 *  what a run actually sees; the bare form is read too, so the harness
 *  keeps working against a deployment configured without it rather than
 *  failing with "no token" against a log that plainly has one.
 *
 *  Returns null rather than throwing, so the caller can say what it was
 *  waiting for. The token is the return value and nothing else: this
 *  function never logs, and its own error paths never quote the log. */
export function tokenFrom(engineLog: string): string | null {
  const link = /\/enroll\?token=(\S+?)(?:\s|"|$)/.exec(engineLog);
  if (link) return link[1];
  const bare = /Enrollment bootstrap token: (\S+)/.exec(engineLog);
  if (bare) return bare[1];
  return null;
}
