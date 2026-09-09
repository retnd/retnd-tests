// The parts of the sign-in handshake that can be read without a
// deployment.
//
// The handshake itself needs a service to shake hands with, and this
// repository does not stand one up in a unit test. What CAN be pinned here
// is the shape of the thing: the two cookie names and the two header names
// are the whole double-submit contract, they are written down in this
// suite rather than imported from the product, and a copy written down in
// two places is a copy that drifts. These cases are what makes a drift
// noisy: apps/common/csrf renaming CookieName, or apps/common/auth/local
// renaming its session cookie, turns the suite red here with the old and
// new names side by side, rather than turning every browser spec red with
// "the section nav never appeared".

import { describe, expect, it } from "vitest";

import { BOOTSTRAP_HEADER, CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, cookieValue } from "./session";

describe("the names the handshake is made of", () => {
  it("matches apps/common/csrf's double-submit pair", () => {
    expect(CSRF_COOKIE).toBe("bm_csrf");
    expect(CSRF_HEADER).toBe("X-CSRF-Token");
  });

  it("matches apps/common/auth/local's session cookie and bootstrap header", () => {
    expect(SESSION_COOKIE).toBe("bm_session");
    expect(BOOTSTRAP_HEADER).toBe("X-Bootstrap-Token");
  });
});

describe("reading a cookie out of a jar", () => {
  // Only the two fields this helper reads. Playwright's Cookie carries
  // four more that a browser fills in and that nothing here looks at, so
  // the cast is through unknown rather than pretending they are present.
  const jar = [
    { name: "bm_csrf", value: "csrf-value" },
    { name: "bm_session", value: "session-value" }
  ] as unknown as Parameters<typeof cookieValue>[0];

  it("finds the one it is asked for", () => {
    expect(cookieValue(jar, "bm_session")).toBe("session-value");
  });

  // The empty string rather than undefined, and it matters: every caller
  // compares against "" to decide whether the handshake got anywhere, and
  // a caller that had to remember to check for undefined too is a caller
  // that will forget.
  it("answers with an empty string when it is not there, never undefined", () => {
    expect(cookieValue(jar, "bm_nothing")).toBe("");
  });

  it("does not match a cookie by prefix", () => {
    expect(cookieValue(jar, "bm_")).toBe("");
  });
});
