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
    await expect(card.getByRole("button", { name: "Test connection" })).toBeVisible();
    // A card carries no run control at all since #231, and this line used
    // to assert one named "Run now". It kept passing after #214 rewired
    // that button's handler to api.runCycle(), which runs one pass over
    // EVERY enabled backup set: the label still existed, so the assertion
    // was still true and had stopped meaning what it said. The two
    // assertions above are this zero's control, so an empty card or a
    // renamed role cannot satisfy it by matching nothing.
    await expect(card.getByRole("button", { name: /run/i })).toHaveCount(0);
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

  // This test was "a halted set cannot be run", and it asserted that one
  // card's "Run now" button was disabled. It proved less than its name
  // twice over (#231). The button it named ran a deployment-wide cycle,
  // so every OTHER card's identical button still started the very run it
  // claimed was refused; and the `halted` flag doing the disabling was a
  // field nothing computed, filled with a literal `false` by the HTTP
  // client on every set, so against a real service the disabled state it
  // asserted never occurred at all.
  //
  // What is worth asserting is where the run control lives and whether it
  // says how far it reaches, so that is what this now checks.
  test("the run control belongs to the page, not to a card, and says how far it reaches", async ({ bm, page }) => {
    await bm.goto("/sets");

    const header = page.getByRole("heading", { level: 1 }).locator("xpath=../..");
    // "Run all due sets" until #597's batch renamed it, and the rename is
    // the same class of correction as #214's above: "due" named a filter
    // that does not exist. RunCycle walks every ENABLED set and skips
    // only the disabled and the edit-held, so no set is ever due, and the
    // label was contradicting the tooltip printed right beside it.
    //
    // The tooltip is the half that was true both times, which is why it
    // is the half this test has always leaned on.
    const run = header.getByRole("button", { name: "Run all enabled sets", exact: true });
    await expect(run).toBeVisible();
    // The tooltip, not just the label. A label alone cannot say that this
    // button walks every enabled backup set, and asserting only the label
    // is how a rewired handler passed under a stale name through #214.
    await expect(run).toHaveAttribute("title", /every enabled backup set, not only this one/);
    // One of it on the whole page, however many sets are configured.
    await expect(page.getByRole("button", { name: "Run all enabled sets", exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Run now", exact: true })).toHaveCount(0);

    const cards = page.getByRole("article");
    await expect(cards.first()).toBeVisible();
    const count = await cards.count();
    expect(count).toBeGreaterThan(1);
    for (let i = 0; i < count; i++) {
      await expect(cards.nth(i).getByRole("button", { name: /run/i })).toHaveCount(0);
      // Control for each zero: the same query shape, on a button every
      // card really does carry, finds exactly one.
      await expect(cards.nth(i).getByRole("button", { name: "Open", exact: true })).toHaveCount(1);
    }

    // A set the manager has stopped still says so, in the sentence that
    // explains its state rather than in a status word derived from a flag
    // the service never sends.
    await expect(cards.filter({ hasText: "Failing" }).first()).toContainText(/halted/i);
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
    for (const action of [
      "Run this backup set", "Run all enabled sets", "Test connection", "Edit", "Preview retention"
    ]) {
      await expect(header.getByRole("button", { name: action, exact: true })).toBeVisible();
    }

    // Two run controls now, with two scopes, and each one's tooltip is
    // asserted rather than just its name.
    //
    // There was one, called "Run now", until #214 found it calling the
    // deployment-wide cycle: a button named for the set on screen started
    // every enabled set, so it claimed something the API could not do.
    // #214 renamed it for what it did. #597 then built the per-set run
    // for real. The engine half had existed since FR-1 behind
    // `rbm fetch --backup-set`, and what was missing was a way
    // to reach it inside the serving process, so the header carries both
    // today. A pair like that is only honest while each says which one it
    // is, and a name alone cannot: that is exactly how the rewired
    // handler passed under a stale name through #214. So both titles are
    // pinned, and "Run now" must not come back under either meaning.
    //
    // The deployment-wide one also lost "due" in #597's batch, because
    // RunCycle walks every ENABLED set and skips only the disabled and
    // the edit-held, so nothing is ever due.
    await expect(header.getByRole("button", { name: "Run this backup set", exact: true }))
      .toHaveAttribute("title", /one pass over this backup set only/);
    await expect(header.getByRole("button", { name: "Run all enabled sets", exact: true }))
      .toHaveAttribute("title", /every enabled backup set, not only this one/);
    // The loop above is this zero's control: the same getByRole shape,
    // with exact names, finds five buttons on this page.
    await expect(page.getByRole("button", { name: "Run now", exact: true })).toHaveCount(0);

    // Edit is a mode (#350), so the header's shape depends on whether it
    // is open, and "what the header offers" is not answered until both
    // states are looked at. #591 added the second way out: CANCEL & EXIT
    // EDIT MODE discards the draft and leaves the persisted values alone,
    // beside SAVE ALL & EXIT EDIT which writes it.
    //
    // The absence is asserted before the mode is opened rather than only
    // the presence after, because a build that showed both exits all the
    // time would satisfy a bare presence check while offering an operator
    // a "discard the draft" button with no draft to discard.
    for (const exit of ["SAVE ALL & EXIT EDIT", "CANCEL & EXIT EDIT MODE"]) {
      await expect(header.getByRole("button", { name: exit, exact: true })).toHaveCount(0);
    }
    await header.getByRole("button", { name: "Edit", exact: true }).click();
    for (const exit of ["SAVE ALL & EXIT EDIT", "CANCEL & EXIT EDIT MODE"]) {
      await expect(header.getByRole("button", { name: exit, exact: true })).toBeVisible();
    }
    // And Edit itself is gone while the mode is open, which is what makes
    // those two the only ways out of it. This zero has the two visible
    // assertions above as its control, in the same header locator.
    await expect(header.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
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
