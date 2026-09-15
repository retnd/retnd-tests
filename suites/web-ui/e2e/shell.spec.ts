import { expect, needs, test } from "./fixtures";

/** The shell, against the real deployment.
 *
 *  Every case here was already about the running app rather than about
 *  data, so all six survive the move unchanged in what they claim. The one
 *  addition is the precondition: the header's service chip and the nav's
 *  counts are drawn from GET /system/health and GET /backup-sets, and on
 *  an instance with no configuration at all every one of those refuses
 *  with NOT_CONFIGURED. That is a real state with its own real screen (the
 *  first-run banner), not a broken one, so this file says it is not the
 *  state it is written for rather than failing in it. */
test.describe("application shell", () => {
  test.beforeEach(async ({ bm }) => {
    needs(bm.facts.configured, "a configured deployment: an instance with no backup set yet has no health to report");
  });

  test("renders the lockup, service chip and every section link", async ({ bm, page }) => {
    await bm.goto("/");

    await expect(page.getByRole("img", { name: "retnd" })).toBeVisible();
    // Scoped to the header rather than `.first()`, because this case is
    // about the LOCKUP. Against a real deployment the product name is on
    // the page twice (the header, and the footer's "retnd
    // running on ..."), which resolved two elements and failed strict
    // mode on the first real run; the mock's page had fewer of them.
    // `.first()` would have made it pass by picking whichever came first
    // in the DOM, which is not the same claim.
    //
    // `exact` is the second half, and backupd#794 is why: the mark's own
    // <title>retnd</title> is text too, and getByText matches
    // case-insensitively on a substring, so after the rename the header
    // held two matches - one of them an SVG title that is never visible.
    // Exact matching is case-sensitive, so it selects the wordmark and
    // not the accessible name beside it.
    await expect(page.getByRole("banner").getByText("retnd", { exact: true })).toBeVisible();
    // Scoped to the header (role "banner") — the dashboard body's own
    // health summary widget repeats "Service running" with a different
    // suffix (uptime, not version), so an unscoped match is ambiguous once
    // the dashboard is actually reachable.
    await expect(page.getByRole("banner").getByText(/Service running/)).toBeVisible();

    for (const label of ["Dashboard", "Backup sets", "Backups", "Activity", "Quarantine", "Settings"]) {
      await expect(bm.nav(label)).toBeVisible();
    }
  });

  test("navigates to every section and marks the active link", async ({ bm, page }) => {
    await bm.goto("/");

    const routes: Array<[string, string | RegExp]> = [
      ["Backup sets", "Backup sets"],
      ["Backups", "Backups"],
      ["Activity", "Activity"],
      ["Quarantine", "Quarantine"],
      ["Settings", "Settings"],
      ["Dashboard", "Dashboard"]
    ];

    for (const [link, heading] of routes) {
      await bm.navigateTo(link);
      await expect(bm.heading(heading)).toBeVisible();
      await expect(bm.nav(link)).toHaveAttribute("aria-current", "page");
    }
  });

  test("shows counts on sets, backups and quarantine", async ({ bm }) => {
    await bm.goto("/");

    // A digit where there is something to count, and NO digit where there
    // is nothing. My first version asserted a digit on all three and said
    // a zero would be the true reading; the first real run said otherwise,
    // with the Quarantine link reading exactly "Quarantine" on a
    // deployment with an empty queue.
    //
    // The mock's fixture had a non-zero count on all three, forever, so
    // "shows counts" was satisfied by a badge that might have been painted
    // unconditionally. Reading both directions off the service is the
    // claim worth making, and it is only expressible against one.
    const badge = async (label: string, count: number) => {
      const link = bm.nav(label);
      if (count > 0) {
        await expect(link, label + " counts " + count + " and shows no number").toContainText(String(count));
      } else {
        await expect(link, label + " counts nothing and still shows a number").not.toContainText(/\d/);
      }
    };

    await badge("Backup sets", bm.facts.sets.length);
    await badge("Quarantine", bm.facts.quarantined.length);

    // And the third one is not what its label suggests, which is worth
    // pinning rather than glossing. The badge beside "Backups" counts
    // backup SETS, not backups: appNodes.ts's countsNode sums the health
    // report's per-set totals, deliberately, because nothing computes a
    // retained-artifact figure server-side and the one the UI used to show
    // came off the dev-server mock (backupd#211).
    //
    // So on this deployment it reads 1 beside a page that lists 3, and
    // that is the product working as decided. My own first version of this
    // case asserted the artifact count and was wrong; the mock could not
    // have told me, because there the two numbers happened to agree.
    await expect(bm.nav("Backups")).toContainText(String(bm.facts.sets.length));
  });

  test("names the platform it is running on", async ({ bm, page }) => {
    await bm.goto("/");
    // exact: true — the footer line ("retnd running on <platform>")
    // otherwise makes this an ambiguous substring match too.
    await expect(page.getByText("Running on", { exact: true })).toBeVisible();
  });

  test("theme toggle flips and survives reload", async ({ bm }) => {
    await bm.goto("/");
    expect(await bm.theme()).toBe("light");

    await bm.toggleTheme();
    expect(await bm.theme()).toBe("dark");

    await bm.page.reload();
    expect(await bm.theme()).toBe("dark");

    await bm.toggleTheme();
    expect(await bm.theme()).toBe("light");
  });

  test("surfaces text on a dark surface with a real foreground colour", async ({ bm }) => {
    await bm.goto("/");
    await bm.toggleTheme();
    const bg = await bm.cssVar("--bg");
    const text = await bm.cssVar("--text");
    expect(bg).not.toBe("");
    expect(text).not.toBe("");
    expect(bg).not.toBe(text);
  });
});
