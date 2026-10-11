import { expect, needs, test } from "./fixtures";

/**
 * retnd#1049, the invariant: a user must never meet an error on a first
 * install just because something has not been configured yet.
 *
 * This is the sweep. It boots nothing itself; it is pointed at a fresh
 * deployment (empty config directory, no backup set, nothing declared) and
 * walks every page an operator can reach from the section nav, plus the
 * reads behind them, and fails on the first thing that presents an
 * unconfigured state as a failure.
 *
 * # What counts as an error here
 *
 *  - any `role=alert`: the ErrorState renders as one, and so does
 *    WarningBanner, which is on purpose. A yellow "this deployment has not
 *    been told how to reach X" about something nobody has set up yet is
 *    the same defect in a softer colour;
 *  - an "Advanced details" disclosure, which only a failure offers;
 *  - an API path quoted at the operator, which is how the engine's own 503
 *    NOT_CONFIGURED sentence reads once a page prints it;
 *  - a 5xx from any read the pages issue.
 *
 * # What every page must offer instead
 *
 * One callout, `data-testid="first-run-next-step"`, that names the next
 * thing to do and carries the control that does it. Which step it names
 * comes from the service (GET /system/first-run's `next_step`), so a
 * deployment that has an administrator and no backup set says "add your
 * first backup set" on every page, and one with a backup set no longer
 * shows the callout at all.
 *
 * # The one control, and why it is in this file
 *
 * A sweep that has quietly stopped seeing anything reports exactly what a
 * healthy deployment reports. The last case plants a danger banner in the
 * page and requires the same sweep to name it.
 */

const NEEDS_FRESH =
  "a fresh install: no backup set and no backup yet (the state an app-store install starts in)";

function isFresh(facts: { sets: unknown[]; backups: unknown[] }): boolean {
  return facts.sets.length === 0 && facts.backups.length === 0;
}

/** Every page the section nav reaches, plus the two settings sub-pages
 *  and the recovery flow, which are reachable from Settings on any
 *  deployment. */
const PAGES: ReadonlyArray<readonly [path: string, what: string]> = [
  ["/", "the dashboard"],
  ["/sets", "backup sets"],
  ["/backups", "backups"],
  ["/activity", "activity"],
  ["/quarantine", "quarantine"],
  ["/settings", "settings"],
  ["/settings/backup-defaults", "backup defaults"],
  ["/repositories", "repository domains"],
  ["/repositories/health", "repository health"],
  ["/repositories/maintenance", "repository maintenance"],
  ["/catalog-recovery", "catalog recovery"]
];

/** The reads those pages issue, by path under /api/v1. */
const READS = [
  "/system/first-run",
  "/system/version",
  "/system/health",
  "/system/storage",
  "/settings",
  "/storage-mediums",
  "/backup-sets",
  "/backups",
  "/activity",
  "/quarantine",
  "/repositories",
  "/workflows/config",
  "/recovery"
] as const;

async function expectNoErrorSurface(page: import("@playwright/test").Page, what: string) {
  // Every card has answered: the loading copy is the only honest gate,
  // since an ErrorState appears only once its read has come back.
  await expect(page.getByText(/^(Loading|Reading)/), what + ": a read is still in flight").toHaveCount(0);
  await expect(page.getByRole("alert"), what + ": an alert on a fresh install").toHaveCount(0);
  await expect(page.getByText("Advanced details"), what + ": a failure disclosure").toHaveCount(0);
  // What the operator can READ, in the content column. innerText rather
  // than textContent, because the shell keeps every tooltip's prose in
  // the DOM hidden, and one of the terminal's explains that an empty
  // record is not "a sign that the page failed to read".
  const content = page.locator("main");
  await expect(content, what + ": an API path shown to the operator").not.toContainText(/\/api\/v1\//, {
    useInnerText: true
  });
  await expect(content, what + ": a failure sentence").not.toContainText(
    /could not reach|did not answer|could not be read|failed to/i,
    { useInnerText: true }
  );
}

test.describe("nothing configured yet is never an error", () => {
  for (const [path, what] of PAGES) {
    test(what + " (" + path + ") shows a neutral state and the next step", async ({ bm, page }) => {
      needs(isFresh(bm.facts), NEEDS_FRESH);
      await bm.goto(path);
      await expectNoErrorSurface(page, what);
      const next = page.getByTestId("first-run-next-step");
      await expect(next, what + ": the guided next step").toBeVisible();
      await expect(next).toContainText(/backup set/i);
    });
  }

  test("every read a fresh install's pages issue is an answer, not a 5xx", async ({ bm }) => {
    needs(isFresh(bm.facts), NEEDS_FRESH);
    const refused: string[] = [];
    for (const path of READS) {
      const res = await bm.api.get("/api/v1" + path);
      if (res.status() >= 500) refused.push("GET /api/v1" + path + " -> " + res.status());
    }
    expect(refused, "reads answered as a server failure on a fresh install").toEqual([]);
  });

  test("the service says which setup step is next", async ({ bm }) => {
    needs(isFresh(bm.facts), NEEDS_FRESH);
    const res = await bm.api.get("/api/v1/system/first-run");
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      configured?: unknown;
      next_step?: unknown;
      steps?: Record<string, unknown>;
    };
    // The guided experience is driven from here: which steps exist, which
    // are done or skipped, and the one to do next. An administrator
    // exists (this run signed in as one), so the next step is the first
    // backup set, and email is still open.
    expect(typeof body.next_step, "next_step").toBe("string");
    expect(body.steps, "a per-step status map").toBeTruthy();
    expect(body.steps?.administrator).toBe("done");
    expect(["pending", "skipped"]).toContain(body.steps?.email);
    expect(body.steps?.backup_set).toBe("pending");
    expect(body.next_step).toBe("backup_set");
  });

  test("control: the sweep sees a danger banner when one is there", async ({ bm, page }) => {
    await bm.goto("/");
    await page.evaluate(() => {
      const planted = document.createElement("div");
      planted.className = "banner banner--danger";
      planted.setAttribute("role", "alert");
      planted.textContent = "planted by the sweep control";
      document.body.appendChild(planted);
    });
    await expect(page.getByRole("alert")).toHaveCount(1);
  });
});

test.describe("enrolment, the first step", () => {
  test.use({ signedIn: false });

  test("does not demand a mail server before the administrator can be created", async ({
    page
  }) => {
    // The email step is one of the three guided steps and it has to be
    // skippable: an operator installing on a LAN at night may have no
    // SMTP relay to hand, and recovery can be finished later from
    // Settings. Today the form will not submit without a recovery address
    // and a complete SMTP block (ui/shared/src/auth/EnrollmentPage.tsx,
    // `valid`), and the route behind it refuses the same way.
    await page.goto("/enroll");
    await expect(page.getByRole("heading", { name: /create retnd administrator/i })).toBeVisible();
    await page.getByLabel("Username", { exact: true }).fill("first-run-operator");
    await page.getByLabel("Password", { exact: true }).fill("long-enough-passphrase-12");
    await page.getByLabel("Confirm password", { exact: true }).fill("long-enough-passphrase-12");
    await expect(page.getByRole("button", { name: "Create administrator" })).toBeEnabled();
  });
});
