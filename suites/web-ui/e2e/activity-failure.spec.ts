import type { Page } from "@playwright/test";

import { expect, needs, test } from "./fixtures";

/**
 * backupd#598: the Activity page failing on a real 0.3.2 NAS with
 * "Backupd could not complete that request." and, under Advanced
 * details, the literal string "correlation id unavailable".
 *
 * # This file is the reason the suite moved, and it is the file that
 * # changed least
 *
 * The old header here said, correctly, that `quarantine-activity.spec.ts`
 * "runs on every commit, it did not catch this, and it structurally could
 * not have: this whole suite drives `createMockApi` through the Vite dev
 * server". That is no longer true of the suite, and the interesting part
 * is that it barely changes this file.
 *
 * The failure cases below never depended on mock DATA. They depended on
 * one call FAILING in a particular way, and they reached that by adding a
 * scenario to the mock. Against a real deployment the same shape is
 * reached by intercepting the response with `page.route`, which is a
 * legitimate thing to do against a real backend and a different thing from
 * asking a mock for a fixture: the app, the bundle, the router, the error
 * boundary and the panel are all the real ones, and only the bytes on the
 * wire are substituted. That is exactly the substitution #598 was about,
 * since the NAS really did answer 200 with something the build could not
 * read.
 *
 * So `?scenario=activity-unreadable` becomes a route interception, one
 * that answers the real endpoint with the real symptom: a 200, the right
 * content type, and a body that is not the JSON the build expects.
 *
 * # The success case is the one that got stronger
 *
 * "activity, when the feed reads fine, still lists the recorded events"
 * used to pass against the mock and was named in the brief as the case
 * that proved nothing. It now reads the real feed from a real SQLite
 * catalogue, and it says so, which means it can finally fail the way the
 * NAS failed.
 *
 * # What each failure case claims
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

/** The reported NAS's shape, reproduced on the wire.
 *
 *  A 200 with `application/json` and a body that is not JSON. The client
 *  (ui/shared/src/api/client.ts) calls `response.json()` on it and gets a
 *  plain `SyntaxError`, not a `BackupdError`, which is the whole
 *  root cause: nothing typed it, so every surface running that call said
 *  one fixed sentence and quoted a correlation id that appears in no log.
 *
 *  Deliberately NOT a 500. A refusal the client understands would be
 *  handled by the code path that already worked, and the bug was in the
 *  other one. */
async function serveUnreadableActivity(page: Page) {
  await page.route("**/api/v1/activity*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      // What a truncating proxy, a captive portal or an HTML error page
      // in front of the service all look like from the browser's side.
      body: "<!doctype html><html><body>not the JSON this build expected</body></html>"
    });
  });
}

test.describe("activity, when the feed cannot be read", () => {
  test.beforeEach(async ({ bm, page }) => {
    // The interception goes on BEFORE the navigation, because the page
    // fires this fetch as it mounts. Everything else about the app is the
    // real deployment: the bundle came off `serve-ui`, the session is a
    // real one, and every other call on this page reaches SQLite.
    await serveUnreadableActivity(page);
    await bm.goto("/activity");
  });

  test("says a failure happened at all, rather than an empty feed", async ({ page }) => {
    // An empty timeline is a claim about the deployment ("nothing has
    // happened here"), and it is not the claim this page is entitled to
    // make when the fetch threw. Sharper against a real backend than it
    // ever was against the mock: an empty feed is now a state this
    // deployment can genuinely be in, so the two really are confusable.
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
    await expect(alert).toContainText(/is not valid JSON|Unexpected token/);
  });

  test("offers no correlation id, and never the literal one", async ({ page }) => {
    // The positive half first, and it is load-bearing. A build that
    // handled this cleanly would draw a perfectly healthy-looking failed
    // state which contains no correlation id either, so the two absence
    // assertions below would pass against exactly the build this case
    // exists to fail against. Asserting the banner is there first is what
    // stops that.
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
    // reports which happened is the product's. This deployment is served
    // over http, so that is not hypothetical here.
    await expect(alert.getByRole("button", { name: /copy details/i })).toBeVisible();
  });

  test("Try again leaves evidence it ran when it fails the same way", async ({ page }) => {
    const alert = page.getByRole("alert");
    await alert.getByRole("button", { name: /try again/i }).click();
    // Against a service that is still down, the banner has to change.
    // Identical words with no sign anything happened is a button people
    // press harder. The interception is still installed, so the retry
    // really does go out and really does fail again.
    await expect(alert.getByText(/tried again at/i)).toBeVisible();
  });

  test("shows no stack trace and no source path", async ({ page }) => {
    const body = await page.locator("body").innerText();
    // §37. The exception's name and message are a diagnostic; the frames
    // under it are somebody's filesystem.
    expect(body).not.toContain("    at ");
    expect(body).not.toMatch(/\/src\/[A-Za-z]+\.tsx?/);
  });

  test("recovers when the service starts answering properly again", async ({ page, bm }) => {
    // New here, and the case that keeps every one above honest. All seven
    // assert on a failure banner; a build that rendered that banner
    // permanently would satisfy all seven. This takes the interception
    // away and requires the page to come back, which is what an operator
    // who fixed the proxy in front of their NAS actually experiences.
    needs(
      bm.facts.activityEvents > 0,
      "at least one recorded activity event, so the recovered page has something to draw"
    );
    await page.unroute("**/api/v1/activity*");
    await page.getByRole("alert").getByRole("button", { name: /try again/i }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("listitem").first()).toBeVisible();
  });
});

test.describe("the dashboard does not swallow the same failure", () => {
  test("a Recent activity panel that could not load says so", async ({ bm, page }) => {
    needs(bm.facts.configured, "a configured deployment, so the dashboard renders its panels at all");
    await serveUnreadableActivity(page);
    await bm.goto("/");
    const panel = page.getByRole("region", { name: "Recent activity" });

    // The quieter half of the same bug, and the surface an operator lands
    // on first: DashboardPage ran the identical call and never read its
    // error, so this drew as an empty list, indistinguishable from a NAS
    // where nothing has ever happened.
    await expect(panel.getByRole("alert")).toBeVisible();
    await expect(panel).toContainText("SyntaxError");
    await expect(panel).not.toContainText("unavailable");
  });

  test("a Recent activity panel with a healthy feed draws no alert", async ({ bm, page }) => {
    // The positive control for the case above. Without it, a panel that
    // shouted on every render would pass it.
    //
    // This was `?scenario=empty`, and it did not need to be: what it
    // needs is a feed that reads fine, which is the deployment's ordinary
    // state whether the feed is empty or full. So it is now the real
    // feed, with no interception at all, which also makes it a claim
    // about the real path rather than about a fixture.
    needs(bm.facts.configured, "a configured deployment, so the dashboard renders its panels at all");
    await bm.goto("/");
    const panel = page.getByRole("region", { name: "Recent activity" });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("alert")).toHaveCount(0);
  });
});

test.describe("activity, when the feed reads fine", () => {
  test("still lists the recorded events", async ({ bm, page }) => {
    // The regression guard for the root-cause half: everything above is
    // about how a failure is reported, and none of it is worth anything if
    // the working path stopped working.
    //
    // This is the case the brief named. It used to pass against the mock,
    // which resolved `listActivity` cleanly every time, so it could not
    // have caught #598 and could not catch its recurrence. It now reads
    // the deployment's own catalogue over the real transport, which is
    // where a 200-carrying-the-wrong-bytes actually happens.
    needs(
      bm.facts.activityEvents > 0,
      "at least one recorded activity event. A fresh deployment has none until a backup runs, and " +
        "an empty feed cannot tell a working read from a failed one, which is this case's whole subject"
    );
    await bm.goto("/activity");
    await expect(page.getByRole("listitem").first()).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    // A timestamp on the first row, which is the cheapest proof that what
    // rendered is an event rather than an empty-state line that happens to
    // be a list item.
    await expect(page.getByRole("listitem").first()).toContainText(/\d{2}:\d{2}:\d{2}/);
  });
});

/** backupd#795: the other half of the distinction this file's header
 *  promises - "a service that did not answer" as against "one that
 *  answered unreadably".
 *
 *  On the reported UGREEN NAS the web-ui reverse proxy
 *  (`backupd-web serve-ui`) could not reach the engine at all
 *  (`dial tcp: lookup rclone-manager on 127.0.0.11:53: no such host`), and
 *  the Activity page showed the operator nothing. A read that never gets
 *  an answer is a different problem from one whose answer will not parse,
 *  and it must not be reported in the other one's words.
 *
 *  `route.abort("failed")` is what an unreachable service looks like from
 *  inside the page: the fetch rejects with a TypeError, which is exactly
 *  what the client's `no-response` failure is made of.
 *
 *  # What this cannot claim, and where that claim lives
 *
 *  The abort happens in the browser, so serve-ui is never involved: this
 *  case cannot fail on what a real proxy answers when its upstream is
 *  gone, nor on whether that answer carries the correlation id its own log
 *  line quotes. `engine-unreachable.spec.ts` stops the engine CONTAINER
 *  and asserts exactly that, and it runs only under the rig's
 *  `--break-engine`. This one runs on every Suite B run, which is the
 *  point of keeping both: the cheap guard is always on, and the expensive
 *  one is the one that can fail on the deployment. */
async function serveUnreachableEngine(page: Page) {
  await page.route("**/api/v1/activity*", (route) => route.abort("failed"));
}

test.describe("activity, when nothing answers at all", () => {
  test.beforeEach(async ({ bm, page }) => {
    await serveUnreachableEngine(page);
    await bm.goto("/activity");
  });

  test("says a failure happened at all, rather than an empty feed", async ({ page }) => {
    // A blank timeline reads as "nothing has happened on this NAS", which
    // is the exact wrong claim when the request never reached anything -
    // and the whole of what #795 gave its operator.
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByText("No matching events")).toHaveCount(0);
  });

  test("names a service that did not answer, not one that answered unreadably", async ({ page }) => {
    const alert = page.getByRole("alert");
    // The two failures send whoever is fixing them to different machines.
    // Borrowing the 200-unreadable wording here sends them to read the
    // build's parser when the service is down.
    await expect(alert).toContainText(/did not answer|could not reach|unreachable|no response/i);
    await expect(alert).not.toContainText(/could not read the answer/i);
  });

  test("offers no correlation id, and never the literal one", async ({ page }) => {
    // Nothing answered, so there is no id to quote, and the honest
    // rendering of "no id" is silence. The banner is asserted first for
    // the same reason as in the unreadable case: a build that drew no
    // banner at all would satisfy both absences.
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(NOT_AN_ID);
    await expect(page.locator("body")).not.toContainText("unavailable");
  });

  test("shows no stack trace and no source path", async ({ page }) => {
    const body = await page.locator("body").innerText();
    // §37, and worth repeating for this path specifically: the object
    // thrown here is the browser's own TypeError rather than the client's
    // typed failure, so it arrives with a different stack to leak.
    expect(body).not.toContain("    at ");
    expect(body).not.toMatch(/\/src\/[A-Za-z]+\.tsx?/);
  });

  test("Try again re-issues the read and leaves evidence it ran", async ({ page }) => {
    const alert = page.getByRole("alert");
    await alert.getByRole("button", { name: /try again/i }).click();
    // The interception is still installed, so the retry really goes out
    // and really fails again; the banner has to change, or it is a button
    // people press harder at an unchanged screen.
    await expect(alert.getByText(/tried again at/i)).toBeVisible();
  });

  test("recovers when the service becomes reachable again", async ({ page, bm }) => {
    // Keeps the five above honest: a build that drew the banner
    // permanently would satisfy every one of them.
    needs(
      bm.facts.activityEvents > 0,
      "at least one recorded activity event, so the recovered page has something to draw"
    );
    await page.unroute("**/api/v1/activity*");
    await page.getByRole("alert").getByRole("button", { name: /try again/i }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("listitem").first()).toBeVisible();
  });
});
