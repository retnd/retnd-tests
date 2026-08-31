import { defineConfig } from "vitest/config";

// e2e/port.test.ts is a unit test of the suite's own port helper, and it
// moved with the helper. In the old home ui/shared's vite.config.ts ran it;
// here it needs its own runner, and the same exclusion, for the same reason:
// every Playwright file under e2e/ is a `.spec.ts`, and a `.test.ts` there
// is a unit test of the harness rather than a browser test.
export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts", "harness/**/*.test.ts"],
    exclude: ["e2e/**/*.spec.ts", "node_modules/**"]
  }
});
