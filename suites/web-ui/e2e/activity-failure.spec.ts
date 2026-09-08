import { expect, test } from "./fixtures";

/**
 * rclone-manager#598: the Activity page failing on a real 0.3.2 NAS with
 * "Backup Manager could not complete that request." and, under Advanced
 * details, the literal string "correlation id unavailable".
 *
 * # Why this is a separate file from quarantine-activity.spec.ts
 *
 * That file already has a `test.describe("activity")` block that drives
 * /activity and asserts events render with timestamps, severity glyphs and
 * set names. It runs on every commit, it did not catch this, and it
 * structurally could not have: this whole suite drives `createMockApi`
 * through the Vite dev server, and the mock resolved `listActivity`
 * cleanly every time. Another happy-path spec beside it would be exactly
 * as blind.
 *
 * So these are failure-path cases, and the mock grew one scenario to make
 * them expressible: `activity-unreadable`, whose `listActivity` throws a
 * plain `SyntaxError` rather than a `BackupManagerError`. That is the NAS's
 * shape reproduced exactly. It is the only scenario in the fixture that is
 * a failure rather than a state of the deployment, and only that one call
 * fails, so what is asserted is what the failing panel says rather than
 * whether the page came up at all.
 *
 * # What each case claims
 *
 * Never "the page failed". Always that what reaches an operator names
 * something: the exception's own words are on screen, the words tell a
 * service that did not answer apart from one that answered unreadably, and
 * the string an operator got instead of a diagnostic appears nowhere.
 */

/** The one string the product must never render as a correlation id. It
 *  used to be written down by every caller that had no id to give, which
 *  turned ErrorState's "only disclose when there is an id" check into one
 *  that always passed. */
const NOT_AN_ID = "correlation id unavailable";

test.describe("activity, when the feed cannot be read", () => {
  test.beforeEach(async ({ bm }) => {
    await bm.goto("/activity", "activity-unreadable");
  });

  test("says a failure happened at all, rather than an empty feed", async ({ page }) => {
    // An empty timeline is a claim about the deployment ("nothing has
    // happened here"), and it is not the claim this page is entitled to
    // make when the fetch threw.
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByText("No matching events")).toHaveCount(0);
  });

  test("names what actually failed, in words an operator can act on", async ({ page }) => {
    const alert = page.getByRole("alert");
    // "the service did not answer" and "this build could not read what it
    // answered" are different problems for whoever is fixing them, and
    // they used to render as the same eleven words. This asserts the
    // second one is said, not merely that some sentence is.
    await expect(alert).toContainText(/could not read the answer/i);
  });

  test("puts the exception's own message where it can be read", async ({ page }) => {
    const alert = page.getByRole("alert");
    await alert.getByText("Advanced details").click();
    await expect(alert).toContainText("SyntaxError");
    await expect(alert).toContainText("is not valid JSON");
  });

  test("offers no correlation id, and never the literal one", async ({ page }) => {
    // The positive half first, and it is load-bearing. A build that does
    // not know this scenario at all falls back to "default" and draws a
    // perfectly healthy feed, which contains no correlation id either, so
    // the two absence assertions below would pass against exactly the
    // build this case exists to fail against. Asserting the banner is
    // there first is what stops that.
    await expect(page.getByRole("alert")).toBeVisible();
    // The whole of what the reported NAS gave an operator.
    await expect(page.locator("body")).not.toContainText(NOT_AN_ID);
    await expect(page.locator("body")).not.toContainText("unavailable");
  });

  test("offers a way to get the diagnostic off the screen", async ({ page }) => {
    const alert = page.getByRole("alert");
    await alert.getByText("Advanced details").click();
    // A NAS is served over http:// far more often than https://, and the
    // async clipboard does not exist on an insecure origin. Whether the
    // copy lands is the browser's business; that the control exists and
    // reports which happened is the product's.
    await expect(alert.getByRole("button", { name: /copy details/i })).toBeVisible();
  });

  test("Try again leaves evidence it ran when it fails the same way", async ({ page }) => {
    const alert = page.getByRole("alert");
    await alert.getByRole("button", { name: /try again/i }).click();
    // Against a service that is still down, the banner has to change.
    // Identical words with no sign anything happened is a button people
    // press harder.
    await expect(alert.getByText(/tried again at/i)).toBeVisible();
  });

  test("shows no stack trace and no source path", async ({ page }) => {
    const body = await page.locator("body").innerText();
    // §37. The exception's name and message are a diagnostic; the frames
    // under it are somebody's filesystem.
    expect(body).not.toContain("    at ");
    expect(body).not.toMatch(/\/src\/[A-Za-z]+\.tsx?/);
  });
});

test.describe("the dashboard does not swallow the same failure", () => {
  test("a Recent activity panel that could not load says so", async ({ bm, page }) => {
    await bm.goto("/", "activity-unreadable");
    const panel = page.getByRole("region", { name: "Recent activity" });

    // The quieter half of the same bug, and the surface an operator lands
    // on first: DashboardPage ran the identical call and never read its
    // error, so this drew as an empty list, indistinguishable from a NAS
    // where nothing has ever happened.
    await expect(panel.getByRole("alert")).toBeVisible();
    await expect(panel).toContainText("SyntaxError");
    await expect(panel).not.toContainText("unavailable");
  });

  test("a Recent activity panel with nothing in it draws no alert", async ({ bm, page }) => {
    // The positive control for the case above. Without it, a panel that
    // shouted on every render would pass it.
    await bm.goto("/", "empty");
    const panel = page.getByRole("region", { name: "Recent activity" });
    await expect(panel.getByRole("alert")).toHaveCount(0);
  });
});

test.describe("activity, when the feed reads fine", () => {
  test("still lists the recorded events", async ({ bm, page }) => {
    // The regression guard for the root-cause half: everything above is
    // about how a failure is reported, and none of it is worth anything if
    // the working path stopped working.
    await bm.goto("/activity");
    await expect(page.getByRole("listitem").first()).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});
