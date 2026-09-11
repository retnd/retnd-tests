import { withRetentionPolicyRestored } from "../harness/api";
import { expect, mockOnly, needs, test } from "./fixtures";

/**
 * Settings, catalog recovery and the retention policy form, against a real
 * deployment.
 *
 * This file has the suite's best case and its worst case in it.
 *
 * The best is "reports full build provenance". It reads seven rows off the
 * System information card and requires each to carry a value: service
 * version, API contract, backup engine, Go toolchain, configuration
 * revision, platform adapter, build commit. Against `createMockApi` all
 * seven were strings a fixture made up, so the case proved that a card
 * renders what it is given. Against this deployment every one of them
 * comes out of the running binary, which means the card is finally being
 * checked against the thing it claims to describe. #211's four removed
 * rows are in the same position: the argument for removing them was that
 * nothing in the running system computed them, and this is the run that
 * can say so.
 *
 * The worst is the version-mismatch block. A service speaking a different
 * /api/v1 contract than the bundle was built against is not a state a
 * deployment can be PUT into from outside: it needs two builds that
 * disagree. Both cases in it are marked as mock-only, with what it would
 * take written down.
 *
 * The retention-policy form is the one that both writes and must put back.
 * Two of its cases save a real policy through PATCH /settings, which is
 * the whole point of them, and both are wrapped so the deployment the next
 * twenty specs read is the one they started with.
 */
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
    // decorative selects wired to nothing (backupd#299). Neither
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
    // logo reads "backupd", which a page-wide /rclone/ would hit).
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
      "Backupd version", "Core version", "Database schema", "Architecture"
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
    mockOnly(
      "a service speaking a different /api/v1 contract than this bundle was built against. The mock " +
        "returned a version response saying so; a real deployment needs two builds that genuinely " +
        "disagree, so reaching it means serving an old engine behind a new UI bundle, which is a " +
        "second image rather than a state this one can be put into"
    );
    await bm.goto("/");

    // Scoped to the banner: the dashboard also raises a host-key alert in
    // this scenario, and "keeps information visible" is only worth
    // anything if the refusal it asserts is the version one.
    const banner = page.getByRole("alert").filter({ hasText: "Backupd update required" });
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

    // Every mutating control is disabled. The run button was "Run all due
    // sets" until #597's batch: "due" named a filter that does not exist,
    // since RunCycle walks every enabled set and skips only the disabled
    // and the edit-held. Only the name moved; what this line is about did
    // not.
    await expect(page.getByRole("button", { name: "Add backup set" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Run all enabled sets", exact: true })).toBeDisabled();
  });

  test("disables destructive controls on set detail", async ({ bm, page }) => {
    mockOnly("a service speaking a different /api/v1 contract (see the case above)");
    await bm.goto("/sets");
    await page.getByRole("article").first().getByRole("button", { name: "Open" }).click();

    await expect(page.getByRole("button", { name: /Apply retention now/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: /Remove set configuration/ })).toBeDisabled();
    // #597's per-set run belongs in this list for the same reason the
    // three around it do, and it is here because a control this page only
    // just grew is the obvious one for a later change to forget to switch
    // off. Its guard is unit-covered in the product, but a unit test is
    // not where an operator-visible regression gets caught.
    //
    // The title is asserted alongside the disabled state, and not as
    // decoration. This button is ALSO disabled when the set itself is
    // disabled, and a run would skip such a set anyway, so a bare
    // toBeDisabled() here could be satisfied by a reason that has nothing
    // to do with the service being incompatible. Pinning the enabled-set
    // wording is what rules that out: the product picks between two
    // sentences on exactly that condition, so reading this one back
    // proves the refusal on screen is the version one.
    const perSetRun = page.getByRole("button", { name: "Run this backup set", exact: true });
    await expect(perSetRun).toHaveAttribute("title", /one pass over this backup set only/);
    await expect(perSetRun).toBeDisabled();
    // "Run now" until #214, then "Run all due sets" until #597's batch.
    // The set-detail header's deployment-wide run button has been renamed
    // twice and for the same kind of reason both times: #214 because the
    // name claimed a per-set scope the API did not have, and #597's batch
    // because "due" named a filter that does not exist: RunCycle walks
    // every enabled set and skips only the disabled and the edit-held.
    // backup-sets.spec.ts covers both renames and the tooltips that have
    // to carry the two scopes apart. What this test is about is unchanged
    // through all of it: on an incompatible service it is off.
    await expect(page.getByRole("button", { name: "Run all enabled sets", exact: true })).toBeDisabled();
  });
});

/** Catalog recovery is real here, and it is one of the better arguments
 *  for the move: POST /catalog/scan and POST /catalog/rebuild really walk
 *  this deployment's backup storage, the preview counts are what the walk
 *  found, and "no files will be deleted, moved, or modified" is a claim
 *  about a real filesystem rather than about a fixture that never had one.
 *
 *  `?scenario=catalog-recovery` was the mock's way of putting a
 *  reconstructable catalogue in front of the flow; the flow itself is
 *  reachable from Settings on any deployment. */
test.describe("catalog recovery", () => {
  test("scan then rebuild, with no destructive step", async ({ bm, page }) => {
    needs(
      bm.facts.backups.length > 0,
      "at least one backup on storage for a scan to discover. A scan of an empty backup root " +
        "correctly finds nothing, and every count in the preview would be a zero"
    );
    await bm.goto("/settings");

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

  /** The values below are the product's DEFAULT chain, which is what a
   *  deployment nobody has edited is really running, so this reads the
   *  service's own configuration rather than a fixture's copy of it.
   *
   *  It is asserted against GET /settings in the same run rather than
   *  against the three literals it used to carry, because a deployment
   *  whose operator changed the chain is not a deployment this case
   *  should call broken. What it is about is that the form renders the
   *  chain the service reports, including the window unit, which the old
   *  literals could only imply. */
  test("renders the running chain, the custom period's window unit included", async ({ bm, page }) => {
    const settings = (await (await bm.api.get("/api/v1/settings")).json()) as {
      retention?: { tiers?: Array<{ name: string; keep: number; granularity?: string }> };
    };
    const tiers = settings.retention?.tiers ?? [];
    needs(tiers.length >= 2, "a retention chain with at least two tiers to render");

    await expect(tier(page, 1).getByLabel("Name")).toHaveValue(tiers[0].name);
    await expect(tier(page, 1).getByLabel("Keep")).toHaveValue(String(tiers[0].keep));
    // The default weekly tier buckets by week and looks back over calendar
    // months; a form that could not show that could not express the
    // default policy. The unit is a real control with a real value, so it
    // is read back rather than assumed.
    await expect(tier(page, 2).getByLabel("Window unit")).not.toHaveValue("");
    if (tiers.length >= 3) {
      await expect(tier(page, 3).getByLabel("Keep")).toHaveValue(String(tiers[2].keep));
    }
  });

  /** A real write, and the case that gained the most in this block. "In
   *  effect" used to mean the mock had updated an object in the browser;
   *  it now means PATCH /settings reached the service, the service wrote
   *  it, and a fresh read agrees. The last of those three is what the mock
   *  could not have: it WAS the store, so it could not disagree with
   *  itself.
   *
   *  Wrapped, because it leaves the deployment's retention chain edited
   *  and every spec after this one reads that chain. */
  test("saves an edited chain and reports it in effect", async ({ bm, page }) => {
    await withRetentionPolicyRestored(bm.api, async () => {
      const save = page.getByRole("button", { name: "Save retention policy" });
      await expect(save).toBeDisabled();

      await tier(page, 1).getByLabel("Keep").fill("10");
      await expect(save).toBeEnabled();
      await save.click();

      await expect(page.getByText(/Retention policy saved/)).toBeVisible();
      await expect(tier(page, 1).getByLabel("Keep")).toHaveValue("10");

      // And the service holds it, read back independently of the page that
      // wrote it.
      const settings = (await (await bm.api.get("/api/v1/settings")).json()) as {
        retention?: { tiers?: Array<{ keep: number }> };
      };
      expect(settings.retention?.tiers?.[0].keep).toBe(10);
    });
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

  /** Wrapped for the same reason as the case above, and more sharply:
   *  this one ends by really disabling last-known-good protection on the
   *  deployment, which is the single most consequential setting in the
   *  product. Leaving it off would change what a retention plan every
   *  later spec previews is allowed to delete. */
  test("warns and confirms before last-known-good protection is disabled", async ({ bm, page }) => {
    await withRetentionPolicyRestored(bm.api, () => lastKnownGoodCase(page));
  });

  async function lastKnownGoodCase(page: import("@playwright/test").Page) {
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
  }

  test("keeps the whole form read-only when the service is incompatible", async ({ bm, page }) => {
    mockOnly("a service speaking a different /api/v1 contract (see the version-mismatch block above)");
    await bm.goto("/settings");
    await expect(tier(page, 1).getByLabel("Keep")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Add tier" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save retention policy" })).toBeDisabled();
    await expect(page.getByLabel(/Protect the newest known-good backup/)).toBeDisabled();
  });
});

/**
 * backupd#240 (EPIC E, FR-27): the consent in front of the first
 * save that sends a retention tier's backups off local disk.
 *
 * Every case in this block is written against two declared mediums by
 * name, `offsite_s3` on STANDARD_IA and `offsite_cold` on DEEP_ARCHIVE,
 * and against the difference between them. That is the mock's declared
 * configuration, and a deployment with nothing declared has one entry in
 * this picker: the local hard drive.
 *
 * So the block states what it needs and the topology can satisfy it: a
 * deployment whose configuration declares an S3 medium on a content class
 * and another on an archive class. Neither has to be reachable for these
 * cases, because what they are about is the words in front of the
 * operator BEFORE anything is written, which is a claim about the form
 * and the configuration rather than about a bucket.
 *
 * That distinction is why these are `needs` rather than `mockOnly`: unlike
 * the version-mismatch block, a real deployment can genuinely be put into
 * this state, with two lines of configuration.
 */
test.describe("mapping a retention tier to a storage medium", () => {
  const tier = (page: import("@playwright/test").Page, n: number) =>
    page.getByRole("group", { name: "Tier " + n });

  test.beforeEach(async ({ bm, page }) => {
    needs(
      bm.facts.mediums.some((m) => m.archive !== true) && bm.facts.mediums.some((m) => m.archive === true),
      "a deployment declaring both a content-class storage medium and an archive-class one. This " +
        "block is entirely about telling those two apart in front of an operator, and a deployment " +
        "with neither has one destination and no choice to disclose"
    );
    await bm.goto("/settings");
    await expect(tier(page, 1)).toBeVisible();
  });

  test("names each medium's storage class, and which one needs a restore", async ({ bm, page }) => {
    const picker = tier(page, 1).getByLabel("Storage medium for tier 1");
    await expect(picker).toBeVisible();

    const content = bm.facts.mediums.find((m) => m.archive !== true)!;
    const archive = bm.facts.mediums.find((m) => m.archive === true)!;

    const options: string[] = await picker.locator("option").allTextContents();
    expect(options).toContain("Local backup root");
    // This deployment's own declared medium and its own storage class,
    // rather than the fixture's `offsite_s3 (STANDARD_IA)`. The claim was
    // never about those two words: it is that the class an operator is
    // choosing is named beside the medium, before they choose it.
    expect(
      options.some((o: string) => o.includes(content.id) && o.includes(content.storage_class ?? "")),
      "no option names " + content.id + " with its storage class"
    ).toBe(true);
    // The archive medium is labelled as one BEFORE it is chosen, and the
    // label now says the stronger thing: it cannot take delivery at all.
    // backupd#442 made config.Validate refuse a retention tier
    // bound to an archive class, because the move can never reach VERIFIED
    // (an archived copy's ceiling is existence) and FR-30 needs a content
    // -class ACTIVE placement it can never hold. So "needs a restore to
    // read" understated it: an operator picking it blind used to find out
    // hours later holding a restore request; now the config would not have
    // loaded. The option stays listed and disabled rather than vanishing,
    // because a medium that exists and cannot serve this purpose is a
    // different thing from one nobody declared.
    expect(
      options.some(
        (o: string) =>
          o.includes(archive.id) && /cannot receive backups: reads need a restore/.test(o)
      ),
      "no option names " + archive.id + " as one that cannot receive backups"
    ).toBe(true);
  });

  /** The one case in this block that WRITES, so it puts the chain back.
   *  Everything else here is about what the form says before anything is
   *  saved. */
  test("shows the deletion consequence, and keeps Save disabled until it is acknowledged", async ({ bm, page }) => {
    await withRetentionPolicyRestored(bm.api, async () => {
    const save = page.getByRole("button", { name: "Save retention policy" });
    await expect(save).toBeDisabled();

    await tier(page, 1)
      .getByLabel("Storage medium for tier 1")
      .selectOption(bm.facts.mediums.find((m) => m.archive !== true)!.id);

    const panel = page.getByRole("group", { name: "Storage medium disclosure" });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(/I delete the copy on this machine/i);
    await expect(panel).toContainText(/billed by your provider/i);
    // No figure comes with it: this product holds no price list, so a
    // number here could only be one it invented (backupd#211).
    const words = await panel.innerText();
    expect(words).not.toMatch(/\$\s?\d/);
    expect(words).not.toMatch(/per\s+(GB|TB|gigabyte)/i);

    // The chain is edited and valid, and Save is still refused. The only
    // thing missing is that somebody has read the paragraph.
    await expect(save).toBeDisabled();

    await panel.getByRole("checkbox").check();
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByText(/Retention policy saved/)).toBeVisible();
    });
  });

  test("says an archive class cannot be read at all, on top of the deletion", async ({ bm, page }) => {
    await tier(page, 1)
      .getByLabel("Storage medium for tier 1")
      .selectOption(bm.facts.mediums.find((m) => m.archive === true)!.id);

    const panel = page.getByRole("group", { name: "Storage medium disclosure" });
    await expect(panel).toContainText(/cannot be read on demand at all/i);
    // And no wait is estimated. The provider reports none.
    expect(await panel.innerText()).not.toMatch(/\b\d+\s*(hours|minutes)\b/);
  });

  test("forgets an acknowledgment given for a different destination", async ({ bm, page }) => {
    const picker = tier(page, 1).getByLabel("Storage medium for tier 1");
    const save = page.getByRole("button", { name: "Save retention policy" });

    await picker.selectOption(bm.facts.mediums.find((m) => m.archive !== true)!.id);
    await page.getByRole("group", { name: "Storage medium disclosure" }).getByRole("checkbox").check();
    await expect(save).toBeEnabled();

    // Somewhere materially different: an archive class nothing can read
    // without a restore. The tick was given for the other place. Nothing
    // is saved, so nothing has to be put back.
    await picker.selectOption(bm.facts.mediums.find((m) => m.archive === true)!.id);
    await expect(save).toBeDisabled();
  });

  test("does not ask again for a mapping the configuration already has", async ({ bm, page }) => {
    // A tier that ALREADY lives on a remote medium, so editing an
    // unrelated number on another tier is not a decision about where
    // backups live and must not raise the panel. A product that asked
    // every time would train an operator to tick the box without reading
    // it.
    //
    // The mock's fixture guaranteed such a tier existed (its monthly one
    // lived on offsite_s3). A real deployment has one only if somebody
    // pointed a tier at a medium, so the premise is read off the
    // configuration.
    const settings = (await (await bm.api.get("/api/v1/settings")).json()) as {
      retention?: { tiers?: Array<{ medium?: string }> };
    };
    const already = (settings.retention?.tiers ?? []).findIndex(
      (t) => t.medium !== undefined && t.medium !== "" && t.medium !== "local"
    );
    needs(
      already > 0,
      "a retention tier already pointed at a remote medium, and not the first one. Without it " +
        "there is no mapping the configuration already has, which is this case's whole subject"
    );
    await expect(tier(page, already + 1).getByLabel("Storage medium for tier " + (already + 1))).not.toHaveValue("local");

    await tier(page, 1).getByLabel("Keep").fill("9");
    await expect(page.getByRole("group", { name: "Storage medium disclosure" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save retention policy" })).toBeEnabled();
  });
});
