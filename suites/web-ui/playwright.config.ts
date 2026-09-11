import { defineConfig, devices } from "@playwright/test";

import {
  resolveArtifactPaths,
  resolveChromiumArgs,
  resolveDeployment,
  resolveWorkers
} from "./harness/deployment";

// Suite B: the Web UI, against a real deployment this run did not create.
//
// # This config starts nothing, and that is the change
//
// It used to run `npm run dev -- --port <n> --strictPort` against a
// `ui/shared` checkout, which meant the app under test was the Vite dev
// server, and `ui/shared/src/app/createApp.tsx` wires `createMockApi`
// under `import.meta.env.DEV`. So every `?scenario=` state the specs drove
// was a fixture inside the browser. The suite proved the UI renders
// correctly given data, and structurally could not fail on anything in the
// path an operator actually uses: browser -> `backupd-web serve-ui` ->
// reverse proxy -> `backupd-web serve` -> SQLite.
//
// That gap cost something real. backupd#598 was the Activity page
// erroring in a browser while the server answered 200 with 64KB of valid
// JSON in 20ms, and the spec beside it that drives the same page happily
// passed, because the mock resolved every call cleanly.
//
// So there is no `webServer` block below. The deployment is four
// containers over three networks, stood up before this runner starts, and
// the runner itself is inside it: Playwright and the browser both run in a
// client container, and `baseURL` is another container's NAME, resolved by
// Docker's embedded DNS. It is not localhost, and it is not a published
// host port.
//
// The topology is worth knowing about here, because one part of it is load
// bearing for what this suite can claim. `backupd` is an alias on
// the EDGE network only, and the engine sits on an internal network the
// client cannot resolve at all: a spec that tried to fetch the engine
// directly gets ENOTFOUND. So every request this suite makes, from a page
// or from an arrange step, goes through `serve-ui` and the reverse-proxy
// hop into `serve`. That hop is exactly the part the dev server had no
// equivalent of, and it is now impossible to accidentally skip.
//
// `reuseExistingServer` is gone with the block it belonged to. The
// property it bought is not: a run here still never reports on a server it
// cannot name. It just buys it a different way now, by refusing to start
// without `RM_BASE_URL` rather than by refusing to adopt a listener.
// A default of `http://localhost:5173` would be the same defect the old
// `reuseExistingServer: true` was, wearing a different hat: a run that
// reports green against whatever happened to answer.
//
// # One worker, no retries
//
// One deployment is one SQLite database and every spec shares it. Several
// browsers at once turns an assertion about a count into an assertion
// about what another worker was doing at the time. See resolveWorkers.
//
// Retries stay at zero, including under CI. A retry is what turns a
// deterministic red into something that reads as a flake, which is the
// mistake backupd#172 cost four merges to notice.
//
// # Traces are on, where they used to be on-first-retry
//
// A failure here happens inside a container, on a private network, against
// a deployment that is gone by the time anybody reads the report. Nobody
// can reproduce it by hand. So the trace, the video and the screenshot are
// all kept on failure and written to `RM_ARTIFACTS_DIR`, which the client
// container mounts out so the evidence survives teardown.
// `on-first-retry` would never fire at all with retries at zero, so it
// would have been a rule that quietly did nothing.
const deployment = resolveDeployment();
const { outputDir, htmlReport } = resolveArtifactPaths();

// Once, from the runner process (workers re-load this file, and Playwright
// stamps TEST_WORKER_INDEX into theirs). A run that passes should have
// said out loud what it passed against, and a run that cannot reach the
// deployment should name the URL it could not reach. The password is not
// in here, and never is.
if (process.env.TEST_WORKER_INDEX === undefined) {
  console.log("e2e: deployment under test is " + deployment.baseURL);
  console.log("e2e: signing in as " + deployment.credentials.username);
  console.log("e2e: the image under test serves the " + deployment.platform + " bundle");
  if (deployment.seededBackupSet) {
    console.log("e2e: the topology seeded backup set " + deployment.seededBackupSet);
  }
  console.log("e2e: failure evidence goes to " + outputDir + ", report to " + htmlReport);
  if (deployment.source) {
    console.log("e2e: source machine is " + deployment.source.user + "@" + deployment.source.host);
  }
}

export default defineConfig({
  testDir: "./e2e",
  // Every browser spec here is a `.spec.ts`; Playwright's default
  // testMatch also collects `.test.ts`, which is how a vitest unit test
  // living next to what it tests ended up being handed to Playwright and
  // failing on `import "vitest"`.
  testMatch: /\.spec\.ts$/,
  // Generous where the old one was tight. Every navigation is a real
  // round trip through a reverse proxy to a Go process reading SQLite,
  // and some of these pages fetch four resources before they render.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: resolveWorkers(),
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Both under RM_ARTIFACTS_DIR, and both a level below it. The client
  // container mounts the tests checkout at /suite, so a report written
  // beside the specs would land in somebody's git status; and Playwright
  // removes its own outputDir on startup, which a bind mount cannot
  // survive. resolveArtifactPaths has the whole story.
  //
  // ./harness/skips-reporter.ts is on every run, CI or not, and it is not
  // decoration. Three helpers in e2e/fixtures.ts decline to assert and say
  // why, and the whole argument for them over deleting a case is that the
  // reason reaches a reader. Playwright's list reporter prints a bare `-`
  // and keeps the reason in an annotation only the HTML and JSON
  // reporters render, so without this the suite's skips are exactly the
  // silent gap this repository exists to argue against.
  reporter: process.env.CI
    ? [
        ["github"],
        ["list"],
        ["./harness/skips-reporter.ts"],
        ["html", { open: "never", outputFolder: htmlReport }]
      ]
    : [["list"], ["./harness/skips-reporter.ts"]],
  outputDir,

  use: {
    baseURL: deployment.baseURL,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
    // Bounded, where Playwright's defaults are not. An action with no
    // timeout of its own is bounded only by the test's, so one locator
    // that never resolves spends the whole budget and then reports a test
    // timeout instead of naming the control it was waiting for.
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    // Standard desktop NAS administration window (§31).
    viewport: { width: 1440, height: 900 },
    launchOptions: { args: resolveChromiumArgs() }
  },

  projects: [
    {
      name: "generic",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }
    },
    {
      // One provider, not seven. The bundle is chosen when the image is
      // built (VITE_PLATFORM, and `serve-ui --profile`), so a deployment
      // serves exactly one of them and no amount of configuration here
      // reaches the others. `RM_PLATFORM` DESCRIBES which one this
      // deployment is; the seven-provider sweep the old
      // `scripts/e2e-all-providers.mjs` did by restarting Vite has no
      // equivalent against a real image and is not pretended at.
      name: "provider",
      testMatch: /provider-treatment\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] }
    },
    {
      name: "small-window",
      testMatch: /responsive\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 940, height: 720 } }
    }
  ]
});
