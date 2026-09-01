import { expect, test } from "./fixtures";

test.describe("settings", () => {
  test.beforeEach(async ({ bm }) => {
    await bm.goto("/settings");
  });

  test("exposes the documented service settings", async ({ page }) => {
    // "Default retention for new sets" used to be here, as a static row of
    // badges wired to nothing. B3.7 (#140) replaced it with the real,
    // writable Retention policy card asserted in its own describe below.
    //
    // "Polling interval" and "Log level" used to be here too, both
    // decorative selects wired to nothing (rclone-manager#299). Neither
    // is on the page any more: poll_interval is a real config key but a
    // duration in minutes, not the 15/30/60 seconds that select offered,
    // and there is no log-level concept in config.Config to wire the
    // other one to.
    for (const label of [
      "Storage warning threshold", "Storage critical threshold",
      "Retention policy"
    ]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(page.getByText("Polling interval", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Log level", { exact: true })).toHaveCount(0);
  });

  test("makes the platform abstraction explicit", async ({ page }) => {
    for (const label of ["Platform", "Integration", "Authentication", "Deployment", "Storage mount"]) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }
  });

  test("lists capabilities with an honest supported/unsupported marker", async ({ page }) => {
    for (const cap of [
      "Native authentication", "Native notifications", "Storage picker",
      "Embedded window", "App-store packaging"
    ]) {
      await expect(page.getByText(cap, { exact: true })).toBeVisible();
    }
  });

  test("does not present a missing capability as available", async ({ page }) => {
    // Generic has no native notifications, so the copy must say so.
    await expect(page.getByText(/Native NAS notifications are not available/)).toBeVisible();
    await expect(page.getByText(/webhook notifications are enabled/i)).toBeVisible();
  });

  test("reports full build provenance", async ({ page }) => {
    // Scoped to the card, so a label that turns up elsewhere on the page
    // does not count as provenance, and so the negatives below can be
    // about this card rather than about the whole app (the shell's own
    // logo reads "rclone-manager", which a page-wide /rclone/ would hit).
    // The card is a plain <section> with an <h2>, not a landmark, so it is
    // located by its heading.
    const provenance = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "System information", exact: true }) });
    const row = (label: string) =>
      provenance.locator("dt").filter({ hasText: label }).locator("xpath=following-sibling::dd[1]");

    // Each row is asserted with the value beside it, not just the label:
    // an empty provenance card is the failure this test exists to catch.
    await expect(row("Service version")).toHaveText(/\S/);
    await expect(row("API contract")).toHaveText(/^v\d+$/);
    await expect(row("Backup engine")).toHaveText(/\S/);
    await expect(row("Go toolchain")).toHaveText(/^go\d/);
    await expect(row("Configuration revision")).toHaveText(/\S/);
    await expect(row("Platform adapter")).toHaveText(/\S/);
    await expect(row("Build commit")).toHaveText(/\S/);

    // #211 removed four rows from this card, and this is the record of
    // which, so a later reader can tell a deliberate removal from an
    // assertion that was quietly deleted to reach green. A "Backup
    // Manager version" separate from the service's, a "Core version", a
    // database schema number and a build architecture: the version
    // endpoint has never reported any of the four, so every value the UI
    // showed for them came from the dev-server mock. None of the four has
    // a replacement, here or anywhere else. "Embedded rclone" is the one
    // that was renamed rather than dropped: it is "Backup engine" now,
    // because the public contract does not name the implementation, and
    // it is asserted above.
    for (const gone of [
      "Backup Manager version", "Core version", "Database schema", "Architecture"
    ]) {
      await expect(provenance.getByText(gone, { exact: true })).toHaveCount(0);
    }
    // Control for those four zeros: the same query shape, on a label that
    // is in this card, finds exactly one.
    await expect(provenance.getByText("Service version", { exact: true })).toHaveCount(1);
    await expect(provenance.getByText(/rclone/i)).toHaveCount(0);
  });
});

test.describe("version mismatch", () => {
  test("disables management but keeps information visible", async ({ bm, page }) => {
    await bm.goto("/", "version-mismatch");

    // Scoped to the banner: the dashboard also raises a host-key alert in
    // this scenario, and "keeps information visible" is only worth
    // anything if the refusal it asserts is the version one.
    const banner = page.getByRole("alert").filter({ hasText: "Backup Manager update required" });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/management actions have been disabled/);

    // The mismatch is between the /api/v1 contract this interface was
    // built against and the one the service speaks. It used to be stated
    // as "UI 1.3.0 · Service 1.2.0", and the first of those two numbers
    // had no source: nothing reports a version for the interface itself,
    // so #211 removed it. A banner that names one version cannot describe
    // a mismatch, so the honest pair is the service and the contract it
    // speaks, and that pair is what is asserted here.
    await expect(banner).toContainText(/\/api\/v1 contract/);
    await expect(banner).toContainText(/Service 1\.2\.0 speaks contract v0/);
    // Deliberate removal, and its control underneath: the interface still
    // has no version of its own, so nothing in this banner may claim one.
    await expect(banner.getByText(/UI \d+\.\d+\.\d+/)).toHaveCount(0);
    await expect(banner.getByText(/Service \d+\.\d+\.\d+/)).toHaveCount(1);

    // Read-only information still renders.
    await expect(page.getByText(/^BACKUPS /)).toBeVisible();
    await expect(page.getByRole("region", { name: "Key metrics" })).toBeVisible();

    // Every mutating control is disabled.
    await expect(page.getByRole("button", { name: "Add backup set" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Run all due sets" })).toBeDisabled();
  });

  test("disables destructive controls on set detail", async ({ bm, page }) => {
    await bm.goto("/sets", "version-mismatch");
    await page.getByRole("article").first().getByRole("button", { name: "Open" }).click();

    await expect(page.getByRole("button", { name: /Apply retention now/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: /Remove set configuration/ })).toBeDisabled();
    // "Run now" until #214. The set-detail header's run button is
    // deployment-wide now and is named for that; backup-sets.spec.ts
    // covers the rename and the tooltip that has to carry it. What this
    // test is about is unchanged: on an incompatible service it is off.
    await expect(page.getByRole("button", { name: "Run all due sets", exact: true })).toBeDisabled();
  });
});

test.describe("catalog recovery", () => {
  test("scan then rebuild, with no destructive step", async ({ bm, page }) => {
    await bm.goto("/settings", "catalog-recovery");

    await page.getByRole("button", { name: "Scan backup storage" }).click();
    await expect(bm.heading("Catalog recovery")).toBeVisible();
    await expect(page.getByText(/No files will be deleted, moved, or modified/)).toBeVisible();

    await page.getByRole("button", { name: "Scan backup storage" }).click();
    await expect(page.getByText("Catalog rebuild preview")).toBeVisible();
    await expect(page.getByText("Backup artifacts discovered")).toBeVisible();
    await expect(page.getByText("Require review")).toBeVisible();
    await expect(page.getByText(/placed in Quarantine, not deleted/)).toBeVisible();

    await page.getByRole("button", { name: "Rebuild catalog" }).click();
    const dialog = page.getByRole("dialog", { name: "Rebuild catalog" });
    await expect(dialog).toContainText(/This operation is additive/);
    await expect(dialog).toContainText(/No backup files are deleted/);
    await expect(dialog.getByRole("button", { name: /^Rebuild from \d+ artifacts$/ })).toBeVisible();

    await dialog.getByRole("button", { name: /Rebuild from/ }).click();
    await expect(bm.heading("Backups")).toBeVisible();
  });
});

/** B3.7 (#140) — the retention policy form, exercised through the running
 *  app rather than a mounted component: the chain the service reports is
 *  what the form renders, an edit round-trips through the settings write
 *  endpoint, and disabling last-known-good protection is confirmed before
 *  anything is written. */
test.describe("retention policy", () => {
  const tier = (page: import("@playwright/test").Page, n: number) =>
    page.getByRole("group", { name: "Tier " + n });

  test.beforeEach(async ({ bm, page }) => {
    await bm.goto("/settings");
    await expect(tier(page, 1)).toBeVisible();
  });

  test("renders the running chain, the custom period's window unit included", async ({ page }) => {
    await expect(tier(page, 1).getByLabel("Name")).toHaveValue("daily");
    await expect(tier(page, 1).getByLabel("Keep")).toHaveValue("7");
    // The default weekly tier buckets by week and looks back over calendar
    // months; a form that could not show that could not express the
    // default policy.
    await expect(tier(page, 2).getByLabel("Window unit")).toHaveValue("month");
    await expect(tier(page, 3).getByLabel("Keep")).toHaveValue("12");
  });

  test("saves an edited chain and reports it in effect", async ({ page }) => {
    const save = page.getByRole("button", { name: "Save retention policy" });
    await expect(save).toBeDisabled();

    await tier(page, 1).getByLabel("Keep").fill("10");
    await expect(save).toBeEnabled();
    await save.click();

    await expect(page.getByText(/Retention policy saved/)).toBeVisible();
    await expect(tier(page, 1).getByLabel("Keep")).toHaveValue("10");
  });

  test("refuses a reserved tier name before it can be submitted", async ({ page }) => {
    await tier(page, 1).getByLabel("Name").fill("last_known_good");
    await expect(page.getByText(/reserved for last-known-good protection/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Save retention policy" })).toBeDisabled();

    // The control: the same field, spelled legally, clears the refusal.
    await tier(page, 1).getByLabel("Name").fill("hourly_ish");
    await expect(page.getByText(/reserved for last-known-good protection/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save retention policy" })).toBeEnabled();
  });

  test("never offers a way to empty the chain", async ({ page }) => {
    for (let i = 0; i < 2; i++) {
      await tier(page, 1).getByRole("button", { name: "Remove tier 1" }).click();
    }
    await expect(page.getByRole("group", { name: "Tier 2" })).toHaveCount(0);
    await expect(tier(page, 1).getByRole("button", { name: "Remove tier 1" })).toBeDisabled();
    await expect(
      page.getByText(/an empty chain reinstates the default daily\/weekly\/monthly policy/i)
    ).toBeVisible();
  });

  test("warns and confirms before last-known-good protection is disabled", async ({ page }) => {
    const toggle = page.getByLabel(/Protect the newest known-good backup/);
    await expect(toggle).toBeChecked();

    await toggle.uncheck();
    await expect(page.getByText(/materially more dangerous configuration/i).first()).toBeVisible();

    await page.getByRole("button", { name: "Save retention policy" }).click();

    const dialog = page.getByRole("dialog", { name: /Disable last-known-good protection/i });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/materially more dangerous configuration/i);
    await expect(dialog).toContainText(/Nothing is deleted by this change on its own/i);
    // The write has not happened: the confirmation stands in front of it.
    await expect(page.getByText(/Retention policy saved/)).toHaveCount(0);

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(/Retention policy saved/)).toHaveCount(0);
    await expect(toggle).not.toBeChecked();

    await page.getByRole("button", { name: "Save retention policy" }).click();
    await page
      .getByRole("dialog", { name: /Disable last-known-good protection/i })
      .getByRole("button", { name: "Disable protection" })
      .click();
    await expect(page.getByText(/Retention policy saved/)).toBeVisible();
  });

  test("keeps the whole form read-only when the service is incompatible", async ({ bm, page }) => {
    await bm.goto("/settings", "version-mismatch");
    await expect(tier(page, 1).getByLabel("Keep")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Add tier" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save retention policy" })).toBeDisabled();
    await expect(page.getByLabel(/Protect the newest known-good backup/)).toBeDisabled();
  });
});
