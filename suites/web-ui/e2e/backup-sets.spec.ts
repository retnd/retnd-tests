import { expect, test } from "./fixtures";

test.describe("backup sets", () => {
  test("summarises the fleet in the subtitle", async ({ bm, page }) => {
    await bm.goto("/sets");
    await expect(page.getByText(/healthy .* stale .* failing/)).toBeVisible();
  });

  test("each card carries state, freshness, retention and validation", async ({ bm, page }) => {
    await bm.goto("/sets");
    const card = page.getByRole("article").first();
    await expect(card).toContainText("Newest known-good");
    await expect(card).toContainText("Last run");
    await expect(card).toContainText("Retention");
    await expect(card).toContainText("Last validation");
    await expect(card.getByRole("button", { name: "Open" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Run now" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Test connection" })).toBeVisible();
  });

  test("state is never conveyed by colour alone", async ({ bm, page }) => {
    await bm.goto("/sets");
    const cards = page.getByRole("article");
    // .count() doesn't auto-retry like a web-first assertion does — wait for
    // the first card to actually render (the mock listSets() fetch is async)
    // before counting, or this reads 0 while the page is still loading.
    await expect(cards.first()).toBeVisible();
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(cards.nth(i)).toContainText(/Healthy|Stale|Failing|Degraded/);
    }
  });

  test("a stale set explains the expectation it missed", async ({ bm, page }) => {
    await bm.goto("/sets");
    const stale = page.getByRole("article").filter({ hasText: "Stale" }).first();
    await expect(stale).toContainText(/No verified backup received for \d+ hours/);
    await expect(stale).toContainText(/Expected within/);
  });

  test("a halted set cannot be run", async ({ bm, page }) => {
    await bm.goto("/sets");
    const halted = page.getByRole("article").filter({ hasText: "Failing" }).first();
    await expect(halted.getByRole("button", { name: "Run now" })).toBeDisabled();
    await expect(halted).toContainText(/halted/i);
  });

  test("opens a set detail page", async ({ bm, page }) => {
    await bm.goto("/sets");
    await page.getByRole("article").first().getByRole("button", { name: "Open" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Overview")).toBeVisible();
  });
});

test.describe("backup set detail", () => {
  test.beforeEach(async ({ bm, page }) => {
    await bm.goto("/sets");
    await page.getByRole("article").first().getByRole("button", { name: "Open" }).click();
  });

  test("shows all six documented sections", async ({ page }) => {
    // Each section title is an <h2>; matched by heading role rather than
    // plain text so "Activity" can't collide with the identically-named
    // section nav link in the sidebar.
    for (const section of ["Overview", "Connection", "Backup discovery", "Retention", "Validation", "Activity"]) {
      await expect(page.getByRole("heading", { name: section, exact: true })).toBeVisible();
    }
  });

  test("offers ordinary actions in the header", async ({ page }) => {
    // Scoped to the header this test is named after, the same way the
    // destructive-actions test below scopes it. Unscoped, "Edit" and
    // "Preview retention" would also have been satisfied by controls
    // further down the page, so the old form proved less than its name.
    // exact: true — "Preview retention" is otherwise a substring match of
    // the Retention section's "Preview retention plan" button too.
    const header = page.getByRole("heading", { level: 1 }).locator("xpath=../..");
    for (const action of ["Run all due sets", "Test connection", "Edit", "Preview retention"]) {
      await expect(header.getByRole("button", { name: action, exact: true })).toBeVisible();
    }

    // "Run now" was this button's label until #214. It went because core
    // has no per-set run: one cycle walks every enabled backup set, so a
    // button named for the set on screen claimed something the API cannot
    // do. The replacement is only honest while it keeps saying that, so
    // the tooltip is asserted rather than just the new label, and "Run
    // now" must not come back here under the old meaning.
    await expect(header.getByRole("button", { name: "Run all due sets", exact: true }))
      .toHaveAttribute("title", /every enabled backup set, not only this one/);
    // The loop above is this zero's control: the same getByRole shape,
    // with exact names, finds four buttons on this page.
    await expect(page.getByRole("button", { name: "Run now", exact: true })).toHaveCount(0);
  });

  test("keeps destructive actions out of the header", async ({ page }) => {
    const header = page.getByRole("heading", { level: 1 }).locator("xpath=../..");
    await expect(header.getByRole("button", { name: /Remove set configuration/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Remove set configuration/ })).toBeVisible();
  });

  test("never displays a private key", async ({ page }) => {
    await expect(page.getByText(/The private key never leaves this NAS/)).toBeVisible();
    // Matches the actual PEM block shape (see safety-invariants.spec.ts) —
    // a bare /PRIVATE KEY/i self-matches the reassurance sentence just
    // asserted above, which says "private key" precisely because it is
    // reassuring the reader none is shown.
    expect(await page.locator("body").innerText()).not.toMatch(/BEGIN (OPENSSH|RSA|EC) PRIVATE KEY/i);
  });

  test("shows the trusted host fingerprint", async ({ page }) => {
    await expect(page.getByText(/SHA256:/).first()).toBeVisible();
    await expect(page.getByText("Trusted")).toBeVisible();
  });

  test("states that removing configuration keeps retained backups", async ({ page }) => {
    await expect(
      page.getByText(/Removing configuration never deletes retained backups/)
    ).toBeVisible();
  });

  test("remove-configuration confirmation names the consequence", async ({ page }) => {
    await page.getByRole("button", { name: /Remove set configuration/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Destructive action");
    await expect(dialog).toContainText(/stay on NAS storage/);
    await expect(dialog.getByRole("button", { name: "Remove configuration" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /^OK$/ })).toHaveCount(0);
  });

  test("protects the newest known-good backup", async ({ page }) => {
    await expect(page.getByText(/Newest known-good backup is protected/)).toBeVisible();
  });
});
