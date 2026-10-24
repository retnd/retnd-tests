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

  /** The product does not perform application restore, and must not offer
   *  to. What it MAY offer is the same English verb applied to something
   *  that is not a backup: the settings page has a "Restore default chain"
   *  button that resets the retention policy, and the first real run found
   *  it with a bare /^restore/i. The mock's settings page did not render
   *  it, so an unqualified matcher was accidentally safe.
   *
   *  Narrowed rather than loosened, and with the exclusion controlled: the
   *  zero below would be satisfied by a query that matched nothing at all,
   *  so the excluded button is asserted to exist first. A rename of it
   *  turns this red, which is right, because the exclusion would then be
   *  hiding whatever took its name. */
  test("no page offers restore execution", async ({ page }) => {
    // The one control this product legitimately spells with that verb,
    // proven present so the exclusion below cannot be vacuous.
    await page.goto("/settings");
    await expect(page.getByRole("button", { name: "Restore default chain" })).toBeVisible();

    for (const path of ALL_PAGES) {
      await page.goto(path);
      await expect(
        page.getByRole("button", { name: /^restore/i }).filter({ hasNotText: /default chain/i })
      ).toHaveCount(0);
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

  test("remote deletion is always described as post-commit", async ({ bm, deployment, page }) => {
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

    // Since retnd#864 the wizard's rail is locked behind the connection
    // test: Review cannot be clicked cold, and a case that could was
    // asserting a sentence on a step nobody could reach that way. So the
    // source is proven for real, the way an operator proves it, with the
    // machine this deployment can reach and the key its store already
    // holds for it (the topology imports the source's own key; a
    // synthetic one is refused by a real sshd). Steps 3 to 6 are complete
    // on their defaults, step 7 wants the acknowledgement, and the
    // sentence under test is on the Review step that follows.
    needs(
      deployment.source !== null,
      "a source machine this deployment can really reach (RETND_VPS_HOST and friends) AND a key " +
        "in its store that authenticates against it"
    );
    const source = deployment.source!;
    await page.goto("/sets/new");
    // The terminal dock is a fixed overlay along the bottom of the window,
    // and the connection-test controls scroll to exactly where it sits, so
    // a click there lands on the dock. One run in three did that and the
    // test never started. Out of the way first.
    const hideTerminal = page.getByRole("button", { name: "Hide terminal" });
    if (await hideTerminal.isVisible()) await hideTerminal.click();
    await page.getByLabel("Server hostname").fill(source.host);
    await page.getByLabel("SSH port").fill(String(source.port));
    await page.getByLabel("Username").fill(source.user);
    // The directory too: the connection test lists it, and the wizard's
    // example folder is not on this machine.
    await page.getByLabel("Directory to back up").fill(source.path);

    await page.getByRole("button", { name: "Connection test" }).click();
    await page.getByRole("radio", { name: /Use managed key/ }).click();
    const managed = page.getByRole("button").filter({ hasText: /SHA256:/ });
    await expect(managed.first()).toBeVisible();
    await managed.first().click();
    await expect(managed.first()).toHaveAttribute("aria-pressed", "true");
    const trust = page.getByRole("button", { name: "Trust host" });
    await expect(trust).toBeEnabled();
    await trust.click();
    await expect(page.getByRole("button", { name: "Host trusted" })).toBeDisabled();
    await page.getByRole("button", { name: /^Test connection$/ }).click();
    await expect(page.getByText(/This source has been proven/)).toBeVisible({ timeout: 60_000 });

    // The remote-source handling policy is the Retention step's (step 7
    // of eight; it was the Review step's in the six-step wizard). The
    // sentence has to be there before the operator acknowledges anything,
    // and the Review step's card then restates it as the moment deletion
    // happens.
    await page.getByRole("button", { name: "Retention" }).click();
    await expect(
      page.getByText(/transferred, verified, durably committed to this NAS, and recorded as safe/)
    ).toBeVisible();
    await page.getByRole("checkbox", { name: /remote backup will be removed only after/i }).check();

    await page.getByRole("button", { name: "Review" }).click();
    await expect(page.getByText(/after a verified backup/)).toBeVisible();
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
