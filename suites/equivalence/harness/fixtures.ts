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
   *  bit-identical to the UI side, and nothing serves it.
   *
   *  "Nothing serves it" used to be a description of the setup and is now
   *  a claim worth defending, because the CLI can put its questions to a
   *  running engine (backupd#543, #544) and would give a different
   *  answer if one were serving this directory. Two things keep it in the
   *  no-engine case, and both are structural rather than lucky.
   *
   *  The first is that this is its own deployment. A serving process
   *  announces itself by taking a lock beside the state database its
   *  configuration names, and `bootStack` boots over `ui.work`, whose
   *  database is a different file. So a CLI command against `cli.work`
   *  finds nothing serving it and answers `mode: direct` from the file, on
   *  stderr, which is exactly what Suite A pins.
   *
   *  The second is that this harness names no route. Reaching an engine
   *  needs BACKUP_MANAGER_API_URL and the administrator credentials in the
   *  environment, and nothing here sets them. That matters for the two
   *  specs that run a read against `ui.work` as a shared observation
   *  surface (`backup-set-create` calls `sources`, `settings-write` calls
   *  `retention --dry-run`): those DO find the engine, and without a route
   *  they land on `mode: unconfirmed` rather than `engine-attached`. They
   *  compare `.stdout` and a read announces on stderr, so nothing they
   *  measure moves either way.
   *
   *  I left this as one shape rather than adding a second. An
   *  engine-attached lane would have to hand the CLI a real route, which
   *  is a whole matrix of its own about what a routed write and a
   *  cross-checked read do, not a variant of this fixture. The pieces are
   *  here if somebody wants it: `bootStack` already enrols an
   *  administrator and keeps the credentials in memory. */
  cli: Manifest;
}

/** Signs the browser in as the administrator this run enrolled. Through
 *  the real login form, because that is the operator-facing path and the
 *  built client is the thing under test; the enrolment before it went over
 *  HTTP because enrolment is setup, not an action being compared. */
export async function signIn(page: Page, stack: Stack): Promise<void> {
  await page.goto(stack.uiUrl + "/");
  await page.getByLabel("Username").fill(stack.username);
  // Exact, because the login form's password field is about to gain a
  // "Show password" toggle button beside it (backupd#344) and an
  // unanchored substring match would resolve to both. The login page has no
  // validation text growing into this field's label the way enrolment's
  // does, so exact is safe here where a prefix regex is needed there.
  await page.getByLabel("Password", { exact: true }).fill(stack.password);

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
    //
    // Deterministic "by construction" has one input it cannot supply
    // itself, which is what "now" means. A scenario's mtimes are offsets
    // from it, so two materialisations seconds apart are equivalent but
    // not identical, and two that straddle a second boundary produce
    // artifacts whose remote mtimes differ by a second. That was
    // invisible until FR-19's reason line started printing the artifact's
    // resolved date (backupdproject/backupd#215): after it, the two
    // sides' retention previews disagreed on that line whenever the
    // boundary fell between the two calls, which is a coin flip weighted
    // by how long one materialisation takes. Both sides are anchored to
    // one instant instead, so the pair is identical rather than usually
    // identical.
    const anchor = new Date().toISOString();
    const uiWork = materialise(scenario, label + "-ui", build.cli, anchor);
    const cliWork = materialise(scenario, label + "-cli", build.cli, anchor);

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
