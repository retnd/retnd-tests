import { defineConfig, devices } from "@playwright/test";

// Suite C boots its own stack per spec file rather than using a shared
// webServer, because each spec needs its own pair of fixture work
// directories and its own engine over one of them. A shared server would
// put every spec's writes into one backend, which is the opposite of what
// this suite is measuring.
//
// No retries, anywhere. A retry is what turns a deterministic red into
// something that reads as a flake, which is how backupd #172's real
// failure got dismissed twice. An equivalence failure here is a claim about
// the product, and it should be read rather than re-rolled.
export default defineConfig({
  testDir: "./specs",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  // Serial: each spec boots two servers and builds fixtures, and running
  // several at once on one machine turns a state comparison into a
  // measurement of load.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  outputDir: "./test-results",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    trace: "on-first-retry",
    screenshot: "only-on-failure"
  }
});
