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
    await expect(page.getByText("rclone-manager")).toBeVisible();
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
    // Any digit, including a zero, which is what makes this survive a
    // deployment with an empty quarantine queue. A zero here is the true
    // reading rather than a placeholder: the mock's fixed fixture was the
    // only reason this ever saw a number above one.
    await expect(bm.nav("Backup sets")).toContainText(/\d/);
    await expect(bm.nav("Backups")).toContainText(/\d/);
    await expect(bm.nav("Quarantine")).toContainText(/\d/);
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
