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

    await expect(page.getByRole("img", { name: "Backup Manager" })).toBeVisible();
    // Scoped to the header rather than `.first()`, because this case is
    // about the LOCKUP. Against a real deployment the product name is on
    // the page twice (the header, and the footer's "Backup Manager
    // running on ..."), which resolved two elements and failed strict
    // mode on the first real run; the mock's page had fewer of them.
    // `.first()` would have made it pass by picking whichever came first
    // in the DOM, which is not the same claim.
    await expect(page.getByRole("banner").getByText("rclone-manager")).toBeVisible();
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
    // is nothing. My first version of this asserted a digit on all three
    // and said a zero would be the true reading; the first real run said
    // otherwise, with the Quarantine link reading exactly "Quarantine" on
    // a deployment with an empty queue.
    //
    // The product is right and the old case could not have noticed either
    // way: the mock's fixture had a non-zero count on all three, forever,
    // so "shows counts" was satisfied by a badge that might have been
    // painted unconditionally. Reading both directions off the service is
    // the claim worth making, and it is only expressible against one.
    const badge = async (label: string, count: number) => {
      const link = bm.nav(label);
      if (count > 0) {
        await expect(link, label + " counts " + count + " and shows no number").toContainText(/\d/);
        await expect(link).toContainText(String(count));
      } else {
        await expect(link, label + " counts nothing and still shows a number").not.toContainText(/\d/);
      }
    };

    await badge("Backup sets", bm.facts.sets.length);
    await badge("Backups", bm.facts.backups.length);
    await badge("Quarantine", bm.facts.quarantined.length);
  });

  test("names the platform it is running on", async ({ bm, page }) => {
    await bm.goto("/");
    // exact: true — the footer line ("Backup Manager running on <platform>")
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
