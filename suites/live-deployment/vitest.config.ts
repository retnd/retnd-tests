import { defineConfig } from "vitest/config";

// The harness's own unit tests, and the reason they exist at all: three
// small pure functions in here decide whether a run is honest, and none of
// them is exercised by a green suite run. `commitsAgree` is what refuses an
// image that is not the build under test, `scrub` is what keeps a one-time
// token out of a failure message, and `tokenFrom` is what reads the token
// out of the engine's log. A suite run passes without ever taking the
// unhappy branch of any of the three, so the branch that matters is the one
// nothing would notice breaking.
//
// Same split as suites/web-ui: every browser file here is a `.spec.ts`, and
// a `.test.ts` is a unit test of the harness that needs neither Docker nor
// a browser.
export default defineConfig({
  test: {
    include: ["harness/**/*.test.ts"],
    exclude: ["specs/**", "node_modules/**"]
  }
});
