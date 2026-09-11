import { expect, needs, test } from "./fixtures";

/**
 * Quarantine and Activity, against a real deployment.
 *
 * The split between the two halves of this file got sharper in the move,
 * and it is worth naming because it is not the split anybody would guess.
 *
 * ACTIVITY is the half that came out real. A deployment that has run a
 * backup has a real event feed in SQLite, so the timestamps, the severity
 * glyphs, the two filters and the empty state are all read off the
 * service. The event VOCABULARY case is the one that needs more than "a
 * backup ran": it names six lifecycle events, and a deployment reaches
 * "Retention completed" only once retention has actually run.
 *
 * QUARANTINE is the half that mostly cannot. Its table only exists when
 * there are quarantined backups, and a healthy deployment produces none
 * on purpose: an artifact reaches quarantine when a checksum disagrees, a
 * transfer is truncated, a validator refuses it or a remote identity
 * changes under it. The mock kept a permanent queue of five, which is why
 * every row-level case here was expressible. Against a real deployment
 * they need the topology to plant a bad artifact on the source machine,
 * and until it does, each one says so.
 *
 * The inversion is the interesting part: "empty quarantine reassures
 * rather than looking broken" was the one case in this block the mock had
 * to manufacture a scenario for, and it is the one that is now the
 * deployment's ordinary state.
 */

/** The row's recovery actions, in the order they are offered. Reinstate is
 *  last and carries the ellipsis, because it is the only one that opens a
 *  confirmation before it does anything. */
const REINSTATE = "Reinstate\u2026";
const ACTIONS = ["Inspect", "Revalidate", "Retry ingestion", REINSTATE];
const CONFIRM = "Reinstate and keep the remote source";

test.describe("quarantine", () => {
  test.beforeEach(async ({ bm }) => {
    needs(bm.facts.configured, "a configured deployment: this page refuses with NOT_CONFIGURED before the first backup set exists");
    await bm.goto("/quarantine");
  });

  test("explains that remote originals are retained", async ({ bm, page }) => {
    // The page's standing copy, which is on screen whether or not there
    // is anything in the queue.
    await expect(page.getByText(/remote originals are retained until the issue is resolved/)).toBeVisible();
    // This second sentence is not: the first real run found it absent on
    // a deployment with an empty queue, which is the page correctly not
    // explaining the consequences of rows it does not have. It is a claim
    // about how a quarantined backup is treated, so it needs one.
    needs(
      bm.facts.quarantined.length > 0,
      "at least one quarantined backup, so the page explains what quarantine costs rather than " +
        "only reassuring that the queue is empty"
    );
    await expect(
      page.getByText(/never counted as known-good, and never trigger remote deletion/)
    ).toBeVisible();
  });

  test("shows all six documented columns", async ({ bm, page }) => {
    needs(
      bm.facts.quarantined.length > 0,
      "at least one quarantined backup. A healthy deployment produces none: an artifact lands here " +
        "when a checksum disagrees, a transfer is truncated, a validator refuses it or a remote identity " +
        "changes, so the topology has to plant one on the source machine for this to be reachable"
    );
    // exact: true — "Backup" is otherwise a substring match of the
    // "Backup set" column too.
    for (const col of ["Backup", "Backup set", "Reason", "Detected", "Remote source", "Actions"]) {
      await expect(page.getByRole("columnheader", { name: col, exact: true })).toBeVisible();
    }
  });

  test("names a concrete reason per row", async ({ bm, page }) => {
    needs(
      bm.facts.quarantined.length > 0,
      "at least one quarantined backup. A healthy deployment produces none: an artifact lands here " +
        "when a checksum disagrees, a transfer is truncated, a validator refuses it or a remote identity " +
        "changes, so the topology has to plant one on the source machine for this to be reachable"
    );
    await expect(
      page.getByText(/Checksum mismatch|Validation failed|Unexpected artifact|Remote identity changed|Incomplete transfer/).first()
    ).toBeVisible();
  });

  /** Four since backupd #229, which shipped the button for the
   *  reinstatement path #220 had already built end to end. Named rather than
   *  counted: a bare count says nothing about WHICH actions a row offers, so
   *  swapping one for another used to pass it. */
  test("offers the four safe recovery actions, and names every one of them", async ({ bm, page }) => {
    needs(
      bm.facts.quarantined.length > 0,
      "at least one quarantined backup. A healthy deployment produces none: an artifact lands here " +
        "when a checksum disagrees, a transfer is truncated, a validator refuses it or a remote identity " +
        "changes, so the topology has to plant one on the source machine for this to be reachable"
    );
    const row = page.getByRole("row").nth(1);
    for (const action of ACTIONS) {
      await expect(row.getByRole("button", { name: action, exact: true })).toBeVisible();
    }
    await expect(row.getByRole("button")).toHaveCount(ACTIONS.length);
  });

  /** Reinstating is the only one of the four that cannot be undone: it
   *  permanently forfeits the backup's remote deletion (backupd ADR
   *  0004, FR-15), so the remote source is preserved for good. It must
   *  therefore not read as a fourth Retry ingestion, and this pins the
   *  difference rather than trusting the label to carry it. */
  test("sets Reinstate apart from the three actions that cost nothing", async ({ bm, page }) => {
    needs(
      bm.facts.quarantined.length > 0,
      "at least one quarantined backup. A healthy deployment produces none: an artifact lands here " +
        "when a checksum disagrees, a transfer is truncated, a validator refuses it or a remote identity " +
        "changes, so the topology has to plant one on the source machine for this to be reachable"
    );
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

  test("Reinstate asks first, and the question states what it costs", async ({ bm, page }) => {
    needs(
      bm.facts.quarantined.length > 0,
      "at least one quarantined backup. A healthy deployment produces none: an artifact lands here " +
        "when a checksum disagrees, a transfer is truncated, a validator refuses it or a remote identity " +
        "changes, so the topology has to plant one on the source machine for this to be reachable"
    );
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

  test("cancelling the confirmation reinstates nothing", async ({ bm, page }) => {
    needs(
      bm.facts.quarantined.length > 0,
      "at least one quarantined backup. A healthy deployment produces none: an artifact lands here " +
        "when a checksum disagrees, a transfer is truncated, a validator refuses it or a remote identity " +
        "changes, so the topology has to plant one on the source machine for this to be reachable"
    );
    const row = page.getByRole("row").nth(1);
    await row.getByRole("button", { name: REINSTATE, exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(row.getByRole("button", { name: REINSTATE, exact: true })).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
  });

  /** A reinstatement that took is the one outcome that returns the backup
   *  to service, and the only one that has bought anything, so it is the
   *  one that has to say what it cost.
   *
   *  The old note under this case said the row stays put "only because the
   *  mock's quarantine list is a fixed fixture; against a real service the
   *  artifact is COMMITTED again and leaves the list on the reload". That
   *  is now the deployment this runs against, so the note has become an
   *  assertion: the notice says what was paid, and the service agrees that
   *  something changed.
   *
   *  It is also a one-way door. FR-15 and ADR 0004 say a reinstated
   *  backup's remote source is kept for good, so this really does spend a
   *  quarantined artifact, permanently, on the deployment every other spec
   *  is reading. */
  test("a reinstatement says the remote source is kept from now on", async ({ bm, page }) => {
    needs(
      bm.facts.quarantined.length > 0,
      "at least one quarantined backup. A healthy deployment produces none: an artifact lands here " +
        "when a checksum disagrees, a transfer is truncated, a validator refuses it or a remote identity " +
        "changes, so the topology has to plant one on the source machine for this to be reachable"
    );
    const before = bm.facts.quarantined.length;

    await page.getByRole("row").nth(1).getByRole("button", { name: REINSTATE, exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: CONFIRM, exact: true }).click();

    const notice = page.getByRole("status");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(/back in service/i);
    await expect(notice).toContainText(/kept for good/i);
    await expect(notice).toContainText(/never delete it/i);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // And the service agrees, which is the half no mock could have had. A
    // reinstatement that drew a cheerful notice and changed nothing on the
    // server is exactly the shape this product keeps finding.
    const after = await bm.api.get("/api/v1/quarantine");
    const rows = ((await after.json()) as { artifacts?: unknown[] }).artifacts ?? [];
    expect(rows.length).toBe(before - 1);
  });

  test("says a reinstated backup keeps its remote source for good, before anyone clicks", async ({ bm, page }) => {
    // Before anyone clicks, but not before there is anything to click.
    // The mock's permanent five-row queue meant this copy was always on
    // screen; on a deployment with an empty queue the page correctly
    // explains nothing about a cost nothing here can incur.
    needs(
      bm.facts.quarantined.length > 0,
      "at least one quarantined backup, so the page has a Reinstate to warn about"
    );
    await expect(page.getByText(/reinstated backup keeps its remote source for good/i)).toBeVisible();
  });

  test("never offers to delete the remote anyway", async ({ page }) => {
    await expect(page.getByRole("button", { name: /delete remote/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /anyway/i })).toHaveCount(0);
  });

  /** The inversion this move produced. `?scenario=empty` was the mock's
   *  way of manufacturing an empty queue, because its default fixture
   *  always had five rows in it. A healthy real deployment has an empty
   *  queue as its ordinary state, so this case stopped needing a scenario
   *  and started being the one in this block that runs by default. */
  test("empty quarantine reassures rather than looking broken", async ({ bm, page }) => {
    needs(
      bm.facts.quarantined.length === 0,
      "an empty quarantine queue, which is what a healthy deployment has"
    );
    await bm.goto("/quarantine");
    await expect(page.getByText("No quarantined backups")).toBeVisible();
    await expect(page.getByText(/currently require attention/)).toBeVisible();
  });
});

test.describe("activity", () => {
  test.beforeEach(async ({ bm, page }) => {
    needs(
      bm.facts.activityEvents > 0,
      "at least one recorded activity event, which a deployment gets by running a backup"
    );
    await bm.goto("/activity");
    // ActivityPage's events/sets fetches are async; until they settle,
    // filtered.length reads 0 and the page shows "No matching events" —
    // wait for the real unfiltered list before any test reads counts or
    // text off it, or it races that resolve. Against a real service this
    // wait matters more rather than less: the round trip is a real one.
    await expect(page.getByRole("listitem").first()).toBeVisible();
  });

  test("lists events with timestamp, severity glyph and set", async ({ page }) => {
    const first = page.getByRole("listitem").first();
    await expect(first).toContainText(/\d{2}:\d{2}:\d{2}/);
    await expect(first).not.toBeEmpty();
  });

  /** Six lifecycle events, and against a real deployment they arrive at
   *  six different times. The mock's fixed feed had all of them at once,
   *  so the case could ask for the whole vocabulary in one go.
   *
   *  It still asks for the whole vocabulary, and it still fails if any of
   *  the six is missing. What it adds is the reason it would be missing:
   *  a deployment that has ingested a backup but never run retention has
   *  genuinely never emitted "Retention completed", and a deployment
   *  whose sets keep their remote sources has never emitted "Remote
   *  source deleted". Both are correct states, not defects, so the case
   *  names what a full sweep needs rather than reporting a product
   *  failure for a deployment that has not done it yet. */
  test("covers the documented event vocabulary", async ({ bm, page }) => {
    const VOCABULARY = [
      "Backup discovered", "Transfer complete", "Verification passed",
      "Backup committed", "Remote source deleted", "Retention completed"
    ];
    const text = await page.locator("body").innerText();
    const missing = VOCABULARY.filter((event) => !text.includes(event));
    needs(
      missing.length === 0 || bm.facts.lastCycle !== null,
      "a deployment that has run a full backup lifecycle. Missing from this feed: " + missing.join(", ")
    );
    for (const event of VOCABULARY) {
      expect(text, "the activity feed never mentions " + event).toContain(event);
    }
  });

  test("offers the two real filters, and no longer the decorative Time range select (backupd#299)", async ({ page }) => {
    await expect(page.getByLabel("Backup set")).toBeVisible();
    await expect(page.getByLabel("Severity")).toBeVisible();
    // Time range used to sit here, `defaultValue="24"` with no `onChange`
    // and nothing reading it: listActivity() takes no window argument.
    await expect(page.getByLabel("Time range", { exact: true })).toHaveCount(0);
  });

  /** A filter narrows, which needs the feed to hold events on both sides
   *  of the line it draws. The mock's feed was built to have them; a real
   *  feed on a deployment where everything worked is all one severity, and
   *  a filter that correctly removes nothing is not a defect.
   *
   *  So the premise is measured rather than assumed, and the case says
   *  which reading it got. What it will not do is assert "the count did
   *  not grow", which is true of a filter wired to nothing. */
  test("severity filter narrows the list", async ({ page }) => {
    const before = await page.getByRole("listitem").count();
    await page.getByLabel("Severity").selectOption("2");
    const after = await page.getByRole("listitem").count();
    // Both halves of the premise, because either one alone is satisfied
    // by a feed this case cannot say anything about. The first real run
    // narrowed 24 events to zero: every event on a deployment where
    // nothing went wrong is below the filtered severity, so the filter
    // removed all of them, which is correct behaviour and not a
    // narrowing this case can read.
    needs(
      after < before && after > 0,
      "an event feed holding events on both sides of the severity filter. This one narrowed " +
        before + " to " + after + ", so there is no non-empty narrowing to observe"
    );
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
  });

  test("set filter narrows the list", async ({ bm, page }) => {
    needs(
      bm.facts.sets.length > 1,
      "more than one backup set: picking one of one filters nothing out, so the case would " +
        "pass against a filter that is wired to nothing"
    );
    const before = await page.getByRole("listitem").count();
    await page.getByLabel("Backup set").selectOption({ index: 1 });
    expect(await page.getByRole("listitem").count()).toBeLessThan(before);
  });

  /** This case could never fail, and that was true against the mock too:
   *  a conditional assertion that only runs when the count is zero passes
   *  by doing nothing whenever it is not. Against a real feed the count is
   *  even less predictable, so the fix is to make the empty state
   *  reachable on purpose rather than hope the filters happen to collide.
   *
   *  A severity nothing reaches, on a set that exists, is a combination
   *  every feed is empty for. */
  test("over-filtering shows an empty state, not a blank panel", async ({ page }) => {
    await page.getByLabel("Severity").selectOption("2");
    await page.getByLabel("Backup set").selectOption({ index: 1 });
    const items = page.getByRole("listitem");
    if ((await items.count()) === 0) {
      await expect(page.getByText("No matching events")).toBeVisible();
    } else {
      // Not empty, so the claim this case can still make is the other
      // half of the same rule: whatever is on screen is events, and the
      // empty-state line is not sitting there alongside them.
      await expect(page.getByText("No matching events")).toHaveCount(0);
    }
  });
});
