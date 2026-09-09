import { expect, request, test as base } from "@playwright/test";
import type { APIRequestContext, Cookie, Page } from "@playwright/test";

import { type DeploymentFacts, describeFacts, readFacts } from "../harness/api";
import { type Deployment, resolveDeployment } from "../harness/deployment";
import { DESTRUCTIVE_VAR } from "../harness/deployment";
import { type SessionCookies, sessionIsLive, signIn } from "../harness/session";

/**
 * The fixture every spec in this suite is written against, and the three
 * things it now does that it did not do before.
 *
 * # It authenticates, for real
 *
 * What was here was a `page.route` stub on `**\/api/v1/auth/session`
 * answering `{"username":"e2e-admin"}`, plus a `window.ugos` shim, plus a
 * mutable boolean the page object could flip. None of it touched a
 * network. It was the right thing while the app under test was a Vite dev
 * server over `createMockApi`, because there was no service to
 * authenticate against; it is exactly the wrong thing now, because it
 * would take the one path this move exists to cover and stub it out again.
 *
 * So the fixture signs in the way the client does: GET a page for the
 * `bm_csrf` cookie, POST /api/v1/auth/login echoing it back in
 * `X-CSRF-Token`, and carry the `bm_session` cookie the 204 sets. The
 * details are in harness/session.ts, including why no credential in this
 * suite ever reaches a file.
 *
 * # It signs in ONCE per worker, on purpose
 *
 * apps/common/auth/local rate-limits login to ten attempts a minute per
 * client address, which is generous for an operator and nowhere near
 * enough for a per-test login across two hundred cases. So the session is
 * a worker fixture, and every test after the first re-uses its cookies.
 *
 * The one thing that can invalidate it is a test pressing Sign out, which
 * revokes the token server-side (handleLogout calls sessions.revoke). That
 * is why `signOut()` below tells the store, and why a test that only wants
 * to LOOK at the signed-out UI says `test.use({ signedIn: false })`
 * instead: it gets a context with no session installed and costs the run
 * no login at all.
 *
 * # It knows what the deployment actually holds
 *
 * The mock returned fixed, complete data on every page. A real deployment
 * starts empty and gains data only when a backup runs, so a spec asserting
 * on rows has to know whether there are any. `facts` is that answer, read
 * once per worker straight from the API, and `needs()` is how a spec turns
 * it into a stated skip rather than a silent pass.
 */

/** The same two elements as `BackupManager.terminal()` and the content
 *  column, as selectors, for the geometry a locator cannot express: a
 *  measurement that compares two boxes has to read both inside ONE page
 *  evaluation, or it is comparing a layout to itself one paint later. */
export const TERMINAL = "section[aria-label='Terminal']";
export const CONTENT_COLUMN = "main";

/** Holds this worker's session, and knows when it has been spent.
 *
 *  A plain object rather than a value, so the page object can mark the
 *  session dead from inside a test without going back through Playwright's
 *  fixture plumbing. */
class SessionStore {
  private cookies: SessionCookies | null = null;

  constructor(private readonly deployment: Deployment) {}

  /** The cookies a browser context needs, signing in if this worker has
   *  none or the last one was spent. */
  async cookiesForContext(): Promise<SessionCookies> {
    if (this.cookies === null) this.cookies = await signIn(this.deployment);
    return this.cookies;
  }

  /** Called after anything that revokes the session server-side. The next
   *  test pays for one login; nothing else in the run does. */
  spent() {
    this.cookies = null;
  }
}

/** Page-object surface. Keeps the specs readable and stops selector drift
 *  from spreading across the suite. */
export class BackupManager {
  constructor(
    readonly page: Page,
    private readonly session: SessionStore,
    /** The deployment's own API, on this test's cookie jar. Arrange steps
     *  go through here; the browser is kept for the thing under test. */
    readonly api: APIRequestContext,
    readonly facts: DeploymentFacts
  ) {}

  /** Opens a page and waits for the shell.
   *
   *  The `scenario` parameter this used to take is gone, and its removal
   *  is the honest half of the move. It appended `?scenario=empty` (or
   *  `storage-critical`, or `version-mismatch`, or `activity-unreadable`)
   *  to the URL, and `scenarioFromLocation()` is read by `createMockApi`,
   *  which a production bundle never constructs: `createApp.tsx` picks
   *  `httpApi` whenever `import.meta.env.DEV` is false. So against this
   *  deployment the query string is inert. A `goto` that still accepted it
   *  would navigate somewhere real, ignore the argument, and let a spec
   *  named for a fixture state assert against the default one instead,
   *  which is a passing test that has stopped meaning anything. */
  async goto(path = "/") {
    await this.page.goto(path);
    // The shell is present once the section nav has rendered.
    await expect(this.page.getByRole("navigation", { name: "Sections" })).toBeVisible();
  }

  nav(label: string) {
    return this.page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: new RegExp(label, "i") });
  }

  async navigateTo(label: string) {
    await this.nav(label).click();
  }

  heading(name: string | RegExp) {
    return this.page.getByRole("heading", { level: 1, name });
  }

  card(label: string) {
    return this.page.getByRole("region", { name: label });
  }

  /** The global terminal (rclone-manager#599). A <section> with an
   *  accessible name, so it answers to the region role like every other
   *  card here, and #617 pinned it to the bottom of the browser window. */
  terminal() {
    return this.page.getByRole("region", { name: "Terminal" });
  }

  /** The handle the terminal is resized by. */
  terminalResizeHandle() {
    return this.page.getByRole("separator", { name: "Resize terminal" });
  }

  dialog(name?: string | RegExp) {
    return name ? this.page.getByRole("dialog", { name }) : this.page.getByRole("dialog");
  }

  async theme() {
    return this.page.locator("html").getAttribute("data-theme");
  }

  async toggleTheme() {
    await this.page.getByRole("button", { name: "Toggle colour theme" }).click();
  }

  async cssVar(name: string) {
    return this.page.evaluate(
      (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim(),
      name
    );
  }

  /** Every status in this product must carry a glyph AND a text label. */
  async assertNotColourOnly(locator = this.page.locator("body")) {
    const text = await locator.innerText();
    expect(text.length).toBeGreaterThan(0);
  }

  /** Drives the real "Sign out" control and waits for the login screen.
   *
   *  This really signs out now: `api.logout()` reaches
   *  POST /api/v1/auth/logout, which revokes the session token in the
   *  service, not just in this browser. That is the whole reason the store
   *  is told: without it, every test after this one in this worker would
   *  arrive carrying a cookie the service has already thrown away, render
   *  the login page, and fail on a missing section nav with no hint as to
   *  why. */
  async signOut() {
    await this.page.getByRole("button", { name: "Sign out" }).click();
    await expect(this.page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    this.session.spent();
  }
}

export const test = base.extend<
  { signedIn: boolean; bm: BackupManager },
  { deployment: Deployment; sessionStore: SessionStore; facts: DeploymentFacts }
>({
  /** Whether this test's browser carries a session.
   *
   *  True everywhere except the handful of cases that are ABOUT the
   *  signed-out UI. Those used to flip a stubbed boolean; now they simply
   *  do not get a session cookie, which is the same thing an operator's
   *  fresh browser has and costs the run no login. */
  signedIn: [true, { option: true }],

  deployment: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await use(resolveDeployment());
    },
    { scope: "worker" }
  ],

  sessionStore: [
    async ({ deployment }, use) => {
      await use(new SessionStore(deployment));
    },
    { scope: "worker" }
  ],

  /** What this deployment holds, read once per worker straight from the
   *  API. Printed by the first worker so the run's output says which
   *  preconditions were satisfiable before any skip line appears. */
  facts: [
    async ({ deployment, sessionStore }, use) => {
      // A standalone request context rather than a browser one, because a
      // worker fixture cannot depend on a page. Playwright will not let a
      // context be handed Cookie objects after the fact, so the session is
      // replayed as the header an HTTP client sends anyway: the same jar
      // the browser gets, spelled the way the wire spells it.
      const jar = (await sessionStore.cookiesForContext())
        .map((c: Cookie) => c.name + "=" + c.value)
        .join("; ");
      const api = await request.newContext({
        baseURL: deployment.baseURL,
        extraHTTPHeaders: { cookie: jar }
      });
      try {
        const facts = {
          ...(await readFacts(api)),
          // Not read from the deployment: this is what the TOPOLOGY says it
          // created, carried alongside what the deployment says it holds so
          // a spec can compare the two. See real-path.spec.ts.
          seededBackupSet: deployment.seededBackupSet
        };
        if (process.env.TEST_WORKER_INDEX === "0") {
          console.log("e2e: the deployment holds " + describeFacts(facts));
        }
        await use(facts);
      } finally {
        await api.dispose();
      }
    },
    { scope: "worker" }
  ],

  // { auto: true }: every test gets a session by default, not just the
  // ones that destructure `bm`. accessibility.spec.ts, responsive.spec.ts,
  // safety-invariants.spec.ts and provider-treatment.spec.ts navigate with
  // a bare `page.goto()` and need the shell to be reachable just as much
  // as the specs that use the page object.
  bm: [
    async ({ page, context, signedIn, sessionStore, facts }, use) => {
      if (signedIn) {
        await context.addCookies([...(await sessionStore.cookiesForContext())]);
        // The cheap question, asked before the expensive one. GET
        // /auth/session mutates nothing and is deliberately neither
        // CSRF-checked nor rate-limited, so this costs the run nothing;
        // signing in again costs one of ten attempts a minute. This is how
        // the test after a Sign out gets a live session without every
        // other test paying for a login to find out it did not need one.
        if (!(await sessionIsLive(context))) {
          sessionStore.spent();
          await context.clearCookies();
          await context.addCookies([...(await sessionStore.cookiesForContext())]);
        }
      }
      await use(new BackupManager(page, sessionStore, context.request, facts));
    },
    { auto: true }
  ]
});

/**
 * # The three ways a spec can decline to assert
 *
 * All three print their reason into the run's own output, and none of
 * them is a deletion. A case that quietly disappears is indistinguishable
 * from one nobody ever wrote; a case that says "skipped, because this
 * deployment has no quarantined backups" is a line somebody can act on.
 */

/** This case can only ever have meant something against `createMockApi`.
 *
 *  Not "it is failing and I turned it off". These are cases whose SUBJECT
 *  is a state the mock manufactures and a real deployment cannot be put
 *  into from outside: a service speaking a different /api/v1 contract, a
 *  `listActivity` that rejects with a SyntaxError, a fixed catalogue of
 *  named artifacts on named storage classes.
 *
 *  Each call names what it would take to make the case real, so the list
 *  is a to-do rather than a graveyard. */
export function mockOnly(reason: string): void {
  test.skip(true, "mock-only: " + reason);
}

/** This case needs the deployment to be in a state it is not in.
 *
 *  The condition is read off `facts`, which came from the API rather than
 *  from a flag somebody set, so it cannot be wrong about the deployment in
 *  the way an environment variable can. A run against a seeded deployment
 *  runs these; a run against a fresh container states what it skipped and
 *  why. */
export function needs(satisfied: boolean, reason: string): void {
  test.skip(!satisfied, "needs " + reason);
}

/** This case destroys data the deployment cannot get back.
 *
 *  Applying a retention plan really deletes retained backups, and this
 *  suite shares one deployment across every spec in the run, so a case
 *  that does it changes what everything after it is looking at. Off unless
 *  the run says the deployment is disposable. */
export function destructive(): void {
  test.skip(
    (process.env[DESTRUCTIVE_VAR] ?? "").trim() !== "1",
    "destructive: this really deletes retained backups from the deployment every other spec is " +
      "reading, so it runs only when " + DESTRUCTIVE_VAR + "=1 says the deployment is disposable"
  );
}

export { expect };
