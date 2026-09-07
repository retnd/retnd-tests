import { defineConfig, devices } from "@playwright/test";

// Suite D: the operator's path through the Web UI, against a real
// deployment.
//
// # There is no webServer, and that is the point
//
// suites/web-ui runs `npm run dev` and keeps `reuseExistingServer` an
// unconditional false, with its config explaining what a stale dev server
// on a shared port once cost. Here the app is not a dev server at all: it
// is the shipped image, running as two containers plus a real SFTP source
// on a private network, all named after this run.
//
// The hazard that rule exists for gets worse with containers rather than
// better. A leftover container from another checkout answers on its port,
// reports healthy, and serves a different build, and there is no dev-server
// banner to notice it by. So the same refusal is enforced three ways here:
// every name carries a per-run id, `Run.claimContainer` refuses a name that
// already exists instead of adopting it, and the one published port is
// probed free and then bound by a container this run starts, so losing that
// race is a start failure rather than a run that reports on somebody
// else's deployment. On top of that the image is made to state its own
// commit before any test runs.
//
// # Serial, and no retries
//
// One test is one whole deployment: three containers, a network, three
// volumes. Running several at once turns an end-to-end proof into a
// measurement of how loaded the machine is, and this suite already has real
// waits on real services.
//
// Retries stay at zero for the reason suites/equivalence gives: a retry is
// what turns a deterministic red into something that reads as a flake. A
// failure here is a claim about the product or about a machine that could
// not perform the proof, and both should be read rather than re-rolled.
export default defineConfig({
  testDir: "./specs",
  // Every browser file here is a `.spec.ts`; a `.test.ts` is a unit test of
  // the harness and belongs to vitest, not to Playwright.
  testMatch: /\.spec\.ts$/,
  // A test boots a deployment before it asserts anything. On a cold Docker
  // cache the image build happens once, in globalSetup, outside this
  // budget; what is inside it is three container starts, an sshd coming up
  // and a browser.
  timeout: 300_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  outputDir: "./test-results",

  // Refuses the run when Docker is missing, and prints which image is under
  // test. Failing here fails the run, which is the honest verdict: this
  // suite has no meaningful half-measure between "deployed it and drove it"
  // and "could not deploy it".
  globalSetup: "./harness/preflight.ts",

  use: {
    ...devices["Desktop Chrome"],
    // Bounded, where Playwright's default is not. An action with no timeout
    // is bounded only by the test's own, so one locator that never resolves
    // spends the whole five-minute budget and then reports a test timeout
    // instead of naming the control it was waiting for. Every wait in this
    // suite says what it was waiting for; these two are the ones Playwright
    // would otherwise leave open.
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
    // Standard desktop NAS administration window, matching Suite B.
    viewport: { width: 1440, height: 900 },
    // Off, deliberately, where the other suites say "on-first-retry". A
    // trace records every navigation URL, and the enrolment URL carries the
    // one-time bootstrap token. With retries at zero "on-first-retry" would
    // never fire anyway, so this is saying the rule rather than relying on
    // a coincidence that another edit could remove.
    trace: "off",
    video: "off",
    // A screenshot of the page, which has no address bar in it and never
    // renders the token.
    screenshot: "only-on-failure"
  }
});
