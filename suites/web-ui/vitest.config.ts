import { defineConfig } from "vitest/config";

// Two unit tests moved with the code they test: e2e/port.test.ts, which
// pins the port helper's E2E_PORT validation, and
// scripts/e2e-all-providers.test.ts, which reads back what the seven-provider
// spawner actually hands each run. In the old home ui/shared's
// vite.config.ts ran both; here they need their own runner, and the same
// exclusion, for the same reason: every Playwright file under e2e/ is a
// `.spec.ts`, and a `.test.ts` anywhere in this suite is a unit test of the
// harness rather than a browser test.
export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts", "harness/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["e2e/**/*.spec.ts", "node_modules/**"]
  }
});
