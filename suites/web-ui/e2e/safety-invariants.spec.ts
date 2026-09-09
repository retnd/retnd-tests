import { expect, needs, test } from "./fixtures";

/** The product's non-negotiables, asserted across the whole UI rather than in
 *  one component. If any of these fail the design has regressed, not the code.
 *
 *  This is the file that gained the most from the move and changed the
 *  least, and both halves of that are worth naming.
 *
 *  Every case here is an ABSENCE claim swept across eight pages: no
 *  arbitrary delete, no private key on screen, never the words "restore
 *  point", no raw stack trace, no vague destructive label. Absence claims
 *  are the ones a mock is worst at proving, because the mock decides what
 *  is on the page: "no private key material anywhere" was a statement
 *  about a fixture that had none. Here the pages are drawing a real
 *  catalogue, real host fingerprints and a real key store, so the sweep is
 *  finally looking at material that COULD leak.
 *
 *  The three cases that needed a positive control are the ones that
 *  changed: a control that depends on the deployment holding something
 *  (a set to open, a completed backup to date) now says so. */
const ALL_PAGES = [
  "/", "/sets", "/sets/new", "/backups", "/activity", "/quarantine", "/settings", "/catalog-recovery"
];

test.describe("safety invariants", () => {
  test.beforeEach(async ({ bm }) => {
    needs(bm.facts.configured, "a configured deployment: several of these pages refuse with NOT_CONFIGURED before the first backup set exists");
  });

  test("no page exposes an arbitrary remote or file delete", async ({ page }) => {
    for (const path of ALL_PAGES) {
      await page.goto(path);
      await expect(page.getByRole("button", { name: /delete remote/i })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /delete file/i })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /force delete/i })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /delete anyway/i })).toHaveCount(0);
    }
  });

  test("no page ever renders a private key", async ({ page }) => {
    for (const path of ALL_PAGES) {
      await page.goto(path);
      const text = await page.locator("body").innerText();
      expect(text, "private key material on " + path).not.toMatch(/BEGIN (OPENSSH|RSA|EC) PRIVATE KEY/i);
      expect(text).not.toMatch(/private key:/i);
    }
  });

  test("the product never calls a retained backup a restore point", async ({ page }) => {
    for (const path of ALL_PAGES) {
      await page.goto(path);
      expect(await page.locator("body").innerText()).not.toMatch(/restore point/i);
    }
  });

  test("no page offers restore execution", async ({ page }) => {
    for (const path of ALL_PAGES) {
      await page.goto(path);
      await expect(page.getByRole("button", { name: /^restore/i })).toHaveCount(0);
    }
  });

  test("no raw stack trace is ever displayed", async ({ page }) => {
    for (const path of ALL_PAGES) {
      await page.goto(path);
      const text = await page.locator("body").innerText();
      expect(text).not.toMatch(/at [\w$.]+ \(.*:\d+:\d+\)/);
      expect(text).not.toMatch(/Traceback \(most recent call last\)/);
    }
  });

  test("destructive buttons never use vague labels", async ({ page }) => {
    for (const path of ALL_PAGES) {
      await page.goto(path);
      await expect(page.getByRole("button", { name: /^(OK|Yes|Confirm|Submit)$/ })).toHaveCount(0);
    }
  });

  test("destructive actions are never the visual primary action", async ({ bm, page }) => {
    needs(bm.facts.sets.length > 0, "at least one backup set to open");
    await page.goto("/sets");
    await page.getByRole("article").first().getByRole("button", { name: "Open" }).click();

    const destructive = page.getByRole("button", { name: /Apply retention now|Remove set configuration/ });
    // BackupSetDetailPage returns null until its own getSet() fetch
    // resolves, so these buttons don't exist yet right after the click that
    // navigated here. .count() doesn't retry like a web-first assertion —
    // wait for the first one to actually render before counting.
    await expect(destructive.first()).toBeVisible();
    const count = await destructive.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const bg = await destructive.nth(i).evaluate((el) => getComputedStyle(el).backgroundColor);
      // Outline treatment only — a filled destructive button in-page is a defect.
      expect(bg === "rgba(0, 0, 0, 0)" || bg === "transparent").toBe(true);
    }
  });

  test("remote deletion is always described as post-commit", async ({ bm, page }) => {
    // The dashboard half of this sentence lives under the active transfer,
    // so it is on screen while something is running. The wizard half is
    // always there, which is why it is the half that carries the case on a
    // quiet deployment: the wizard's Review step is a page, not a state.
    if (bm.facts.runningOperations > 0) {
      await page.goto("/");
      await expect(
        page.getByText(/removed only after the NAS copy is verified and durably committed/)
      ).toBeVisible();
    }

    await page.goto("/sets/new");
    await page.getByRole("button", { name: "Review" }).click();
    await expect(
      page.getByText(/transferred, verified, durably committed to this NAS, and recorded as safe/)
    ).toBeVisible();
  });

  test("freshness is stated as an age, not a bare date", async ({ bm, page }) => {
    // A set that has never produced a verified backup reads "never", which
    // is the honest answer and not an age, so the case needs a deployment
    // that has completed one. It is the same claim either way: a bare date
    // is what must never appear.
    needs(
      bm.facts.sets.some((set) => set.newest_good_backup_at || set.last_completed_backup_at),
      "a deployment that has completed at least one backup, so a freshness figure is an age " +
        "rather than the word never"
    );
    await page.goto("/");
    await expect(page.getByText(/(minutes|hours|days) ago/).first()).toBeVisible();
  });
});
