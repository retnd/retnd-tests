import { describe, expect, it } from "vitest";

import { REDACTED, redacting, scrub, tokenFrom } from "./secrets";

// The three properties that keep a one-time token out of places it must not
// reach. None of them is exercised by a passing suite run: a green run never
// throws, so `redacting` never scrubs anything, and the branch that matters
// is the one nothing would notice breaking.

describe("scrub", () => {
  it("replaces every occurrence, not only the first", () => {
    const secret = "abcdefghijklmnop";
    expect(scrub(`goto ${secret} failed at ${secret}`, [secret])).toBe(`goto ${REDACTED} failed at ${REDACTED}`);
  });

  it("finds the secret inside a URL, which is the shape that actually leaks", () => {
    const secret = "S3cr3tT0k3nValue";
    const text = `page.goto: net::ERR_ABORTED at http://127.0.0.1:5931/enroll?token=${secret}`;
    expect(scrub(text, [secret])).not.toContain(secret);
    expect(scrub(text, [secret])).toContain("/enroll?token=" + REDACTED);
  });

  it("leaves everything else alone, so a failure is still readable", () => {
    const text = "Timed out waiting for locator('button')";
    expect(scrub(text, ["abcdefghijklmnop"])).toBe(text);
  });

  it("ignores a secret too short to replace without destroying the text", () => {
    // A one-character "secret" would turn every message into markers. The
    // guard is not for anything this suite passes in; it is so that a future
    // caller handing in an empty string gets readable output rather than
    // nonsense.
    expect(scrub("a very ordinary message", ["a"])).toBe("a very ordinary message");
    expect(scrub("a very ordinary message", [""])).toBe("a very ordinary message");
  });
});

describe("redacting", () => {
  it("returns what the step returns when nothing goes wrong", async () => {
    await expect(redacting(["abcdefghijklmnop"], async () => 42)).resolves.toBe(42);
  });

  it("scrubs the message of an error thrown inside it", async () => {
    const secret = "abcdefghijklmnop";
    await expect(
      redacting([secret], async () => {
        throw new Error(`could not open /enroll?token=${secret}`);
      })
    ).rejects.toThrow(`could not open /enroll?token=${REDACTED}`);
  });

  it("scrubs the stack as well as the message", async () => {
    const secret = "abcdefghijklmnop";
    let seen: Error | undefined;
    try {
      await redacting([secret], async () => {
        const err = new Error("nothing sensitive here");
        err.stack = `Error: nothing sensitive here\n    at goto(http://x/enroll?token=${secret})`;
        throw err;
      });
    } catch (err) {
      seen = err as Error;
    }
    expect(seen?.stack).toBeDefined();
    expect(seen?.stack).not.toContain(secret);
  });

  it("scrubs a thrown non-Error too", async () => {
    const secret = "abcdefghijklmnop";
    await expect(redacting([secret], async () => Promise.reject(`raw string with ${secret}`))).rejects.toThrow(
      `raw string with ${REDACTED}`
    );
  });
});

describe("tokenFrom", () => {
  // Both shapes apps/common/auth/local's PrintBootstrapNotice can print. The
  // link form is what a run actually sees, because this suite always tells
  // the engine its public base URL; the bare form is read too, so a
  // deployment configured without one is not reported as having printed no
  // token at all.
  it("reads the token out of the printed link", () => {
    expect(
      tokenFrom(
        "backup-manager: no administrator account exists yet. Open http://127.0.0.1:5931/enroll?token=abc123XYZ to create one (valid 30 minutes, single use).\n"
      )
    ).toBe("abc123XYZ");
  });

  it("reads the bare token form", () => {
    expect(
      tokenFrom(
        "backup-manager: no administrator account exists yet. Enrollment bootstrap token: abc123XYZ (valid 30 minutes, single use).\n"
      )
    ).toBe("abc123XYZ");
  });

  it("finds it among other log lines", () => {
    const log = [
      "backup-manager-web: starting",
      "backup-manager: no administrator account exists yet. Open http://127.0.0.1:5931/enroll?token=tok-9 to create one (valid 30 minutes, single use).",
      "backup-manager-web: listening on :8080"
    ].join("\n");
    expect(tokenFrom(log)).toBe("tok-9");
  });

  it("answers null rather than something wrong when there is no notice", () => {
    expect(tokenFrom("backup-manager-web: listening on :8080\n")).toBeNull();
    expect(tokenFrom("")).toBeNull();
  });
});
