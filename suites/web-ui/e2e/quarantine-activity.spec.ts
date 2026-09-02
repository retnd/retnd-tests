import { expect, test } from "./fixtures";

/** The row's recovery actions, in the order they are offered. Reinstate is
 *  last and carries the ellipsis, because it is the only one that opens a
 *  confirmation before it does anything. */
const REINSTATE = "Reinstate\u2026";
const ACTIONS = ["Inspect", "Revalidate", "Retry ingestion", REINSTATE];
const CONFIRM = "Reinstate and keep the remote source";

test.describe("quarantine", () => {
  test.beforeEach(async ({ bm }) => {
    await bm.goto("/quarantine");
  });

  test("explains that remote originals are retained", async ({ page }) => {
    await expect(page.getByText(/remote originals are retained until the issue is resolved/)).toBeVisible();
    await expect(
      page.getByText(/never counted as known-good, and never trigger remote deletion/)
    ).toBeVisible();
  });

  test("shows all six documented columns", async ({ page }) => {
    // exact: true — "Backup" is otherwise a substring match of the
    // "Backup set" column too.
    for (const col of ["Backup", "Backup set", "Reason", "Detected", "Remote source", "Actions"]) {
      await expect(page.getByRole("columnheader", { name: col, exact: true })).toBeVisible();
    }
  });

  test("names a concrete reason per row", async ({ page }) => {
    await expect(
      page.getByText(/Checksum mismatch|Validation failed|Unexpected artifact|Remote identity changed|Incomplete transfer/).first()
    ).toBeVisible();
  });

  /** Four since rclone-manager #229, which shipped the button for the
   *  reinstatement path #220 had already built end to end. Named rather than
   *  counted: a bare count says nothing about WHICH actions a row offers, so
   *  swapping one for another used to pass it. */
  test("offers the four safe recovery actions, and names every one of them", async ({ page }) => {
    const row = page.getByRole("row").nth(1);
    for (const action of ACTIONS) {
      await expect(row.getByRole("button", { name: action, exact: true })).toBeVisible();
    }
    await expect(row.getByRole("button")).toHaveCount(ACTIONS.length);
  });

  /** Reinstating is the only one of the four that cannot be undone: it
   *  permanently forfeits the backup's remote deletion (rclone-manager ADR
   *  0004, FR-15), so the remote source is preserved for good. It must
   *  therefore not read as a fourth Retry ingestion, and this pins the
   *  difference rather than trusting the label to carry it. */
  test("sets Reinstate apart from the three actions that cost nothing", async ({ page }) => {
    const row = page.getByRole("row").nth(1);

    // A trailing ellipsis is this product's "this opens a confirmation"
    // affordance ("Apply retention now…", "Remove set configuration…"), and
    // Reinstate is the only action in the row that carries one. The other
    // three take effect on the click.
    const opensAConfirmation = row.getByRole("button", { name: /…$/ });
    await expect(opensAConfirmation).toHaveCount(1);
    await expect(opensAConfirmation).toHaveAccessibleName(REINSTATE);

    // And it is not painted like its neighbours: a different button tier,
    // plus a glyph none of the other three has.
    const chrome = (name: string) =>
      row.getByRole("button", { name, exact: true }).evaluate((el) => {
        const style = getComputedStyle(el);
        return [
          style.backgroundColor,
          style.borderColor,
          String(el.querySelector("[aria-hidden='true']") !== null)
        ].join("|");
      });
    expect(await chrome(REINSTATE)).not.toBe(await chrome("Retry ingestion"));
  });

  test("Reinstate asks first, and the question states what it costs", async ({ page }) => {
    await page.getByRole("row").nth(1).getByRole("button", { name: REINSTATE, exact: true }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/permanently forfeits/i)).toBeVisible();
    await expect(dialog.getByText(/never delete it/i)).toBeVisible();
    // §35: the consequence is named in the confirm button itself, and the
    // half of the deal being paid is in there with the half being bought.
    await expect(dialog.getByRole("button", { name: CONFIRM, exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /^(OK|Yes|Confirm|Submit)$/ })).toHaveCount(0);
  });

  test("cancelling the confirmation reinstates nothing", async ({ page }) => {
    const row = page.getByRole("row").nth(1);
    await row.getByRole("button", { name: REINSTATE, exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(row.getByRole("button", { name: REINSTATE, exact: true })).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
  });

  /** The mock API answers with a reinstatement that took, which is the one
   *  outcome that returns the backup to service. It is also the only one
   *  that has bought anything, so it is the one that has to say what it
   *  cost. (The row itself stays put here only because the mock's quarantine
   *  list is a fixed fixture; against a real service the artifact is
   *  COMMITTED again and leaves the list on the reload.) */
  test("a reinstatement says the remote source is kept from now on", async ({ page }) => {
    await page.getByRole("row").nth(1).getByRole("button", { name: REINSTATE, exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: CONFIRM, exact: true }).click();

    const notice = page.getByRole("status");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(/back in service/i);
    await expect(notice).toContainText(/kept for good/i);
    await expect(notice).toContainText(/never delete it/i);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("says a reinstated backup keeps its remote source for good, before anyone clicks", async ({ page }) => {
    await expect(page.getByText(/reinstated backup keeps its remote source for good/i)).toBeVisible();
  });

  test("never offers to delete the remote anyway", async ({ page }) => {
    await expect(page.getByRole("button", { name: /delete remote/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /anyway/i })).toHaveCount(0);
  });

  test("empty quarantine reassures rather than looking broken", async ({ bm, page }) => {
    await bm.goto("/quarantine", "empty");
    await expect(page.getByText("No quarantined backups")).toBeVisible();
    await expect(page.getByText(/currently require attention/)).toBeVisible();
  });
});

test.describe("activity", () => {
  test.beforeEach(async ({ bm, page }) => {
    await bm.goto("/activity");
    // ActivityPage's events/sets fetches are async (mock listActivity() /
    // listSets()); until they settle, filtered.length reads 0 and the page
    // shows "No matching events" — wait for the real unfiltered list before
    // any test reads counts or text off it, or it races that resolve.
    await expect(page.getByRole("listitem").first()).toBeVisible();
  });

  test("lists events with timestamp, severity glyph and set", async ({ page }) => {
    const first = page.getByRole("listitem").first();
    await expect(first).toContainText(/\d{2}:\d{2}:\d{2}/);
    await expect(first).not.toBeEmpty();
  });

  test("covers the documented event vocabulary", async ({ page }) => {
    const text = await page.locator("body").innerText();
    for (const event of [
      "Backup discovered", "Transfer complete", "Verification passed",
      "Backup committed", "Remote source deleted", "Retention completed"
    ]) {
      expect(text).toContain(event);
    }
  });

  test("offers the two real filters, and no longer the decorative Time range select (rclone-manager#299)", async ({ page }) => {
    await expect(page.getByLabel("Backup set")).toBeVisible();
    await expect(page.getByLabel("Severity")).toBeVisible();
    // Time range used to sit here, `defaultValue="24"` with no `onChange`
    // and nothing reading it: listActivity() takes no window argument.
    await expect(page.getByLabel("Time range", { exact: true })).toHaveCount(0);
  });

  test("severity filter narrows the list", async ({ page }) => {
    const before = await page.getByRole("listitem").count();
    await page.getByLabel("Severity").selectOption("2");
    const after = await page.getByRole("listitem").count();
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(0);
  });

  test("set filter narrows the list", async ({ page }) => {
    const before = await page.getByRole("listitem").count();
    await page.getByLabel("Backup set").selectOption({ index: 1 });
    expect(await page.getByRole("listitem").count()).toBeLessThan(before);
  });

  test("over-filtering shows an empty state, not a blank panel", async ({ page }) => {
    await page.getByLabel("Severity").selectOption("2");
    await page.getByLabel("Backup set").selectOption({ index: 2 });
    const empty = page.getByText("No matching events");
    const items = page.getByRole("listitem");
    if ((await items.count()) === 0) await expect(empty).toBeVisible();
  });
});
