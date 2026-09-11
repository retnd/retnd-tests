import { freeBytes, withCapacityThresholds } from "../harness/api";
import { expect, needs, test } from "./fixtures";

/**
 * The dashboard, against a real deployment.
 *
 * This is the file the seeding trap bites hardest, so it is worth saying
 * plainly what changed and what did not.
 *
 * `createMockApi` returned one fixed, complete deployment on every call: a
 * dozen backups, a stale set, a set halted on a changed host key, a
 * transfer mid-flight, a barren cycle that walked twelve backups and got
 * none of them through. Every number on this page had a fixture behind it,
 * so a case could assert on the number itself. A real deployment starts
 * with none of that and gains each piece only when something actually
 * happens, so an assertion on `12` is an assertion about a fixture that no
 * longer exists.
 *
 * Each case below therefore does one of three things, and says which:
 *
 *  - asserts on SHAPE where the shape was always the real claim (a
 *    freshness figure is "an age or never", not a number of hours);
 *  - states the precondition it needs and skips when the deployment is not
 *    in it, reading that off the API rather than off a flag;
 *  - ARRANGES the state through the API first. The storage-critical case
 *    is the interesting one: it was a `?scenario=` fixture that could
 *    never have been real, and it is now a threshold written through
 *    PATCH /settings, a verdict the service really computes, and a restore
 *    afterwards.
 *
 * Nothing here was loosened to reach green. Where a number was the point,
 * it is still the point: it is just read off the API in the same run
 * rather than copied out of a fixture.
 */

/** What relativeAge() (ui/shared/src/utilities/format.ts) can print. The
 *  ages are computed from Date.now(), so the shape is the stable thing to
 *  assert, not a number. "never" was always in this list, and on a real
 *  deployment it is the reading a fresh set genuinely has. */
const FRESHNESS = /^(never|just now|\d+ minutes? ago|\d+ hours? ago|\d+ days ago)$/;

test.describe("dashboard", () => {
  test.beforeEach(async ({ bm }) => {
    needs(bm.facts.configured, "a configured deployment: every resource this page reads refuses with NOT_CONFIGURED before the first backup set exists");
  });

  test("states the BACKUP verdict, not the daemon's", async ({ bm, page }) => {
    await bm.goto("/");
    // §8 — the headline is about backups; the daemon is a supporting chip.
    await expect(page.getByText(/^BACKUPS /)).toBeVisible();
    // Scoped to the header — the dashboard body's own health summary widget
    // repeats "Service running" with a different suffix (uptime, not
    // version), so an unscoped match is ambiguous.
    await expect(page.getByRole("banner").getByText(/Service running/)).toBeVisible();
    // The sentence under the verdict, whichever verdict this deployment
    // is on. The three alternatives here were the mock's, and its fixture
    // was never healthy, so the healthy sentence had never been seen by
    // this suite at all: the first real run found it saying "a known-good
    // backup exists within the stale threshold and nothing needs
    // attention" and read that as a missing subhead.
    //
    // What §8 is about survives whichever one renders: the line under
    // BACKUPS talks about BACKUPS, not about the process being up.
    await expect(
      page
        .getByText(
          /a healthy daemon is not a healthy backup|not produced a verified backup|halted|known-good backup exists/i
        )
        .first()
    ).toBeVisible();
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

    // "Retained artifacts" and "Success rate · 7d" used to sit in this
    // same list. #211 removed both: no endpoint has ever computed either,
    // so against a real deployment they each rendered a confident zero.
    // "Free space" is the honest figure that took their place here, and it
    // comes off the health report. Deliberate removal, recorded so a later
    // reader does not read the shorter list as an assertion someone
    // deleted: the retained-artifact count and the seven-day success rate
    // have NO replacement, in this list or anywhere else.
    //
    // Worth noting where this stands now: #211's whole argument was that
    // those two figures were fixture-only and would render nonsense
    // against a real service. This run is that real service, so the
    // negative below has stopped being a prediction.
    await expect(figure("Free space")).toHaveText(/^[\d.]+ (B|KB|MB|GB|TB|PB)$/);
    await expect(summary.getByText(/Success rate|Retained artifacts/)).toHaveCount(0);
    // Control for that zero: the same query shape, on a label that is
    // there, finds it. Without this, a typo would also read as "absent".
    await expect(summary.getByText(/Oldest set freshness/)).toHaveCount(1);
  });

  test("surfaces the host-key change above the metrics", async ({ bm, page }) => {
    needs(
      bm.facts.sets.some((s) => s.halt_reason === "HOST_KEY_CHANGED"),
      "a backup set halted on a changed host key. The mock manufactured one; a real deployment " +
        "reaches this only when the source machine's key really rotates under it, which the " +
        "topology can arrange by regenerating the sshd host key between two runs"
    );
    await bm.goto("/");
    const alert = page.getByRole("alert").filter({ hasText: /host key/i });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/Security warning/i);
    await expect(alert).toContainText(/No remote artifacts will be deleted/i);
  });

  test("host-key alert links through to the halted set", async ({ bm, page }) => {
    needs(
      bm.facts.sets.some((s) => s.halt_reason === "HOST_KEY_CHANGED"),
      "a backup set halted on a changed host key (see the case above)"
    );
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
    await expect(metrics).toContainText(/Backup sets\s*\d+\s*\d+ stale · \d+ failing/);
    // This card was "Success rate · 7d" until #214. The success rate had
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
    await expect(metrics).toContainText(new RegExp("used · " + used + "%"));
  });

  test("the backup-set count on the page is the one the service reports", async ({ bm, page }) => {
    // New, and only expressible now. Against the mock the page and the
    // "API" were the same in-memory object, so a card agreeing with a
    // fixture proved nothing about a service. Here the count is read from
    // GET /system/health and then read again off the rendered card, and
    // the claim is that the two agree.
    await bm.goto("/");
    const metrics = page.getByRole("region", { name: "Key metrics" });
    // Anchored on the detail line that follows, not on whitespace after
    // the number. A MetricCard renders label, value and detail line with
    // NOTHING between them, so on this deployment the card's text is
    // literally "Backup sets10 stale · 0 failing": one set, then a
    // detail line starting with a zero. A `\s` after the count matches
    // nothing, and worse, a bare `1` would have matched the wrong digit.
    await expect(metrics).toContainText(
      new RegExp("Backup sets\\s*" + bm.facts.sets.length + "\\s*\\d+ stale")
    );
  });

  test("renders an active transfer with staged progress", async ({ bm, page }) => {
    needs(
      bm.facts.runningOperations > 0,
      "an operation running right now. The mock held one mid-transfer permanently; on a real " +
        "deployment this is a window of seconds while a cycle runs, so it needs the topology to " +
        "start a cycle and hold the assertion inside it"
    );
    await bm.goto("/");
    const ops = page.getByRole("region", { name: "Active operations" });
    await expect(ops).toBeVisible();

    const bar = ops.getByRole("progressbar").first();
    await expect(bar).toBeVisible();
    const value = Number(await bar.getAttribute("aria-valuenow"));
    expect(value).toBeGreaterThanOrEqual(0);
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
    // The step marker is on the list item itself, not on something inside
    // it, which is what makes it reachable to a screen reader walking the
    // list. Kept exactly as it was: it is a structural claim about the
    // markup and has nothing to do with which data is behind it.
    await expect(ops.getByRole("listitem").filter({ has: page.locator("[aria-current='step']") })).toHaveCount(0);
  });

  test("marks the current transfer stage exactly once", async ({ bm, page }) => {
    needs(bm.facts.runningOperations > 0, "an operation running right now (see the case above)");
    await bm.goto("/");
    const current = page.getByRole("region", { name: "Active operations" }).locator("li[aria-current='step']");
    // The stage it is on is whichever one a real cycle happens to be in,
    // which is why the old assertion on "Transferring" specifically is
    // gone: that was the mock holding one operation at one stage forever.
    // Exactly one marked stage is the claim that was always worth making.
    await expect(current).toHaveCount(1);
  });

  test("labels a read-only pass as non-destructive", async ({ bm, page }) => {
    needs(
      bm.facts.runningOperations > 0,
      "an operation running right now: this label belongs to the active-operations panel"
    );
    await bm.goto("/");
    await expect(page.getByText(/Read-only pass .* no artifacts are deleted/)).toBeVisible();
  });

  test("explains remote deletion ordering under the transfer", async ({ bm, page }) => {
    needs(
      bm.facts.runningOperations > 0,
      "an operation running right now: this sentence sits under the active transfer"
    );
    await bm.goto("/");
    await expect(
      page.getByText(/removed only after the NAS copy is verified and durably committed/)
    ).toBeVisible();
  });

  test("lists recent activity and links to the full timeline", async ({ bm, page }) => {
    needs(
      bm.facts.activityEvents > 0,
      "at least one recorded activity event, which a deployment gets by running a backup"
    );
    await bm.goto("/");
    const recent = page.getByRole("region", { name: "Recent activity" });
    await expect(recent.getByRole("listitem").first()).toBeVisible();
    await recent.getByRole("button", { name: "View all" }).click();
    await expect(bm.heading("Activity")).toBeVisible();
  });

  test("a critical storage verdict is computed, shown, and kept out of the headline", async ({ bm, page }) => {
    // This was `?scenario=storage-critical` and it asserted "BACKUPS
    // FAILING". Both halves turned out to be wrong, and the first real
    // run is what showed it.
    //
    // The scenario was a fixture that could never have been real. The
    // arrange step below is: the deployment is told its critical
    // threshold is more free space than the disk has, the service
    // computes CRITICAL from that exactly as it would on a full NAS, and
    // the threshold goes back however this ends.
    //
    // The assertion was wrong about the product, and in a way that
    // contradicted the very section it cites. §8 is that "APPLICATION
    // RUNNING" and "BACKUPS HEALTHY" are two different facts, and
    // HealthSummary builds the headline from `health.backupHealth`
    // alone, with storage as a separate chip beside it. A full disk is
    // not a statement about whether the backups this NAS holds are good,
    // and the mock escalating the headline for one was the fixture
    // disagreeing with the product's own rule.
    //
    // So the case now asserts what §8 actually asks for, which is
    // stronger and only expressible here: the verdict is real, it is on
    // screen, and it did NOT hijack the headline.
    const free = await freeBytes(bm.api);
    needs(
      free !== null,
      "a deployment that can measure its own free space; GET /system/storage reported it unknown"
    );

    await bm.goto("/");
    const summary = page.getByRole("region", { name: "Backup health" });
    const headlineBefore = await summary.getByText(/^BACKUPS /).innerText();

    await withCapacityThresholds(
      bm.api,
      // A threshold above what is free, so the reading crosses the line.
      {
        critical_free_bytes: (free ?? 0) + 1024 * 1024 * 1024,
        warning_free_bytes: (free ?? 0) + 2 * 1024 * 1024 * 1024
      },
      async () => {
        await bm.goto("/");
        // The service really computed it, and the page really says so.
        await expect(summary.getByText(/Storage critical/)).toBeVisible();
        // And §8's rule holds under exactly the pressure that would break
        // it: the backups on this NAS are as good as they were a moment
        // ago, so the verdict about them has not moved.
        await expect(summary.getByText(/^BACKUPS /)).toHaveText(headlineBefore);
      }
    );

    // And the chip comes down when the threshold does, which is the
    // control: without it, a page that said "Storage critical"
    // permanently would satisfy the assertion above.
    await bm.goto("/");
    await expect(summary.getByText(/Storage critical/)).toHaveCount(0);
  });
});

test.describe("a deployment with nothing configured yet", () => {
  // What `?scenario=empty` used to stand in for, and the one place the
  // substitution was closest to honest: a fresh install really does look
  // like this. The difference is that this is now the deployment's actual
  // state rather than a query parameter, so the case runs on a fresh
  // container and states why it is skipped on a seeded one.
  test.beforeEach(async ({ bm }) => {
    needs(
      bm.facts.sets.length === 0,
      "a deployment with no backup sets. This is the fresh-install state, and it is the one " +
        "scenario the mock had that a real container is genuinely in before anything is configured"
    );
  });

  test("shows an actionable empty state", async ({ bm, page }) => {
    await bm.goto("/");
    await expect(page.getByText("No backup sets yet")).toBeVisible();
    await expect(page.getByText(/Connect Backupd to your first server/)).toBeVisible();
    await page.getByRole("button", { name: "Add backup set" }).click();
    await expect(bm.heading("Add backup set")).toBeVisible();
  });

  test("shows no last-run-cycle panel at all", async ({ bm, page }) => {
    await bm.goto("/");
    // Absent, not a pair of zeroes. "Nothing got through" is the loudest
    // thing that panel can say, and saying it about an instance that has
    // never run would raise an alarm about a deployment that is fine.
    await expect(page.getByRole("region", { name: "Last run cycle" })).toHaveCount(0);
    // The positive control: the page rendered, so the absence above is
    // the absence of the panel rather than of the dashboard.
    await expect(page.getByText("No backup sets yet")).toBeVisible();
  });
});

/**
 * backupd#240: what the last finished run cycle actually got done.
 *
 * backupd#361 was a cycle that backed nothing up and told its cron
 * job it had succeeded. #368 recorded the two counts that tell a barren
 * cycle from a good one, and nothing rendered them, so the same
 * indistinguishability survived on this page.
 *
 * The old cases pinned the mock's own numbers, twelve walked and none
 * through, and its "Nothing got through" badge. A real cycle's numbers are
 * whatever it found, so what is asserted now is that the page renders THE
 * SERVICE'S numbers: they are read off GET /operations in the same run and
 * compared. That is a stronger claim than the fixture version ever made,
 * because the fixture could not disagree with itself.
 */
test.describe("the last run cycle", () => {
  test.beforeEach(async ({ bm }) => {
    needs(
      bm.facts.lastCycle !== null,
      "a finished run cycle. DashboardPage draws this panel from the newest operation carrying a " +
        "cycle outcome, so a deployment that has never run one has no panel rather than a panel of zeroes"
    );
  });

  test("says how many backups it walked and how many got through", async ({ bm, page }) => {
    await bm.goto("/");

    const panel = page.getByRole("region", { name: "Last run cycle" });
    await expect(panel).toBeVisible();
    // The two counts, each labelled. `exact` because "got through" is
    // also inside the badge below, and a loose matcher would resolve to
    // both and prove neither.
    await expect(panel.getByText("walked", { exact: true })).toBeVisible();
    await expect(panel.getByText("got through", { exact: true })).toBeVisible();

    // And the numbers are the service's, not the page's own idea of them.
    const cycle = bm.facts.lastCycle!;
    await expect(panel).toContainText(String(cycle.artifacts_walked));
    await expect(panel).toContainText(String(cycle.artifacts_through));

    // The reading the panel exists for, asserted against whichever
    // outcome this deployment really had rather than against the mock's
    // permanently barren one.
    if (cycle.artifacts_walked > 0 && cycle.artifacts_through === 0) {
      await expect(panel.getByText("Nothing got through")).toBeVisible();
      await expect(panel.getByText(/none of them ended it with their bytes on durable storage/i)).toBeVisible();
    } else {
      await expect(panel.getByText("Nothing got through")).toHaveCount(0);
    }
  });

  test("puts no percentage or rate on it", async ({ bm, page }) => {
    await bm.goto("/");

    // A cycle discovers what it will find as it goes, so there is no
    // honest denominator for the whole until it ends. backupd#211
    // removed nine invented figures from this UI; a success rate here
    // would be the tenth.
    const words = await page.getByRole("region", { name: "Last run cycle" }).innerText();
    expect(words).not.toMatch(/\d+\s*%/);
    expect(words).not.toMatch(/per\s+(second|minute|hour)/i);
  });
});
