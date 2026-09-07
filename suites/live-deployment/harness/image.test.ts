import { describe, expect, it } from "vitest";

import { commitsAgree } from "./image";

// The rule that decides whether the image this run deployed is the build the
// pin promised. It is a restatement of tools/getbuild/handshake.go's
// commitsAgree, because the Go one identifies a binary on the host and this
// one identifies an image, and a restatement nobody tests is a copy waiting
// to disagree with its original.
//
// The cases that matter most are the ones where it has to say NO. A
// handshake that accepts everything is not a handshake, and this repository
// already has the story of a green run against a build nobody meant to test.
describe("commitsAgree", () => {
  const full = "d2f43738c634da883d192d05f4de5f6790e7f387";

  it("accepts the same commit spelled the same way", () => {
    expect(commitsAgree(full, full)).toBe(true);
  });

  it("accepts an abbreviation in either direction", () => {
    expect(commitsAgree(full, "d2f4373")).toBe(true);
    expect(commitsAgree("d2f4373", full)).toBe(true);
  });

  it("accepts a build made from a modified tree", () => {
    expect(commitsAgree(full + "-dirty", full)).toBe(true);
    expect(commitsAgree(full, full + "-dirty")).toBe(true);
  });

  it("refuses a different commit", () => {
    expect(commitsAgree(full, "9e6101d525684e4f2ec97b1b37f141eb3a6fa93a")).toBe(false);
  });

  it("refuses a commit that shares a prefix and then diverges", () => {
    // The case a naive `startsWith` on the short side would wave through if
    // the abbreviation were allowed to be arbitrarily short.
    expect(commitsAgree("d2f4373aaaaaaa", "d2f4373bbbbbbb")).toBe(false);
  });

  it("refuses an answer too short to be one", () => {
    // git's shortest abbreviation is seven characters, so anything shorter
    // is not an identification. "none" is what an unstamped build reports,
    // and it must never look like agreement.
    expect(commitsAgree("none", full)).toBe(false);
    expect(commitsAgree(full, "none")).toBe(false);
    expect(commitsAgree("d2f437", full)).toBe(false);
    expect(commitsAgree("", "")).toBe(false);
  });
});
