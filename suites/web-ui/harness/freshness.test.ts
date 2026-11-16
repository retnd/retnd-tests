// The freshness pattern the safety-invariants spec waits for. The spec went
// red on a rig whose newest backup was one minute old, because the page said
// "1 minute ago" and the pattern only knew the plural.

import { describe, expect, it } from "vitest";

import { FRESHNESS_AGE } from "./freshness";

describe("FRESHNESS_AGE", () => {
  it.each(["1 minute ago", "5 minutes ago", "1 hour ago", "3 hours ago", "4 days ago"])(
    "reads %s as an age",
    (text) => {
      expect(FRESHNESS_AGE.test(text)).toBe(true);
    }
  );

  it.each(["2026-11-14", "14 Nov 17:52", "never", "Newest verified backup"])(
    "does not read %s as an age",
    (text) => {
      expect(FRESHNESS_AGE.test(text)).toBe(false);
    }
  );
});
