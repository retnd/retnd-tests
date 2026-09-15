// The parts of the sign-in handshake that can be read without a
// deployment.
//
// The handshake itself needs a service to shake hands with, and this
// repository does not stand one up in a unit test. What CAN be pinned here
// is the shape of the thing: the cookie names and the two header names are
// the whole double-submit contract, they are written down in this suite
// rather than imported from the product, and a copy written down in two
// places is a copy that drifts.
//
// It drifted. backupd#794 renamed `bm_csrf` to `backupd_csrf` and
// `bm_session` to `backupd_session`; this suite kept asking for the old
// names, and the cases below used to assert that it did. Every browser
// case in Suite B then failed inside the worker fixture with "GET / set no
// bm_csrf cookie" before it could assert anything about the product, and
// nothing said so until the suite was pointed at a current build.
//
// EPIC R (backupd#885) is the same rename a third time, and the shape that
// survived the second one is what makes the third one uneventful: the
// suite reads every accepted name and prefers the newest, so the only
// thing that moved was which name is newest.
//
// The lesson these cases carry is that pinning a constant against a
// string literal only proves the suite agrees with itself. So what is
// pinned here is the BEHAVIOUR the drift needed: every name the product
// accepts is known, the newest is preferred, and the older ones still
// read, which is exactly what apps/common/csrf's `cookieNames`,
// apps/common/auth/local's `sessionCookieNames` and
// ui/shared/src/api/client.ts each do.

import { describe, expect, it } from "vitest";

import {
  BOOTSTRAP_HEADER,
  CSRF_COOKIE,
  CSRF_COOKIE_NAMES,
  CSRF_HEADER,
  EARLIER_CSRF_COOKIE,
  EARLIER_SESSION_COOKIE,
  LEGACY_CSRF_COOKIE,
  LEGACY_SESSION_COOKIE,
  SESSION_COOKIE,
  SESSION_COOKIE_NAMES,
  cookieValue,
  csrfCookieValue,
  sessionCookieValue
} from "./session";

/** Only the two fields these helpers read. Playwright's Cookie carries
 *  four more that a browser fills in and that nothing here looks at, so
 *  the cast is through unknown rather than pretending they are present. */
function jar(...pairs: Array<[string, string]>): Parameters<typeof cookieValue>[0] {
  return pairs.map(([name, value]) => ({ name, value })) as unknown as Parameters<
    typeof cookieValue
  >[0];
}

describe("the names the handshake is made of", () => {
  it("matches apps/common/csrf's double-submit pair", () => {
    expect(CSRF_COOKIE).toBe("retnd_csrf");
    expect(CSRF_HEADER).toBe("X-CSRF-Token");
  });

  it("matches apps/common/auth/local's session cookie and bootstrap header", () => {
    expect(SESSION_COOKIE).toBe("retnd_session");
    expect(BOOTSTRAP_HEADER).toBe("X-Bootstrap-Token");
  });

  it("still knows what both cookies were called before EPIC R and before backupd#794", () => {
    expect(LEGACY_CSRF_COOKIE).toBe("backupd_csrf");
    expect(LEGACY_SESSION_COOKIE).toBe("backupd_session");
    expect(EARLIER_CSRF_COOKIE).toBe("bm_csrf");
    expect(EARLIER_SESSION_COOKIE).toBe("bm_session");
  });

  it("lists every accepted name newest first, like apps/common/csrf's cookieNames", () => {
    // The ORDER is the contract, not just the membership: the read below
    // returns the first name it finds, so a list in any other order
    // answers with a stale token on a jar that holds two.
    expect([...CSRF_COOKIE_NAMES]).toEqual(["retnd_csrf", "backupd_csrf", "bm_csrf"]);
    expect([...SESSION_COOKIE_NAMES]).toEqual(["retnd_session", "backupd_session", "bm_session"]);
  });
});

describe("reading the handshake's cookies out of a jar", () => {
  it("reads the names a current build issues", () => {
    expect(csrfCookieValue(jar(["retnd_csrf", "csrf-value"]))).toBe("csrf-value");
    expect(sessionCookieValue(jar(["retnd_session", "session-value"]))).toBe("session-value");
  });

  it("reads the names a build from before either rename issues", () => {
    // The half that lets this suite be pointed at an older image and
    // report on the product rather than dying in a fixture.
    expect(csrfCookieValue(jar(["backupd_csrf", "pre-epic-r-csrf"]))).toBe("pre-epic-r-csrf");
    expect(sessionCookieValue(jar(["backupd_session", "pre-epic-r-session"]))).toBe(
      "pre-epic-r-session"
    );
    expect(csrfCookieValue(jar(["bm_csrf", "old-csrf"]))).toBe("old-csrf");
    expect(sessionCookieValue(jar(["bm_session", "old-session"]))).toBe("old-session");
  });

  it("prefers the newest name when a jar holds more than one", () => {
    // A jar mid-rename. The newest name is the one the service just set,
    // and it is the one ui/shared/src/api/client.ts echoes. Asserted
    // across all three, because a two-name preference that happens to
    // work says nothing about which of the two older ones wins.
    const all = jar(["bm_csrf", "oldest"], ["backupd_csrf", "older"], ["retnd_csrf", "new"]);
    expect(csrfCookieValue(all)).toBe("new");
    expect(csrfCookieValue(jar(["bm_csrf", "oldest"], ["backupd_csrf", "older"]))).toBe("older");
    const sessions = jar(["bm_session", "oldest"], ["backupd_session", "older"]);
    expect(sessionCookieValue(sessions)).toBe("older");
  });

  it("answers with an empty string when no accepted name is there, never undefined", () => {
    // Every caller compares against "" to decide whether the handshake got
    // anywhere, and a caller that had to check for undefined too is a
    // caller that will forget.
    expect(csrfCookieValue(jar(["something_else", "value"]))).toBe("");
    expect(sessionCookieValue(jar())).toBe("");
  });
});

describe("reading one named cookie out of a jar", () => {
  const cookies = jar(["retnd_csrf", "csrf-value"], ["retnd_session", "session-value"]);

  it("finds the one it is asked for", () => {
    expect(cookieValue(cookies, "retnd_session")).toBe("session-value");
  });

  it("does not match a cookie by prefix", () => {
    expect(cookieValue(cookies, "retnd_")).toBe("");
  });
});
