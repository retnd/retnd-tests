import { destructive, expect, needs, test } from "./fixtures";

/**
 * §17 and §35 — the highest-consequence flow in the product, and the one
 * place in this suite where running against a real deployment has a cost
 * rather than only a benefit.
 *
 * The PREVIEW is pure gain. `previewRetention` is a real GET that makes
 * the service compute a real plan over this deployment's real catalogue
 * and hand back a real plan id, and every case up to the confirmation
 * reads that plan. Against the mock, the plan id was a string a fixture
 * made up and "the plan the service issued" was a sentence nobody could
 * check.
 *
 * The APPLY is not. It permanently deletes retained backup files, on the
 * one deployment every other spec in this run is reading, and there is no
 * undo. So the case that clicks it through says `destructive()` and runs
 * only when the run has been told the deployment is disposable. That is a
 * deliberate refusal to make the suite quietly destructive by default, not
 * a case that was turned off because it went red.
 *
 * One case did lose its subject entirely, and it is marked rather than
 * deleted: the refused-artifact case was written against a "sibling-prefix
 * directory" verdict the mock's plan carried, and a refusal is a property
 * of what is on disk. Its note says what a deployment would have to hold.
 */
test.describe("retention preview and apply", () => {
  test.beforeEach(async ({ bm, page }) => {
    needs(bm.facts.configured, "a configured deployment");
    needs(bm.facts.sets.length > 0, "at least one backup set to preview a plan for");
    needs(
      bm.facts.backups.length > 0,
      "at least one retained backup: a plan over an empty catalogue keeps nothing and deletes " +
        "nothing, and every case below is about how that plan is presented"
    );
    await bm.goto("/sets");
    await page.getByRole("article").first().getByRole("button", { name: "Open" }).click();
    // exact: true — the detail page also has a "Preview retention plan"
    // button further down (Retention section); non-exact matching is
    // ambiguous between the two once the page is actually reachable.
    await page.getByRole("button", { name: "Preview retention", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Retention preview" })).toBeVisible();
    // The dialog renders immediately with "Requesting plan…" while
    // previewRetention() is still in flight. Wait for the plan to actually
    // resolve before any test runs.
    await expect(page.getByText(/Plan retplan_.* issued by the backup service/)).toBeVisible();
  });

  test("shows the server-issued plan id", async ({ page }) => {
    // "Issued by the backup service" is finally a claim rather than a
    // caption: this id came out of a real GET on a real plan, and the
    // apply path submits that exact id back (§29.3). The mock made one up
    // and nothing on either side could disagree.
    await expect(page.getByText(/Plan retplan_.* issued by the backup service/)).toBeVisible();
  });

  test("summarises keep, delete and reclaim", async ({ page }) => {
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Keep", { exact: true }).first()).toBeVisible();
    await expect(dialog.getByText("Delete", { exact: true }).first()).toBeVisible();
    await expect(dialog.getByText("Reclaim")).toBeVisible();
  });

  test("itemises what is kept and why, and what is deleted and why", async ({ page }) => {
    const dialog = page.getByRole("dialog");

    // The kept half, unchanged: last-known-good protection is a reason
    // this plan states on the artifact it applies to.
    await expect(dialog.getByText("Protected").first()).toBeVisible();

    // The deleted half was pinned to "Not selected by current retention
    // policy", which is the mock's summary of a verdict. The engine's own
    // sentence is a different and much better thing, and the first real
    // run is what showed it:
    //
    //   no configured GFS retention tier selects this artifact and it
    //   does not hold last-known-good protection; its canonical path was
    //   confirmed beneath the backup-set root, confirmed a final managed
    //   artifact, and confirmed not a symlink; sibling collision: ...
    //
    // So what is asserted is what the case is named for, against whatever
    // the engine says rather than against a fixture's paraphrase: the row
    // names the rule that reached the verdict, and it is a REASON rather
    // than a label. The length check is the second half of that and is
    // not decoration: "no" would satisfy a bare presence check, and a
    // deletion this product cannot explain is the thing §17 is about.
    const deleted = dialog.getByRole("listitem").filter({ hasText: /retention/i });
    await expect(deleted.first()).toBeVisible();
    const reason = await deleted.first().innerText();
    expect(reason).toMatch(/retention tier selects this artifact|Not selected by current retention policy/i);
    expect(reason.length, "the deletion reason is a label rather than an explanation").toBeGreaterThan(40);
  });

  // §96 design pass: a refused delete is a third, deliberate verdict
  // (FR-20), not an error — it must read as calm and informational, never
  // as a fault the operator has to dismiss.
  //
  // What this needs is a plan carrying a refusal, and a refusal is the
  // engine declining to delete something it does not have a safe claim on.
  // The mock's plan always carried one, against a "sibling-prefix
  // directory"; on a real deployment the engine only refuses when the
  // catalogue really contains an artifact it will not act on, which the
  // topology can arrange by putting a stray directory alongside a backup
  // on the source machine.
  //
  // The premise is measured rather than assumed, and the negative half of
  // the case runs either way: whatever this plan holds, the danger banner
  // must not be part of it.
  test("shows a refused artifact calmly, not as an error", async ({ page }) => {
    const dialog = page.getByRole("dialog");

    // True of every plan, refusal or not, and the half that would catch a
    // regression that painted a refusal as a fault.
    await expect(dialog.locator(".banner--danger")).toHaveCount(0);

    const refuseSection = dialog.getByText(/^Refuse/);
    needs(
      (await refuseSection.count()) > 0,
      "a retention plan carrying a refused artifact. The engine refuses only what it has no safe " +
        "claim on, so this deployment's catalogue has to contain one"
    );
    await expect(refuseSection).toBeVisible();

    const refusedRow = dialog.locator(".banner--info").first();
    await expect(refusedRow).toBeVisible();
    // Never the alert role — that is reserved for genuine faults (a broken
    // transfer, an unreachable host).
    await expect(refusedRow).not.toHaveAttribute("role", "alert");
  });

  test("confirmation names the exact count and reclaimed size", async ({ page }) => {
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Continue…" }).click();

    const confirm = page.getByRole("dialog", { name: "Apply retention" });
    await expect(confirm).toContainText("Destructive action");
    await expect(confirm).toContainText(/\d+ retained backup files will be permanently removed/);
    await expect(confirm).toContainText(/will be reclaimed/);
    await expect(confirm).toContainText(/will not be recalculated/);
    await expect(confirm).toContainText(/newest known-good backup is protected/);
  });

  test("the confirm button states the consequence and is not the default focus", async ({ page }) => {
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Continue…" }).click();

    const confirm = page.getByRole("dialog", { name: "Apply retention" });
    await expect(confirm.getByRole("button", { name: /^Delete \d+ backups$/ })).toBeVisible();
    await expect(confirm.getByRole("button", { name: /^OK$/ })).toHaveCount(0);
    await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  });

  test("Escape cancels without deleting anything", async ({ page }) => {
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Continue…" }).click();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Apply retention" })).toHaveCount(0);
  });

  test("clicking the scrim dismisses the preview", async ({ page }) => {
    await page.locator(".dialog-scrim").click({ position: { x: 5, y: 5 } });
    await expect(page.getByRole("dialog", { name: "Retention preview" })).toHaveCount(0);
  });

  // §29.3's full wizard flow: obtain a plan, present counts, confirm,
  // submit that exact plan_id, and the dialog closes on success.
  //
  // The only case in this suite that destroys something. Against the mock
  // it closed a dialog; here it permanently deletes retained backup files
  // from the deployment every other spec in this run is reading, and
  // nothing puts them back. So it runs only when the run says the
  // deployment is disposable.
  test("confirming applies the exact reviewed plan and closes the dialog", async ({ page }) => {
    destructive();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Continue…" }).click();

    const confirm = page.getByRole("dialog", { name: "Apply retention" });
    await confirm.getByRole("button", { name: /^Delete \d+ backups$/ }).click();

    await expect(page.getByRole("dialog", { name: "Apply retention" })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Retention preview" })).toHaveCount(0);
  });
});
