// The fixture every spec in this suite is written against, and the two
// operator steps that come before anything else: enrolling the
// administrator, and signing in as one.
//
// `enrolAdministrator` is exported rather than folded into the fixture on
// purpose. Enrolment is the SUBJECT of specs/enrolment.spec.ts, which
// asserts its way through it, and it is SETUP for every spec after that,
// which needs it to have happened and nothing more. One implementation
// serves both, so the setup path and the tested path cannot drift into two
// different things.
import { test as base, type Page } from "@playwright/test";

import { bootDeployment, type Deployment } from "./deployment";
import { redacting } from "./secrets";

export type { Deployment } from "./deployment";
export type { Manager } from "./deployment";
export type { SourceFile, SourceMachine } from "./source";

/** Leaves a failed run's containers up for reading. Never the default: the
 *  whole point of the teardown is that a crashed run leaves nothing behind,
 *  and this is the same escape hatch scripts/e2e/two-machine-backup.sh
 *  spells --keep-on-failure. */
const KEEP_ON_FAILURE = (process.env.RM_LIVE_KEEP ?? "") === "1";

export const test = base.extend<{ deployment: Deployment }>({
  /** A whole deployment per test: two manager containers, one source
   *  machine, a private network and three volumes, all named after this run
   *  and removed when the test ends however it ends.
   *
   *  Per test rather than per worker, and it costs a boot each time. What it
   *  buys is that every spec starts from a FRESH INSTALL, which is the state
   *  the operator's path actually starts in and the only state in which
   *  enrolment, the first-run banner and an empty catalogue are real rather
   *  than arranged. A shared deployment would have the first spec that ran
   *  decide what the others were looking at. */
  deployment: async ({}, use, testInfo) => {
    const deployment = await bootDeployment();
    try {
      await use(deployment);
    } finally {
      const failed = testInfo.status !== testInfo.expectedStatus;
      await deployment.stop(KEEP_ON_FAILURE && failed);
    }
  }
});

export { expect } from "@playwright/test";

/** Creates the one administrator account, through the browser, the way an
 *  operator does on a new install.
 *
 *  The one-time token goes from the engine's log into a variable, into the
 *  URL, and nowhere else. Everything that touches it runs inside
 *  `redacting`, because Playwright puts the URL of a failed navigation into
 *  the error it raises, and the run where that happens is the run somebody
 *  is definitely reading the output of.
 *
 *  The waits are on real signals rather than on the form disappearing. The
 *  form is gone the moment React re-renders, which is before the session
 *  cookie has been applied; suites/equivalence learned that the expensive
 *  way and the note is repeated here because this is a different form. */
export async function enrolAdministrator(page: Page, deployment: Deployment): Promise<void> {
  const token = await openEnrolmentPage(page, deployment);
  const { username, password } = deployment.admin;

  await redacting([token, password], async () => {
    await page.getByLabel("Username").fill(username);
    // Leading-anchored, which is the shape ui/shared's PasswordInput asks
    // for in its own doc: a bare substring also matches the reveal
    // toggle's "Show password", and `{ exact: true }` breaks the moment a
    // validation message renders inside the same label.
    await page.getByLabel(/^Password/).fill(password);
    await page.getByLabel(/^Confirm password/).fill(password);

    const [enrolled] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/v1/auth/enroll") && r.request().method() === "POST"),
      page.getByRole("button", { name: "Create administrator" }).click()
    ]);
    if (enrolled.status() !== 204) {
      // Deliberately not quoting the response body: a refusal here can echo
      // what was submitted, and what was submitted is a password.
      throw new Error(`enrolment returned ${enrolled.status()} rather than 204`);
    }

    // The session, not the redirect: a 200 here is the engine saying the
    // cookie it just set authenticates.
    await page.waitForResponse((r) => r.url().endsWith("/api/v1/auth/session") && r.status() === 200);
    // And then off the enrolment URL, so the token stops being in the page's
    // own address for the rest of the test. The app does this itself, with a
    // replacing redirect to "/"; this waits for it rather than assuming it.
    await page.waitForURL((url) => !url.search.includes("token="));
  });
}

/** Opens the enrolment link the engine printed, and hands back the token it
 *  carried so a caller can keep redacting around whatever it does next.
 *
 *  Separate from `enrolAdministrator` because the interesting refusals are
 *  reached by opening the same page and submitting something else, and a
 *  spec doing that must not be the one place where the token reaches a raw
 *  `page.goto`. The navigation itself is the riskiest single call in this
 *  suite: Playwright puts the URL into the error when it fails. */
export async function openEnrolmentPage(page: Page, deployment: Deployment): Promise<string> {
  const token = await deployment.enrolmentToken();
  await redacting([token], () => page.goto(`${deployment.uiUrl}/enroll?token=${encodeURIComponent(token)}`));
  return token;
}

/** Signs in as the administrator this run enrolled, through the real login
 *  form. Every spec after enrolment starts here. */
export async function signIn(page: Page, deployment: Deployment): Promise<void> {
  const { username, password } = deployment.admin;

  await redacting([password], async () => {
    await page.goto(`${deployment.uiUrl}/`);
    await page.getByLabel("Username").fill(username);
    await page.getByLabel(/^Password/).fill(password);

    const [signedIn] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/v1/auth/login") && r.request().method() === "POST"),
      page.getByRole("button", { name: "Sign in" }).click()
    ]);
    if (signedIn.status() !== 204) {
      throw new Error(`sign-in returned ${signedIn.status()} rather than 204`);
    }
    await page.waitForResponse((r) => r.url().endsWith("/api/v1/auth/session") && r.status() === 200);
  });
}
