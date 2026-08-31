// One Playwright fixture: a booted stack over a fixture work directory,
// plus the second, bit-identical work directory the CLI side drives.
import { test as base, type Page } from "@playwright/test";

import { bootStack, buildUiBundle, resolveUiDir, type Stack } from "./stack";
import { materialise, resolveBuild, type Build, type Manifest } from "./tools";

export interface Pair {
  build: Build;
  /** The side an action is performed on through the browser. */
  ui: Stack;
  /** The side the same action is performed on through the CLI. Starts
   *  bit-identical to the UI side, and no server ever touches it. */
  cli: Manifest;
}

/** Signs the browser in as the administrator this run enrolled. Through
 *  the real login form, because that is the operator-facing path and the
 *  built client is the thing under test; the enrolment before it went over
 *  HTTP because enrolment is setup, not an action being compared. */
export async function signIn(page: Page, stack: Stack): Promise<void> {
  await page.goto(stack.uiUrl + "/");
  await page.getByLabel("Username").fill(stack.username);
  await page.getByLabel("Password").fill(stack.password);

  // Wait on the login response, not on the form disappearing. The form is
  // gone the moment React re-renders, which is before the Set-Cookie has
  // been applied; a spec that navigated on that signal got the sign-in page
  // back on the next route and looked like a session that had not
  // persisted. This is the same class of mistake as waiting on a timeout,
  // and it is why every wait in this repository is on a real signal.
  const [login] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/v1/auth/login") && r.request().method() === "POST"),
    page.getByRole("button", { name: "Sign in" }).click()
  ]);
  if (login.status() !== 204) {
    throw new Error(`sign-in returned ${login.status()}: ${await login.text()}`);
  }
  await page.waitForResponse((r) => r.url().endsWith("/api/v1/auth/session") && r.status() === 200);
}

export const test = base.extend<{ pair: Pair }, { scenario: string }>({
  scenario: ["seeded-local", { option: true, scope: "worker" }],

  pair: async ({ scenario }, use, testInfo) => {
    const build = resolveBuild();
    const label = testInfo.title.replace(/[^a-z0-9]+/gi, "-").slice(0, 40).toLowerCase();

    // Two materialisations of one scenario, not one copied twice: the
    // fixture layer is deterministic by construction, so two runs of it
    // produce bit-identical trees, and asserting that they do is the first
    // thing every spec here does.
    const uiWork = materialise(scenario, label + "-ui", build.cli);
    const cliWork = materialise(scenario, label + "-cli", build.cli);

    const bundle = buildUiBundle(resolveUiDir(build));
    const stack = await bootStack(build, uiWork.work, bundle);
    try {
      await use({ build, ui: stack, cli: cliWork });
    } finally {
      await stack.stop();
    }
  }
});

export { expect } from "@playwright/test";
