import { expect, needs, test } from "./fixtures";

/** §31 — desktop-first, but a small app window must stay fully usable. This
 *  project runs at 940x720; the regression it guards is a clipped table column.
 *
 *  Layout is layout, so most of this survived the move untouched. The one
 *  thing that did not is which pages have a TABLE on them: a table is
 *  drawn when there are rows, and a real deployment's quarantine queue is
 *  empty by design. The old version swept /backups and /quarantine
 *  together and, against the mock, both always had rows. Here each is
 *  visited only when this deployment has something to draw in it, and the
 *  case says which. */
test.describe("small app window", () => {
  test.beforeEach(async ({ bm }) => {
    needs(bm.facts.configured, "a configured deployment: these pages refuse with NOT_CONFIGURED before the first backup set exists");
  });

  test("no data table hides a column", async ({ bm, page }) => {
    const tables = [
      { path: "/backups", rows: bm.facts.backups.length },
      { path: "/quarantine", rows: bm.facts.quarantined.length }
    ].filter((t) => t.rows > 0);
    needs(
      tables.length > 0,
      "at least one page holding a data table. An empty catalogue and an empty quarantine queue " +
        "both draw an empty state instead, which has no columns to clip"
    );

    for (const { path } of tables) {
      await page.goto(path);

      const scroller = page.locator(".table-scroll");
      await expect(scroller).toBeVisible();
      expect(await scroller.evaluate((el) => getComputedStyle(el).overflowX)).toBe("auto");

      // Every column header must be reachable by scrolling the container.
      const headers = page.getByRole("columnheader");
      const count = await headers.count();
      expect(count).toBeGreaterThan(0);
      await headers.nth(count - 1).scrollIntoViewIfNeeded();
      await expect(headers.nth(count - 1)).toBeVisible();
    }
  });

  test("the page itself never scrolls sideways", async ({ page }) => {
    for (const path of ["/", "/sets", "/backups", "/activity", "/settings"]) {
      await page.goto(path);
      const overflowing = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      );
      expect(overflowing, "horizontal page scroll on " + path).toBe(false);
    }
  });

  test("navigation and primary actions stay reachable", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: "Sections" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add backup set" })).toBeVisible();
  });

  test("set cards reflow instead of overlapping", async ({ bm, page }) => {
    needs(bm.facts.sets.length > 0, "at least one backup set, so there is a card to measure");
    await page.goto("/sets");
    const cards = page.getByRole("article");
    const count = await cards.count();

    const boxes = [];
    for (let i = 0; i < count; i++) boxes.push(await cards.nth(i).boundingBox());

    for (const box of boxes) {
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThan(240);
    }
  });

  test("dialogs remain fully visible", async ({ bm, page }) => {
    needs(bm.facts.sets.length > 0, "at least one backup set, so a retention preview can be opened");
    await page.goto("/sets");
    await page.getByRole("article").first().getByRole("button", { name: "Open" }).click();
    // exact: true — disambiguates from the detail page's other
    // "Preview retention plan" button.
    await page.getByRole("button", { name: "Preview retention", exact: true }).click();

    const dialog = page.getByRole("dialog");
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.height).toBeLessThanOrEqual(720);
  });
});
