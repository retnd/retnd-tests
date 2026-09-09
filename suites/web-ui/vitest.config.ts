import { defineConfig } from "vitest/config";

// The harness's own unit tests. They used to be the port helper's and the
// seven-provider spawner's; both of those existed to serve a Vite dev
// server this suite no longer starts, and they went with it. What replaced
// them reads the same kind of thing one layer up: which deployment a run
// resolves out of its environment, what it refuses, and the names the
// sign-in handshake is made of.
//
// The exclusion is unchanged, and so is its reason: every Playwright file
// under e2e/ is a `.spec.ts`, and a `.test.ts` anywhere in this suite is a
// unit test of the harness rather than a browser test.
export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts", "harness/**/*.test.ts"],
    exclude: ["e2e/**/*.spec.ts", "node_modules/**"]
  }
});
