import { CONTENT_COLUMN, TERMINAL, expect, needs, test } from "./fixtures";

/**
 * backupd#617: the global terminal is pinned to the browser window,
 * and the content column reserves the room it takes.
 *
 * # What the defect was
 *
 * The terminal (#599) mounted as a flex sibling of the nav/content row, so
 * it rode the end of the document. `<main>` never gets a constrained
 * height, so on any page longer than a screen the document is what
 * scrolls, and the always-on panel travelled up out of view with
 * everything else. It was there once you had already scrolled to the
 * bottom, which is the one moment you did not need it.
 *
 * # Why it is not just `position: fixed`
 *
 * Taking it out of flow costs the property the old arrangement had for
 * nothing: the content column used to shrink around it, so nothing ever
 * covered the last row of a long table. Fixed on its own would put that
 * row behind the terminal permanently, with no scroll position that
 * reveals it. So the panel publishes the height it occupies and the shell
 * reserves that much under the content.
 *
 * That reservation is what the second block below is about, and it is why
 * this file measures the CONTENT COLUMN'S own bottom room rather than the
 * custom property the number travels on. A build that reserved the room
 * some other way is not a build this suite should fail.
 *
 * # What is red where
 *
 * The first block fails against the arrangement this issue replaced: at
 * the top of a long page the panel is a screen and a half below the fold,
 * so it has no viewport box to be at the bottom of and nothing passes
 * behind it.
 *
 * The last block is the opposite: it is the regression guard, it passed
 * before this change (that was the old arrangement's whole argument) and
 * it has to keep passing. Its control is the case that follows it, which
 * takes the reserved room away and requires the overlap to appear. Without
 * that pair the assertion would be true of a viewport big enough to hold
 * the whole table and would prove nothing.
 */

/** What a collapsed terminal is allowed to be: one line, plus the rule it
 *  draws along its top edge. backupd exports the 32 as
 *  DOCK_BAR_HEIGHT; nothing here imports from the product, so it is
 *  written down with the reason it is that number. */
const ONE_LINE = 32;

/** A page far taller than the window, so "scrolls" means something.
 *
 *  The dashboard was around three windows deep with the mock's fixture,
 *  which is where the 400px floor below came from. A real deployment's
 *  dashboard is as tall as its own contents, so the floor is now a
 *  PRECONDITION rather than an assumption: a page that fits in the window
 *  has no scroll to measure, and every case in the first block would be
 *  true of the arrangement this issue replaced. */
const LONG_PAGE = "/";

/** How much taller than the window a page has to be before "it scrolls"
 *  is a measurement rather than a coincidence. */
const ENOUGH_SCROLL = 400;

interface Geometry {
  /** The terminal's box in viewport coordinates. */
  dock: { top: number; bottom: number; left: number; right: number; height: number };
  /** The room the content column keeps under itself, in px. */
  room: number;
  windowHeight: number;
  scrollY: number;
  scrollable: number;
}

async function geometry(page: import("@playwright/test").Page): Promise<Geometry> {
  return page.evaluate(([terminal, contentColumn]) => {
    const dock = document.querySelector(terminal);
    if (!dock) throw new Error("no terminal on this page");
    const main = document.querySelector(contentColumn);
    if (!main) throw new Error("no content column on this page");
    const r = dock.getBoundingClientRect();
    return {
      dock: { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height },
      room: parseFloat(getComputedStyle(main).paddingBottom) || 0,
      windowHeight: window.innerHeight,
      scrollY: window.scrollY,
      scrollable: document.documentElement.scrollHeight - window.innerHeight
    };
  }, [TERMINAL, CONTENT_COLUMN] as const);
}

async function scrollToBottom(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  // The scroll is what is being waited on, not a duration: the position
  // stops moving once the browser has taken it.
  await page.waitForFunction(
    () => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2
  );
}

test.describe("the terminal is pinned to the browser window", () => {
  test.beforeEach(async ({ bm, page }) => {
    await bm.goto(LONG_PAGE);
    await expect(bm.terminal()).toBeVisible();
    // The premise all three cases rest on, checked once and stated as a
    // skip rather than asserted as a failure. A dashboard that fits in the
    // window is a correct dashboard on a quiet deployment; it is just not
    // a page this file can measure a pinned panel against.
    const g = await geometry(page);
    needs(
      g.scrollable > ENOUGH_SCROLL,
      "a dashboard taller than the window (" + Math.round(g.scrollable) + "px of scroll, wanted more " +
        "than " + ENOUGH_SCROLL + "). The mock's fixture made this page about three windows deep; a " +
        "real one is as tall as this deployment's own contents"
    );
  });

  test("sits at the bottom of the window on a page far taller than the window", async ({ page }) => {
    const g = await geometry(page);
    expect(g.scrollY, "measured before anything has been scrolled").toBe(0);

    expect(g.dock.bottom).toBeGreaterThan(g.windowHeight - 2);
    expect(g.dock.bottom).toBeLessThan(g.windowHeight + 2);
    expect(g.dock.top).toBeGreaterThan(0);
    expect(g.dock.top).toBeLessThan(g.windowHeight);
  });

  test("stays at the same place on screen while the page scrolls", async ({ page }) => {
    const before = await geometry(page);

    await scrollToBottom(page);
    const after = await geometry(page);

    expect(after.scrollY, "the page really did scroll").toBeGreaterThan(400);
    // Same box, to the pixel. Not "still visible": a panel that drifts up
    // by the scroll distance and happens to land back in the viewport at
    // the bottom of the document is exactly what this replaced.
    expect(after.dock.top).toBeCloseTo(before.dock.top, 1);
    expect(after.dock.bottom).toBeCloseTo(before.dock.bottom, 1);
    expect(after.dock.left).toBeCloseTo(before.dock.left, 1);
    expect(after.dock.right).toBeCloseTo(before.dock.right, 1);
  });

  test("the page's own content passes behind it rather than stopping above it", async ({ page }) => {
    const reading = await page.evaluate(([terminal, contentColumn]) => {
      const dock = document.querySelector(terminal)!.getBoundingClientRect();
      const main = document.querySelector(contentColumn)!;
      const behind = Array.from(main.querySelectorAll("*")).filter((el) => {
        const b = el.getBoundingClientRect();
        return b.width > 0 && b.height > 0 && b.top < dock.bottom && b.bottom > dock.top;
      }).length;
      const hit = document.elementFromPoint(dock.left + dock.width / 2, dock.top + dock.height / 2);
      return { behind, dockIsOnTop: !!hit && !!hit.closest(terminal) };
    }, [TERMINAL, CONTENT_COLUMN] as const);

    // Two halves, and both are needed. Content occupying the same band as
    // the terminal says the column is not shrinking around it any more,
    // and the hit test says the terminal is what is painted there, so the
    // content is behind rather than in front of it.
    expect(reading.behind, "content rendered in the terminal's band").toBeGreaterThan(0);
    expect(reading.dockIsOnTop, "the terminal is what is drawn in its own band").toBe(true);
  });
});

test.describe("the room the content column reserves under itself", () => {
  test.beforeEach(async ({ bm }) => {
    await bm.goto(LONG_PAGE);
    await expect(bm.terminal()).toBeVisible();
  });

  test("matches the terminal's height while it is open", async ({ page }) => {
    const g = await geometry(page);
    expect(g.dock.height).toBeGreaterThan(ONE_LINE);
    // At least what it covers. More is allowed (the panel's own border and
    // resize handle are counted in), a shortfall is not: a shortfall is
    // measured in rows of a table nobody can reach.
    expect(g.room).toBeGreaterThanOrEqual(g.dock.height);
  });

  test("shrinks to the one line a collapsed terminal shows", async ({ page, bm }) => {
    const open = await geometry(page);

    await page.getByRole("button", { name: "Hide terminal" }).click();
    await expect(page.getByRole("button", { name: "Show terminal" })).toBeVisible();
    const collapsed = await geometry(page);

    // One line, plus the rule along its top edge.
    expect(collapsed.dock.height).toBeLessThanOrEqual(ONE_LINE + 1);
    expect(collapsed.dock.bottom).toBeCloseTo(collapsed.windowHeight, 0);
    // And still readable: a terminal that collapses to nothing teaches an
    // operator to stop opening it, so the bar keeps the newest line.
    await expect(bm.terminal()).toContainText(/\S/);

    expect(collapsed.room).toBe(ONE_LINE);
    expect(collapsed.room).toBeLessThan(open.room);
  });

  test("grows with the terminal when it is dragged taller", async ({ page, bm }) => {
    const before = await geometry(page);

    const handle = bm.terminalResizeHandle();
    const box = await handle.boundingBox();
    expect(box, "the terminal has a resize handle").not.toBeNull();
    const drag = 120;
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2 - drag, { steps: 10 });
    await page.mouse.up();
    await page.waitForFunction(
      ([terminal, was]) => {
        const el = document.querySelector(terminal as string);
        return !!el && el.getBoundingClientRect().height > (was as number) + 100;
      },
      [TERMINAL, before.dock.height] as const
    );

    const after = await geometry(page);
    expect(after.dock.height - before.dock.height).toBeGreaterThan(drag - 20);
    expect(after.dock.bottom).toBeCloseTo(after.windowHeight, 0);
    // The point of the case: the room moved by what the panel moved by,
    // rather than staying at whatever it was when the page loaded.
    expect(after.room - before.room).toBeCloseTo(after.dock.height - before.dock.height, -1);
    expect(after.room).toBeGreaterThanOrEqual(after.dock.height);
  });
});

test.describe("a table taller than the window it is read in", () => {
  // Shorter than the project's own window, and deliberately. With a
  // handful of rows, at 1440x900 the whole page fits inside the room
  // reserved for the terminal, so "the last row clears the terminal" would
  // be true of a build that reserved nothing at all, and the control below
  // could not fail either. At this height the table runs under the bottom
  // edge of the window, which is the shape an operator with a full table
  // has and the shape the assertion is about.
  test.use({ viewport: { width: 1440, height: 640 } });

  test.beforeEach(async ({ bm, page }) => {
    needs(bm.facts.backups.length > 0, "at least one ingested backup, so a table is drawn at all");
    await bm.goto("/backups");
    await expect(page.getByRole("table")).toBeVisible();
    // The premise both cases rest on, and now a stated skip rather than a
    // failed assertion: a page that fits in the window has no "scrolled to
    // the bottom" worth reading, and how many rows this deployment holds
    // is not something this file gets to decide.
    const g = await geometry(page);
    // Taller than the window by more than the terminal occupies, not
    // merely taller than the window. The control below takes the reserved
    // room away and requires the last row to fall behind the panel, and
    // it can only do that if there is at least a panel's worth of page to
    // fall through. The first real run landed 1px short of that on a
    // three-row table and read as a layout regression, which it was not.
    needs(
      g.scrollable > g.dock.height,
      "a backups table taller than a 640px window by more than the terminal's own height (" +
        Math.round(g.scrollable) + "px of scroll against a " + Math.round(g.dock.height) +
        "px panel). This deployment holds " + bm.facts.backups.length + " backup(s)"
    );
  });

  test("its last row can be scrolled entirely clear of the terminal", async ({ page }) => {
    await scrollToBottom(page);
    const reading = await page.evaluate((terminal) => {
      const rows = document.querySelectorAll("table tbody tr");
      const dock = document.querySelector(terminal)!.getBoundingClientRect();
      const last = rows[rows.length - 1].getBoundingClientRect();
      return { rows: rows.length, lastRowBottom: last.bottom, dockTop: dock.top };
    }, TERMINAL);

    expect(reading.rows).toBeGreaterThan(0);
    // Entirely clear: the row's bottom edge, not its top. A row half
    // behind the terminal is a size or a validation state somebody cannot
    // read, and this is the property the in-flow arrangement had and the
    // reason the fix reserves room rather than simply covering things.
    expect(reading.lastRowBottom).toBeLessThanOrEqual(reading.dockTop);
  });

  test("and the control: with that room taken away, the same row is behind it", async ({ page }) => {
    // The case above is a regression guard, so it passes against the
    // arrangement this issue replaced and against the fix. What it cannot
    // do on its own is show that it would notice the regression it is
    // named for. This removes exactly the reservation the fix added and
    // requires the overlap to appear, which is the failure the case above
    // is watching for.
    await page.addStyleTag({ content: "main { padding-bottom: 0 !important; }" });
    await scrollToBottom(page);
    const reading = await page.evaluate((terminal) => {
      const rows = document.querySelectorAll("table tbody tr");
      const dock = document.querySelector(terminal)!.getBoundingClientRect();
      const last = rows[rows.length - 1].getBoundingClientRect();
      return { lastRowBottom: last.bottom, dockTop: dock.top };
    }, TERMINAL);

    expect(reading.lastRowBottom).toBeGreaterThan(reading.dockTop);
  });
});
