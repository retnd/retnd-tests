import { expect, test } from "./fixtures";

/** What relativeAge() (ui/shared/src/utilities/format.ts) can print. The
 *  suite runs against a fixed fixture but the ages are computed from
 *  Date.now(), so the shape is the stable thing to assert, not a number. */
const FRESHNESS = /^(never|just now|\d+ minutes? ago|\d+ hours? ago|\d+ days ago)$/;

test.describe("dashboard", () => {
  test("states the BACKUP verdict, not the daemon's", async ({ bm, page }) => {
    await bm.goto("/");
    // §8 — the headline is about backups; the daemon is a supporting chip.
    await expect(page.getByText(/^BACKUPS /)).toBeVisible();
    // Scoped to the header — the dashboard body's own health summary widget
    // repeats "Service running" with a different suffix (uptime, not
    // version), so an unscoped match is ambiguous.
    await expect(page.getByRole("banner").getByText(/Service running/)).toBeVisible();
    await expect(page.getByText(/a healthy daemon is not a healthy backup|not produced a verified backup|halted/i).first()).toBeVisible();
  });

  test("every status chip pairs a glyph with a text label", async ({ bm, page }) => {
    await bm.goto("/");
    const summary = page.getByRole("region", { name: "Backup health" });
    await expect(summary).toBeVisible();
    await expect(summary).toContainText(/Service running/);
    await expect(summary).toContainText(/Storage/);
  });

  test("reports freshness figures", async ({ bm, page }) => {
    await bm.goto("/");
    const summary = page.getByRole("region", { name: "Backup health" });
    // The figure rendered against a label in the summary's <dl>: the label
    // on its own proves only that a row exists, not that anything filled
    // it in.
    const figure = (label: string) =>
      summary.locator("dt").filter({ hasText: label }).locator("xpath=following-sibling::dd[1]");

    // "Last successful cycle" is "Last completed backup" since #214. The
    // health report separates the newest backup that FINISHED from the
    // newest one that was VERIFIED, and only the second is a restore
    // point, so both rows are asserted here: a rename that quietly folded
    // them back into one figure would fail this.
    await expect(figure("Last completed backup")).toHaveText(FRESHNESS);
    await expect(figure("Newest verified backup")).toHaveText(FRESHNESS);

    // Null freshness means some set has never produced a known-good backup
    // at all, which is an unanswerable question rather than a large number
    // of hours, so the UI has to say so in words instead of printing one.
    await expect(figure("Oldest set freshness")).toHaveText(
      /^(\d+ hours ago|not yet measurable)$/
    );

    // "Retained artifacts" and "Success rate \u00b7 7d" used to sit in this
    // same list. #211 removed both: no endpoint has ever computed either,
    // so against a real deployment they each rendered a confident zero.
    // "Free space" is the honest figure that took their place here, and it
    // comes off the health report. Deliberate removal, recorded so a later
    // reader does not read the shorter list as an assertion someone
    // deleted: the retained-artifact count and the seven-day success rate
    // have NO replacement, in this list or anywhere else.
    await expect(figure("Free space")).toHaveText(/^[\d.]+ (B|KB|MB|GB|TB|PB)$/);
    await expect(summary.getByText(/Success rate|Retained artifacts/)).toHaveCount(0);
    // Control for that zero: the same query shape, on a label that is
    // there, finds it. Without this, a typo would also read as "absent".
    await expect(summary.getByText(/Oldest set freshness/)).toHaveCount(1);
  });

  test("surfaces the host-key change above the metrics", async ({ bm, page }) => {
    await bm.goto("/");
    const alert = page.getByRole("alert").filter({ hasText: /host key/i });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/Security warning/i);
    await expect(alert).toContainText(/No remote artifacts will be deleted/i);
  });

  test("host-key alert links through to the halted set", async ({ bm, page }) => {
    await bm.goto("/");
    await page.getByRole("button", { name: "Review fingerprint" }).click();
    await expect(page.getByText(/Fingerprint|Presented now/).first()).toBeVisible();
  });

  test("shows the four metric cards with a storage meter", async ({ bm, page }) => {
    await bm.goto("/");
    const metrics = page.getByRole("region", { name: "Key metrics" });
    // A MetricCard renders label, then value, then detail line, with no
    // separator between them, so one regex per card ties the number to the
    // label above it rather than accepting it anywhere in the region.
    await expect(metrics).toContainText(/Backup sets\s*\d+\s*\d+ stale \u00b7 \d+ failing/);
    // This card was "Success rate \u00b7 7d" until #214. The success rate had
    // no source anywhere in the running system: it came off the dev-server
    // mock, and on a real deployment it would have rendered a confident
    // percentage of nothing. Its slot now carries a count of sets needing
    // attention, which the health report really does compute from the
    // per-set states, so the honest replacement is what is asserted rather
    // than the check simply being dropped.
    await expect(metrics).toContainText(/Degraded or stale\s*\d+\s*sets needing attention/);
    await expect(metrics).toContainText(/Quarantine\s*\d+\s*need review/);
    await expect(metrics).toContainText(/Storage\s*[\d.]+ (B|KB|MB|GB|TB|PB) free/);
    await expect(metrics.getByText(/Success rate/)).toHaveCount(0);
    // Control for that zero, as in "reports freshness figures" above.
    await expect(metrics.getByText(/Degraded or stale/)).toHaveCount(1);

    const meter = page.getByRole("meter", { name: "Storage used" });
    await expect(meter).toBeVisible();
    const used = Number(await meter.getAttribute("aria-valuenow"));
    expect(used).toBeGreaterThanOrEqual(0);
    expect(used).toBeLessThanOrEqual(100);
    // The meter and the sentence under it are two renderings of one
    // number, and an operator reads the sentence.
    await expect(metrics).toContainText(new RegExp("used \u00b7 " + used + "%"));
  });

  test("renders an active transfer with staged progress", async ({ bm, page }) => {
    await bm.goto("/");
    const ops = page.getByRole("region", { name: "Active operations" });
    await expect(ops).toBeVisible();

    const bar = ops.getByRole("progressbar").first();
    await expect(bar).toBeVisible();
    const value = Number(await bar.getAttribute("aria-valuenow"));
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThanOrEqual(100);

    // getByText(exact: true) matches an element's whole DOM text content,
    // which here includes the stage glyph (aria-hidden span rendered right
    // before the label, e.g. "✓Discovering") — an exact match on the label
    // alone never resolves. "listitem" has no ARIA name-from-content (name
    // is author-only per the ARIA role table), so getByRole(…, {name}) can't
    // find it either — a plain substring getByText is the fix, scoped to the
    // stage list itself (not the whole region) since "Transferring" is also
    // a substring of the op's own label, "Transferring backup", rendered
    // above the list.
    const stageList = ops.getByRole("list");
    for (const stage of ["Discovering", "Transferring", "Verifying", "Committing", "Cleaning remote source", "Complete"]) {
      await expect(stageList.getByText(stage)).toBeVisible();
    }
    await expect(ops.getByRole("listitem").filter({ has: page.locator("[aria-current='step']") })).toHaveCount(0);
  });

  test("marks the current transfer stage exactly once", async ({ bm, page }) => {
    await bm.goto("/");
    const current = page.getByRole("region", { name: "Active operations" }).locator("li[aria-current='step']");
    await expect(current).toHaveCount(1);
    await expect(current).toContainText("Transferring");
  });

  test("labels a read-only pass as non-destructive", async ({ bm, page }) => {
    await bm.goto("/");
    await expect(page.getByText(/Read-only pass .* no artifacts are deleted/)).toBeVisible();
  });

  test("explains remote deletion ordering under the transfer", async ({ bm, page }) => {
    await bm.goto("/");
    await expect(
      page.getByText(/removed only after the NAS copy is verified and durably committed/)
    ).toBeVisible();
  });

  test("lists recent activity and links to the full timeline", async ({ bm, page }) => {
    await bm.goto("/");
    const recent = page.getByRole("region", { name: "Recent activity" });
    await expect(recent.getByRole("listitem").first()).toBeVisible();
    await recent.getByRole("button", { name: "View all" }).click();
    await expect(bm.heading("Activity")).toBeVisible();
  });

  test("empty installation shows an actionable empty state", async ({ bm, page }) => {
    await bm.goto("/", "empty");
    await expect(page.getByText("No backup sets yet")).toBeVisible();
    await expect(page.getByText(/Connect Backup Manager to your first server/)).toBeVisible();
    await page.getByRole("button", { name: "Add backup set" }).click();
    await expect(bm.heading("Add backup set")).toBeVisible();
  });

  test("critical storage escalates the headline", async ({ bm, page }) => {
    await bm.goto("/", "storage-critical");
    await expect(page.getByText("BACKUPS FAILING")).toBeVisible();
    await expect(page.getByText(/Storage critical/)).toBeVisible();
  });
});
