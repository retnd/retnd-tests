import { expect, test } from "./fixtures";
import type { BackupManager } from "./fixtures";

test.describe("backups table", () => {
  test.beforeEach(async ({ bm }) => {
    await bm.goto("/backups");
  });

  test("is called Backups, never Restore points", async ({ bm, page }) => {
    await expect(bm.heading("Backups")).toBeVisible();
    expect(await page.locator("body").innerText()).not.toMatch(/restore point/i);
  });

  test("states plainly that it does not perform restore", async ({ page }) => {
    await expect(
      page.getByText(/does not perform application restore .* retained, verified copies/)
    ).toBeVisible();
  });

  test("renders a real table with all seven documented columns", async ({ page }) => {
    const table = page.getByRole("table");
    await expect(table).toBeVisible();
    for (const col of ["Time", "Backup set", "Artifact", "Size", "Validation", "Retention", "Status"]) {
      await expect(table.getByRole("columnheader", { name: col })).toBeVisible();
    }
  });

  test("uses column headers, not styled divs", async ({ page }) => {
    // Eight on this fixture, not seven: the Medium column is here because
    // a backup on this instance has a copy somewhere other than the local
    // backup root. The no-medium scenario below is where the count is
    // seven, and the pair is the assertion, not either number alone.
    await expect(page.getByRole("columnheader")).toHaveCount(8);
    const rows = await page.getByRole("row").count();
    expect(rows).toBeGreaterThan(1);
  });

  test("a backup can hold several retention classifications at once", async ({ page }) => {
    const multi = page.getByRole("row").filter({ hasText: "Daily" }).filter({ hasText: "Weekly" });
    await expect(multi.first()).toBeVisible();
  });

  test("marks the protected artifact distinctly", async ({ page }) => {
    await expect(page.getByText("Protected").first()).toBeVisible();
  });

  test("validation shows a glyph and a word, not just colour", async ({ page }) => {
    const cell = page.getByRole("row").nth(1);
    await expect(cell).toContainText(/Verified|Failed|Pending/);
  });

  test("status distinguishes removed from retained remote sources", async ({ page }) => {
    await expect(page.getByText(/Remote source (removed|retained)/).first()).toBeVisible();
  });

  test("filters by backup set", async ({ page }) => {
    const before = await page.getByRole("row").count();
    await page.getByLabel("Filter by backup set").selectOption({ index: 1 });
    await expect(page.getByRole("row")).not.toHaveCount(before);
  });

  test("retention preview requires a set to be chosen first", async ({ page }) => {
    await expect(page.getByRole("button", { name: "Preview retention" })).toBeDisabled();
    await page.getByLabel("Filter by backup set").selectOption({ index: 1 });
    await expect(page.getByRole("button", { name: "Preview retention" })).toBeEnabled();
  });

  test("row click opens the artifact detail", async ({ page }) => {
    await page.getByRole("row").nth(1).click();
    await expect(page.getByText("Artifact ID")).toBeVisible();
  });

  test("offers no arbitrary file-delete action", async ({ page }) => {
    await expect(page.getByRole("button", { name: /delete remote/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^delete file/i })).toHaveCount(0);
  });

  test("empty install explains what has not happened yet", async ({ bm, page }) => {
    await bm.goto("/backups", "empty");
    await expect(page.getByText("No backups yet")).toBeVisible();
    await expect(page.getByText(/has not completed its first successful ingestion/)).toBeVisible();
  });
});

test.describe("backup detail", () => {
  test.beforeEach(async ({ bm, page }) => {
    await bm.goto("/backups");
    await page.getByRole("row").nth(1).click();
  });

  test("shows every documented artifact field", async ({ page }) => {
    // "Ingestion path", not "Local path". The old label read as "this is
    // where your backup is", which the field has never meant: it is where
    // ingestion landed, and it stays populated for a transfer still
    // running and for a backup whose local copy has since moved to a
    // storage medium. The Copies card asserted below is what answers the
    // other question now.
    for (const label of [
      "Artifact ID", "Backup set", "Remote original", "Ingestion path",
      "Producer timestamp", "Received timestamp", "Size", "Checksum",
      "Validation result", "Retention classes", "Remote source removed"
    ]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
  });

  test("renders the lifecycle in the only correct order", async ({ page }) => {
    const timeline = page.getByRole("region", { name: "Lifecycle" }).or(page.locator("ol").last());
    const text = await timeline.innerText();

    const order = [
      "DISCOVERED", "TRANSFERRED", "VERIFIED", "COMMITTED",
      "SAFE STATE PERSISTED", "REMOTE SOURCE DELETED"
    ];
    const positions = order.map((label) => text.indexOf(label));

    for (const p of positions) expect(p).toBeGreaterThan(-1);
    for (let i = 1; i < positions.length; i++) {
      // Remote deletion can never precede commit (§15).
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });

  test("timestamps every reached phase", async ({ page }) => {
    const timeline = page.locator("ol").last();
    await expect(timeline).toContainText(/\d{2}:\d{2}:\d{2}/);
  });

  test("frames remote deletion as a consequence, not an action", async ({ page }) => {
    await expect(
      page.getByText(/lifecycle consequence of a proven NAS copy .* never an independent file operation/)
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /delete/i })).toHaveCount(0);
  });

  test("returns to the table", async ({ bm, page }) => {
    await page.getByRole("button", { name: /Backups/ }).first().click();
    await expect(bm.heading("Backups")).toBeVisible();
  });
});

/**
 * rclone-manager#240 (EPIC E, FR-34): where a backup's copies actually
 * are, and which of them anybody can read.
 *
 * Everything below is one question asked in different words: does this
 * surface tell "there is no copy" apart from "there is a copy nobody can
 * confirm" apart from "there is a copy nobody has checked"?
 *
 * That is not a stylistic worry. rclone-manager#361 was a run cycle that
 * backed nothing up and reported success. A row reading "stored on
 * offsite_s3" for an unconfirmable copy, or a tick beside an unverified
 * one, is the same defect rendered in HTML, and an operator finds out it
 * was decorative at the one moment it matters.
 */
test.describe("where a backup's copies are", () => {
  const copies = (page: import("@playwright/test").Page) =>
    page.getByRole("region", { name: "Copies" });

  async function openBackup(bm: BackupManager, page: import("@playwright/test").Page, filename: string) {
    await bm.goto("/backups");
    await page.getByRole("row").filter({ hasText: filename }).click();
    await expect(copies(page)).toBeVisible();
  }

  test("lists one row per durable copy, with where it is and what it is on", async ({ bm, page }) => {
    await openBackup(bm, page, "postgres-prod-20260828.dump.zst");

    const card = copies(page);
    for (const col of ["Where", "Location", "Copy size", "Class", "Access", "Verification"]) {
      await expect(card.getByRole("columnheader", { name: col })).toBeVisible();
    }
    await expect(card.getByText("Local backup root")).toBeVisible();
    await expect(card.getByText("offsite_s3")).toBeVisible();
    await expect(card.getByText("STANDARD_IA")).toBeVisible();
  });

  test("reports the verification each copy actually achieved, never a stronger one", async ({ bm, page }) => {
    await openBackup(bm, page, "postgres-prod-20260828.dump.zst");

    const card = copies(page);
    // Two copies of one backup, verified to different depths, and the
    // page says so. An existence check reported as content verification
    // is worse than no check at all: it turns "nobody has read these
    // bytes in a year" into a green tick.
    await expect(card.getByText("Content verified")).toBeVisible();
    await expect(card.getByText("Existence only")).toBeVisible();
    // The backend's own words for what the weaker rung proves, rather
    // than the frontend's summary of them.
    await expect(card.getByText(/Proves an object exists at the recorded key/i)).toBeVisible();
  });

  test("says an archive copy needs a restore before anybody plans around it", async ({ bm, page }) => {
    await openBackup(bm, page, "billing-20260827.sql.gz");

    const card = copies(page);
    await expect(card.getByText("DEEP_ARCHIVE")).toBeVisible();
    await expect(card.getByText("Needs a restore")).toBeVisible();
    // Twice, deliberately: once on the row and once in the footer's
    // disclosure. `first()` rather than a narrower matcher because both
    // are true statements about this copy and a spec that pinned one
    // spelling would break on a reworded footer.
    await expect(card.getByText(/cannot be read on demand/i).first()).toBeVisible();
    // No estimate anywhere. The provider reports no progress and no
    // completion time, so a number here could only be invented.
    await expect(card.getByText(/\b\d+\s*(hours|minutes)\b/)).toHaveCount(0);
    await expect(card.getByText("Readable now")).toHaveCount(0);
  });

  test("says nothing can confirm a copy on a medium it cannot reach, and does not call it gone", async ({ bm, page }) => {
    await bm.goto("/quarantine");
    await page.getByRole("row").filter({ hasText: "billing-20260824.sql.gz" }).first().click();
    // Reached through the backups list rather than quarantine's own
    // actions, so this stays a test about the copies card.
    await bm.goto("/backups/art_01J9C1XY7T09");

    const card = copies(page);
    await expect(card.getByText("Out of reach")).toBeVisible();
    await expect(card.getByText(/nothing here can confirm this copy/i)).toBeVisible();
    await expect(card.getByText(/not the same as the copy being gone/i)).toBeVisible();
    await expect(card.getByText("Readable now")).toHaveCount(0);
  });

  test("says there is no copy at all, rather than showing the ingestion path as one", async ({ bm, page }) => {
    await openBackup(bm, page, "media-week34.tar");

    const card = copies(page);
    await expect(card.getByText("No confirmed copy yet")).toBeVisible();
    await expect(card.getByText(/a partial file is not a copy/i)).toBeVisible();
    // The ingestion path is on the page, labelled as what it is, and it is
    // not inside the list of copies. That is the assertion: not that the
    // path is hidden, but that it is not presented as storage.
    await expect(page.getByText("Ingestion path", { exact: true })).toBeVisible();
    await expect(card.getByText("/data/backups/media/2026/w34/media-week34.tar")).toHaveCount(0);
  });

  test("states that retrieval is billed, and shows no figure for it", async ({ bm, page }) => {
    await openBackup(bm, page, "postgres-prod-20260828.dump.zst");

    await expect(copies(page).getByText(/billed by your provider/i)).toBeVisible();
    // rclone-manager#211's rule: this product holds no price list and
    // does not know what an operator negotiated, so a figure would be one
    // it made up.
    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(/\$\s?\d/);
    expect(text).not.toMatch(/per\s+(GB|TB|gigabyte)/i);
  });

  test("shows a Medium column, and flags the copies nobody can reach", async ({ bm, page }) => {
    await bm.goto("/backups");

    const table = page.getByRole("table");
    await expect(table.getByRole("columnheader", { name: "Medium" })).toBeVisible();
    await expect(table.getByText("offsite_cold")).toBeVisible();
    // A backup still arriving has no copy, and the cell says so rather
    // than being blank, which would read as "the column does not apply".
    await expect(
      page.getByRole("row").filter({ hasText: "media-week34.tar" }).getByText("No copy yet")
    ).toBeVisible();
  });
});

/**
 * FR-35's compatibility line, in a browser. A deployment that declares no
 * storage medium gets the pages it already had, and this is the only place
 * that can be checked end to end rather than argued.
 */
test.describe("a deployment that never heard of storage mediums", () => {
  test("has no Medium column, and exactly the seven columns it always had", async ({ bm, page }) => {
    await bm.goto("/backups", "no-medium");

    const table = page.getByRole("table");
    await expect(table).toBeVisible();
    await expect(page.getByRole("columnheader")).toHaveCount(7);
    await expect(table.getByRole("columnheader", { name: "Medium" })).toHaveCount(0);
    // The positive control: the table really rendered rows, so the
    // absence above is the absence of a column and not of the page.
    expect(await page.getByRole("row").count()).toBeGreaterThan(1);
  });

  test("still says where each backup's one copy is", async ({ bm, page }) => {
    await bm.goto("/backups", "no-medium");
    await page.getByRole("row").nth(1).click();

    const card = page.getByRole("region", { name: "Copies" });
    await expect(card.getByText("Local backup root")).toBeVisible();
    await expect(card.getByText("Content verified")).toBeVisible();
    // Nothing about mediums, restores or retrieval billing reaches an
    // instance that has none.
    await expect(card.getByText(/billed by your provider/i)).toHaveCount(0);
    await expect(card.getByText("Needs a restore")).toHaveCount(0);
  });

  test("offers no medium picker on the retention form", async ({ bm, page }) => {
    await bm.goto("/settings", "no-medium");

    const tier1 = page.getByRole("group", { name: "Tier 1" });
    await expect(tier1).toBeVisible();
    await expect(tier1.getByLabel("Storage medium for tier 1")).toHaveCount(0);
    // The control: the tier really rendered, so the absence is the
    // absence of the picker.
    await expect(tier1.getByLabel("Name")).toHaveValue("daily");
  });
});
