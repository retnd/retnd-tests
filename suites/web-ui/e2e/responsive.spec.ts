import { expect, needs, test } from "./fixtures";
import { WorkflowScreens } from "./workflow-page";
import { readWorkflowRuns, readWorkflowSteps } from "../harness/workflow";

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

  test("the workflow run page reflows instead of clipping", async ({ bm, page }) => {
    const runs = await readWorkflowRuns(bm.api);
    needs(
      runs !== null && runs.length > 0,
      "a recorded workflow run: EPIC L's widest screen is the run page, and it does not exist " +
        "until something has run"
    );

    const wf = new WorkflowScreens(page);
    await wf.gotoRun(runs![0].run_id);

    // Three verdict cells that collapse to one column rather than
    // shrinking past the width of the words in them. Each is read by
    // name, so a build that dropped one fails here rather than passing
    // on the two that still fit.
    for (const which of ["Backup", "Workflow", "Cleanup"] as const) {
      const box = await wf.verdict(which).boundingBox();
      expect(box, which + " verdict has no box at 940x720").not.toBeNull();
      expect(box!.width, which + " verdict is narrower than its own words").toBeGreaterThan(180);
    }

    const overflowing = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    );
    expect(overflowing, "horizontal page scroll on the workflow run page").toBe(false);
  });

  test("the step log terminal fits the window it is read in", async ({ bm, page }) => {
    // This case found backupd#916: at 940x720 the mounted terminal's
    // box measured 1178px, so the one panel most likely to push a
    // document sideways did exactly that, with the wrap control on by
    // default. §31 says a small app window stays fully usable.
    //
    // The fix caps the section, its fact grid and its log scroller at
    // the column they are read in, so what is below is now the
    // regression guard: it fails against the build the defect was
    // reported on and passes against the one that fixed it.
    const runs = await readWorkflowRuns(bm.api);
    needs(runs !== null && runs.length > 0, "a recorded workflow run to open");
    const steps = await readWorkflowSteps(bm.api, runs![0].run_id);
    needs(steps.length > 0, "a run holding at least one step, so a terminal can be opened");

    const wf = new WorkflowScreens(page);
    await wf.gotoRun(runs![0].run_id);
    await wf.stepRow(steps[0].script_name).click();
    const terminal = wf.terminal(steps[0].script_name);
    await expect(terminal).toBeVisible();
    const box = await terminal.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(940);
  });
});
