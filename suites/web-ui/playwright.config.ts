import { defineConfig, devices } from "@playwright/test";

import { resolvePort, resolveUiDir } from "./harness/under-test";

// The migrated form of rclone-manager's ui/shared/playwright.config.ts.
// Everything under e2e/ is byte-identical to that repository's
// ui/shared/e2e/ at the migration commit, and this file is where the
// permitted deltas live, all of them about WHERE the app comes from rather
// than what is asserted about it:
//
//   1. the app under test is resolved from RM_UI_DIR / RM_SOURCE_DIR / the
//      pin instead of being "the directory this config sits in";
//   2. the derived port is derived from the checkout the APP is in, not the
//      checkout the config is in, because out here those are two different
//      repositories and only the first one varies per concurrent run;
//   3. the port is additionally probed free before Vite is asked for it;
//   4. the dev server is spawned with cwd set to the app under test;
//   5. reporter and output paths are local to this suite.
//
// Not a delta: reuseExistingServer stays an unconditional false, and
// --strictPort stays. A run here never adopts a server it did not start.
const UI_DIR = resolveUiDir();
const PORT = resolvePort(UI_DIR);
const BASE_URL = "http://localhost:" + PORT;

// Once, from the runner process (workers re-load this file and Playwright
// stamps TEST_WORKER_INDEX into theirs). A run that cannot bind should be
// able to say which port it could not bind, and a run that passes should
// have said out loud which tree it passed against.
if (process.env.TEST_WORKER_INDEX === undefined) {
  console.log("e2e: app under test is " + UI_DIR);
  console.log("e2e: serving it on " + BASE_URL);
}

/** The suite runs against the mock API (`npm run dev`), which is deterministic
 *  and covers every documented state. Provider projects re-run the shell specs
 *  against each platform bridge so provider treatment cannot regress.
 *
 *  Worth being blunt about, because the move makes it easy to assume
 *  otherwise: this is a mock-backed suite. ui/shared/src/app/createApp.tsx
 *  wires createMockApi under import.meta.env.DEV, and this config runs the
 *  dev server, so every `?scenario=` state the specs drive is a fixture in
 *  the browser rather than a backend. Proving the same product behaviour
 *  against the real built app and a real engine is Suite C's job, not this
 *  one's, and some scenarios here (storage-critical, version-mismatch) are
 *  unreachable on a real backend by design. */
export default defineConfig({
  testDir: "./e2e",
  // Every browser spec here is a `.spec.ts`; Playwright's default testMatch
  // also collects `.test.ts`, which is how e2e/port.test.ts (a vitest unit
  // test of the suite's own port helper, living next to what it tests)
  // ended up being handed to Playwright and failing on `import "vitest"`.
  testMatch: /\.spec\.ts$/,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  outputDir: "./test-results",

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    // Standard desktop NAS administration window (§31).
    viewport: { width: 1440, height: 900 }
  },

  projects: [
    {
      name: "generic",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }
    },
    {
      // Only the provider-treatment spec runs per provider; shared product
      // behaviour is proven once, not seven times (§44).
      name: "providers",
      testMatch: /provider-treatment\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] }
    },
    {
      name: "small-window",
      testMatch: /responsive\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 940, height: 720 } }
    }
  ],

  webServer: {
    // --strictPort: fail rather than quietly slide to the next free port,
    // which would leave the suite pointing at BASE_URL with nothing there.
    command: "npm run dev -- --port " + PORT + " --strictPort",
    cwd: UI_DIR,
    url: BASE_URL,
    // Never adopt a server this run did not start. This used to be
    // `!process.env.CI` in the old home, which meant that locally, whatever
    // happened to be listening answered the suite, including a dev server
    // started from a different worktree serving a different build. That is
    // what made rclone-manager #172 look like an ordering flake. The move
    // out here makes the hazard worse rather than better (one tests-repo
    // checkout can be pointed at many product checkouts), so this stays
    // false unconditionally and has no environment variable that opens it.
    reuseExistingServer: false,
    timeout: 60_000
  }
});
